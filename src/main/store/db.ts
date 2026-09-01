// SQLite 初始化与迁移（见《技术框架与规范》§9.2）
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { migrateDatabase } from './db-migrations'

let db: Database.Database | null = null

export function getDataDir(): string {
  // CLI/MCP 进程没有 Electron app；显式环境变量优先，保证它们与桌面端可以访问
  // 同一数据根目录，同时避免在 Node 下调用 app.getPath() 崩溃。
  const configured = process.env.CANVAS_DATA_DIR
  const userData = configured
    ? configured
    : app && typeof app.getPath === 'function'
      ? app.getPath('userData')
      : join(process.env.APPDATA || process.cwd(), 'canvas-studio')
  const dir = configured ? userData : join(userData, 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getProjectsDir(): string {
  const dir = join(getDataDir(), 'projects')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDb(): Database.Database {
  if (db) return db
  db = new Database(join(getDataDir(), 'app.db'))
  db.pragma('journal_mode = WAL')
  migrateDatabase(db)
  return db
}

/** 应用退出时关闭数据库连接，释放 WAL 文件锁 */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}
