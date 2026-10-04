import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  DB_SCHEMA_VERSION,
  migrateDatabase,
  type MigrationDatabase
} from '../src/main/store/db-migrations'

const TRANSACTION_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK'])

/** 事务控制语句不参与迁移内容断言，只单独验证其存在与顺序。 */
function schemaExecs(execs: string[]): string[] {
  return execs.filter((sql) => !TRANSACTION_CONTROL.has(sql.trim()))
}

function fakeDatabase(version: number): {
  db: MigrationDatabase
  execs: string[]
  pragmas: string[]
} {
  const execs: string[] = []
  const pragmas: string[] = []
  return {
    execs,
    pragmas,
    db: {
      exec: (sql) => execs.push(sql),
      pragma: (statement, options) => (options?.simple ? version : pragmas.push(statement))
    }
  }
}

describe('SQLite user_version migrations', () => {
  it('runs every missing version in order and records each completed version', () => {
    const state = fakeDatabase(0)
    expect(migrateDatabase(state.db)).toBe(0)
    expect(schemaExecs(state.execs)).toHaveLength(DB_SCHEMA_VERSION)
    expect(state.pragmas).toEqual(
      Array.from({ length: DB_SCHEMA_VERSION }, (_value, index) => `user_version = ${index + 1}`)
    )
    expect(schemaExecs(state.execs).at(-1)).toContain('CREATE TABLE IF NOT EXISTS artifact_recipes')
  })

  it('每个迁移整体包在单个事务里：迁移语句与 user_version 推进同提交', () => {
    const state = fakeDatabase(0)
    migrateDatabase(state.db)
    // 每个迁移一个 BEGIN...COMMIT 对；COMMIT 紧跟对应 user_version 推进之后。
    expect(state.execs.filter((sql) => sql === 'BEGIN')).toHaveLength(DB_SCHEMA_VERSION)
    expect(state.execs.filter((sql) => sql === 'COMMIT')).toHaveLength(DB_SCHEMA_VERSION)
    expect(state.execs).not.toContain('ROLLBACK')
    const firstCommit = state.execs.indexOf('COMMIT')
    expect(state.pragmas[0]).toBe('user_version = 1')
    expect(firstCommit).toBeGreaterThan(state.execs.indexOf('BEGIN'))
  })

  it('runs only the missing migration for an existing v1 database', () => {
    const state = fakeDatabase(1)
    migrateDatabase(state.db)
    expect(schemaExecs(state.execs)).toHaveLength(DB_SCHEMA_VERSION - 1)
    expect(schemaExecs(state.execs)[0]).toContain('history_snapshots')
    expect(schemaExecs(state.execs)[1]).toContain('runs')
    expect(schemaExecs(state.execs)[2]).toContain('agent_idempotency')
    expect(schemaExecs(state.execs)[3]).toContain('model_connections')
    expect(schemaExecs(state.execs)[4]).toContain('ALTER TABLE media ADD COLUMN name')
    expect(schemaExecs(state.execs)[5]).toContain('CREATE TABLE IF NOT EXISTS library_blobs')
    expect(state.pragmas).toEqual(
      Array.from(
        { length: DB_SCHEMA_VERSION - 1 },
        (_value, index) => `user_version = ${index + 2}`
      )
    )
  })

  it('refuses a database newer than this application instead of guessing a downgrade', () => {
    const state = fakeDatabase(DB_SCHEMA_VERSION + 1)
    expect(() => migrateDatabase(state.db)).toThrow('高于当前应用支持')
  })

  it('迁移中途失败时回滚事务且不推进 user_version，可安全重跑（R-11 故障注入）', () => {
    const pragmas: string[] = []
    const execs: string[] = []
    const db: MigrationDatabase = {
      exec: (sql) => {
        // 注入 M9 建表失败：模拟「建表成功、后续语句失败」的半迁移崩溃场景。
        if (sql.includes('library_folders')) throw new Error('注入迁移故障')
        execs.push(sql)
      },
      pragma: (statement, options) => (options?.simple ? 8 : pragmas.push(statement))
    }
    expect(() => migrateDatabase(db)).toThrow('注入迁移故障')
    expect(execs).toContain('ROLLBACK')
    expect(pragmas).not.toContain('user_version = 9')
  })

  it('真实 SQLite 引擎：迁移完成后 user_version 与库表落在最新版本（R-11）', () => {
    const sqlite = new DatabaseSync(':memory:')
    const adapter: MigrationDatabase = {
      exec: (sql) => sqlite.exec(sql),
      pragma: (statement, options) =>
        options?.simple
          ? Number(
              (sqlite.prepare(`PRAGMA ${statement}`).get() as { user_version: number }).user_version
            )
          : sqlite.exec(`PRAGMA ${statement}`)
    }
    expect(migrateDatabase(adapter)).toBe(0)
    expect(Number(adapter.pragma('user_version', { simple: true }))).toBe(DB_SCHEMA_VERSION)
    const folders = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'library_folders'`)
      .get()
    expect(folders).toBeDefined()
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_recipes'").get()).toBeDefined()
    sqlite.close()
  })

  it('真实 SQLite 引擎：M8 中途失败回滚后无残留表、版本不推进、可重跑自愈（R-11）', () => {
    const sqlite = new DatabaseSync(':memory:')
    const adapter: MigrationDatabase = {
      exec: (sql) => sqlite.exec(sql),
      pragma: (statement, options) =>
        options?.simple
          ? Number(
              (sqlite.prepare(`PRAGMA ${statement}`).get() as { user_version: number }).user_version
            )
          : sqlite.exec(`PRAGMA ${statement}`)
    }
    // M8 自身不依赖早期迁移的表，可直接把版本标到 7 构造 M8 前置状态。
    sqlite.exec('PRAGMA user_version = 7')
    // 破坏 M8：预置同名缺列表，IF NOT EXISTS 跳过建表后建索引因缺列失败——
    // 模拟「迁移中途失败」，同事务内已建的 library_category_versions 必须整体回滚。
    sqlite.exec('CREATE TABLE library_revision_blueprints (revision_id TEXT PRIMARY KEY)')

    expect(() => migrateDatabase(adapter)).toThrow()
    expect(Number(adapter.pragma('user_version', { simple: true }))).toBe(7)
    const residual = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'library_category_versions'`
      )
      .get()
    expect(residual).toBeUndefined()

    // 排除破坏后重跑：M9 的数据拷贝依赖 M7 的集合表，补齐前置后直接补到最新版本，
    // 验证失败不留半迁移状态、可安全重跑（R-11 的核心保证）。
    sqlite.exec('DROP TABLE library_revision_blueprints')
    sqlite.exec(
      'CREATE TABLE library_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)'
    )
    sqlite.exec(
      'CREATE TABLE library_collection_items (collection_id TEXT NOT NULL, resource_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY(collection_id, resource_id))'
    )
    expect(migrateDatabase(adapter)).toBe(7)
    expect(Number(adapter.pragma('user_version', { simple: true }))).toBe(DB_SCHEMA_VERSION)
    sqlite.close()
  })
})
