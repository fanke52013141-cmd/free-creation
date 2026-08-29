import { describe, expect, it } from 'vitest'
import {
  DB_SCHEMA_VERSION,
  migrateDatabase,
  type MigrationDatabase
} from '../src/main/store/db-migrations'

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
    expect(state.execs).toHaveLength(DB_SCHEMA_VERSION)
    expect(state.pragmas).toEqual(['user_version = 1', 'user_version = 2'])
  })

  it('runs only the missing migration for an existing v1 database', () => {
    const state = fakeDatabase(1)
    migrateDatabase(state.db)
    expect(state.execs).toHaveLength(1)
    expect(state.execs[0]).toContain('history_snapshots')
    expect(state.pragmas).toEqual(['user_version = 2'])
  })

  it('refuses a database newer than this application instead of guessing a downgrade', () => {
    const state = fakeDatabase(DB_SCHEMA_VERSION + 1)
    expect(() => migrateDatabase(state.db)).toThrow('高于当前应用支持')
  })
})
