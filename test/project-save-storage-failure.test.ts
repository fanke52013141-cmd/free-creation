import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateDatabase } from '../src/main/store/db-migrations'

const state = vi.hoisted(() => ({
  root: '',
  path: '',
  fault: '',
  flushed: false,
  flushFd: -1,
  flushClosed: false,
  db: null as unknown as Database.Database
}))
vi.mock('../src/main/store/db', () => ({
  getDb: () => state.db,
  getDataDir: () => state.root,
  getProjectsDir: () => join(state.root, 'projects')
}))
vi.mock('fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      state.flushFd = fd
      if (state.fault === 'flush-tmp')
        throw Object.assign(new Error('private-flush-failure'), { code: 'EIO' })
      fs.fsyncSync(fd)
      state.flushed = true
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd)
      if (fd === state.flushFd) state.flushClosed = true
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (state.fault === 'write-tmp' && String(args[0]) === state.path + '.tmp') {
        fs.writeFileSync(args[0], 'partial-private-snapshot')
        throw Object.assign(new Error('private-storage-failure'), { code: 'ENOSPC' })
      }
      return fs.writeFileSync(...args)
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (
        state.fault === 'require-flush' &&
        String(to) === state.path + '.bak' &&
        (!state.flushed || !state.flushClosed)
      )
        throw new Error('SNAPSHOT_NOT_FLUSHED')
      if (state.fault === 'rotate-bak' && String(to) === state.path + '.bak') {
        throw Object.assign(new Error('private-rotation-failure'), { code: 'EACCES' })
      }
      if (state.fault === 'rollback' && String(from) === state.path) {
        throw Object.assign(new Error('private-rollback-failure'), { code: 'EIO' })
      }
      if (state.fault === 'promote-tmp' && String(from) === state.path + '.tmp') {
        throw Object.assign(new Error('private-storage-failure'), { code: 'EIO' })
      }
      return fs.renameSync(from, to)
    }
  }
})
import {
  createProject,
  openProject,
  saveProject,
  saveWorkspaceProfile
} from '../src/main/store/projects.repo'
import { ProjectSaveStorageError } from '../src/main/store/project-save-error'

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'canvas-storage-failure-'))
  state.db = new Database(':memory:')
  migrateDatabase(state.db)
  state.fault = ''
  state.flushed = false
  state.flushFd = -1
  state.flushClosed = false
})
afterEach(() => {
  state.fault = ''
  vi.restoreAllMocks()
  state.db.close()
  if (
    resolve(state.root, '..') !== resolve(tmpdir()) ||
    !basename(state.root).startsWith('canvas-storage-failure-')
  ) {
    throw new Error('STORAGE_TEST_CLEANUP_REJECTED')
  }
  rmSync(state.root, { recursive: true, force: true })
})

describe('R09 last verified project snapshot under repeated storage failures', () => {
  it('flushes and closes the complete pending snapshot before replacing a healthy main', () => {
    const project = createProject('隔离刷盘顺序')
    state.path = join(state.root, 'projects', project.id, 'project.json')
    state.fault = 'require-flush'
    saveProject({ id: project.id, expectedGraphVersion: 0, tldrawSnapshot: { edit: 'flushed' } })
    expect(state.flushed).toBe(true)
    expect(state.flushClosed).toBe(true)
    expect(openProject(project.id)?.meta.graphVersion).toBe(1)
  })
  it('keeps the complete promoted file if the backup vanishes before database rollback', () => {
    const project = createProject('隔离二次故障')
    saveProject({ id: project.id, tldrawSnapshot: { edit: 'baseline' } })
    const path = join(state.root, 'projects', project.id, 'project.json')
    const prepare = state.db.prepare.bind(state.db)
    vi.spyOn(state.db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('UPDATE projects SET updated_at')) {
        rmSync(path + '.bak')
        throw Object.assign(new Error('private-sqlite-full'), { code: 'SQLITE_FULL' })
      }
      return prepare(sql)
    })
    let failure: unknown
    try {
      saveProject({
        id: project.id,
        expectedGraphVersion: 1,
        tldrawSnapshot: { edit: 'complete-promoted' }
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ phase: 'update-db', rollbackFailed: true })
    expect(JSON.parse(readFileSync(path, 'utf8')).tldrawSnapshot).toEqual({
      edit: 'complete-promoted'
    })
    vi.restoreAllMocks()
    expect(openProject(project.id)?.meta.graphVersion).toBe(2)
    expect(openProject(project.id)?.tldrawSnapshot).toEqual({ edit: 'complete-promoted' })
  })
  it.each(['graph', 'workspace'] as const)(
    'rolls back every %s write phase with a healthy main',
    (kind) => {
      const project = createProject('隔离正常主文件故障')
      saveProject({ id: project.id, tldrawSnapshot: { edit: 'last-verified' } })
      state.path = join(state.root, 'projects', project.id, 'project.json')
      const prepare = state.db.prepare.bind(state.db)
      vi.spyOn(state.db, 'prepare').mockImplementation((sql) => {
        if (state.fault === 'update-db' && sql.startsWith('UPDATE projects SET updated_at'))
          throw Object.assign(new Error('private-database-full'), { code: 'SQLITE_FULL' })
        return prepare(sql)
      })
      for (const phase of ['write-tmp', 'flush-tmp', 'rotate-bak', 'promote-tmp', 'update-db']) {
        state.flushClosed = false
        state.flushFd = -1
        state.flushed = false
        state.fault = phase
        let failure: unknown
        try {
          if (kind === 'graph')
            saveProject({
              id: project.id,
              expectedGraphVersion: 1,
              tldrawSnapshot: { edit: 'not-committed' }
            })
          else
            saveWorkspaceProfile(project.id, {
              schemaVersion: 1,
              presetId: 'custom',
              visibleNodeTypeIds: ['text']
            })
        } catch (error) {
          failure = error
        }
        expect(failure).toMatchObject({
          phase,
          code: 'STORAGE_WRITE_FAILED',
          backupUsed: false,
          rollbackFailed: false
        })
        if (phase === 'flush-tmp') expect(state.flushClosed).toBe(true)
        state.fault = ''
        expect(openProject(project.id)?.tldrawSnapshot).toEqual({ edit: 'last-verified' })
        expect(openProject(project.id)?.meta.graphVersion).toBe(1)
        expect(
          state.db.prepare('SELECT graph_version FROM projects WHERE id=?').get(project.id)
        ).toEqual({ graph_version: 1 })
        expect(state.db.prepare('SELECT count(*) AS n FROM process_locks').get()).toEqual({ n: 0 })
      }
    }
  )
  it.each(['graph', 'workspace'] as const)(
    'REC-04 rolls back %s persistence when SQLite reports read-only',
    (kind) => {
      const project = createProject('隔离只读数据库')
      saveProject({ id: project.id, tldrawSnapshot: { edit: 'last-verified' } })
      state.path = join(state.root, 'projects', project.id, 'project.json')
      const prepare = state.db.prepare.bind(state.db)
      vi.spyOn(state.db, 'prepare').mockImplementation((sql) => {
        if (sql.startsWith('UPDATE projects SET updated_at'))
          throw Object.assign(new Error('private-database-readonly'), { code: 'SQLITE_READONLY' })
        return prepare(sql)
      })

      let failure: unknown
      try {
        if (kind === 'graph')
          saveProject({
            id: project.id,
            expectedGraphVersion: 1,
            tldrawSnapshot: { edit: 'must-not-commit' }
          })
        else
          saveWorkspaceProfile(project.id, {
            schemaVersion: 1,
            presetId: 'custom',
            visibleNodeTypeIds: ['text']
          })
      } catch (error) {
        failure = error
      }

      expect(failure).toMatchObject({
        phase: 'update-db',
        code: 'STORAGE_WRITE_FAILED',
        backupUsed: false,
        rollbackFailed: false
      })
      vi.restoreAllMocks()
      expect(openProject(project.id)?.tldrawSnapshot).toEqual({ edit: 'last-verified' })
      expect(openProject(project.id)?.meta.graphVersion).toBe(1)
      expect(state.db.prepare('SELECT graph_version FROM projects WHERE id=?').get(project.id)).toEqual({
        graph_version: 1
      })
      expect(state.db.prepare('SELECT count(*) AS n FROM process_locks').get()).toEqual({ n: 0 })
    }
  )
  it.each(['null', '{}', '[]', '{"meta":null}', '{"meta":{"graphVersion":-1}}'])(
    'uses the verified backup when the main parses but is not a project: %s',
    (corrupt) => {
      const project = createProject('隔离结构损坏')
      saveProject({ id: project.id, expectedGraphVersion: 0, tldrawSnapshot: { edit: 'verified' } })
      const path = join(state.root, 'projects', project.id, 'project.json')
      copyFileSync(path, path + '.bak')
      writeFileSync(path, corrupt)
      expect(openProject(project.id)?.tldrawSnapshot).toEqual({ edit: 'verified' })
      saveProject({
        id: project.id,
        expectedGraphVersion: 1,
        tldrawSnapshot: { edit: 'continued' }
      })
      expect(openProject(project.id)?.tldrawSnapshot).toEqual({ edit: 'continued' })
      expect(JSON.parse(readFileSync(path + '.bak', 'utf8')).tldrawSnapshot).toEqual({
        edit: 'verified'
      })
    }
  )
  it.each(['graph', 'workspace'] as const)(
    'refuses %s writes when no verified snapshot exists',
    (kind) => {
      const project = createProject('隔离双损坏')
      const path = join(state.root, 'projects', project.id, 'project.json')
      writeFileSync(path, 'private-main-corrupt')
      writeFileSync(path + '.bak', 'private-backup-corrupt')
      let failure: unknown
      try {
        if (kind === 'graph')
          saveProject({ id: project.id, tldrawSnapshot: { edit: 'must-not-replace' } })
        else
          saveWorkspaceProfile(project.id, {
            schemaVersion: 1,
            presetId: 'custom',
            visibleNodeTypeIds: ['text']
          })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(ProjectSaveStorageError)
      expect(failure).toMatchObject({ code: 'STORAGE_WRITE_FAILED', phase: 'read-snapshot' })
      expect(readFileSync(path, 'utf8')).toBe('private-main-corrupt')
      expect(readFileSync(path + '.bak', 'utf8')).toBe('private-backup-corrupt')
      expect(state.db.prepare('SELECT count(*) AS n FROM process_locks').get()).toEqual({ n: 0 })
    }
  )
  it('preserves the verified backup when both database update and rollback fail', () => {
    const project = createProject('隔离回滚失败')
    saveProject({ id: project.id, tldrawSnapshot: { edit: 'verified' } })
    state.path = join(state.root, 'projects', project.id, 'project.json')
    copyFileSync(state.path, state.path + '.bak')
    const verified = readFileSync(state.path + '.bak', 'utf8')
    writeFileSync(state.path, 'private-corrupt-main')
    const prepare = state.db.prepare.bind(state.db)
    vi.spyOn(state.db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('UPDATE projects SET updated_at')) {
        // The promoted file cannot be renamed back either; retain both candidates.
        state.fault = 'rollback'
        throw Object.assign(new Error('private-database-failure'), { code: 'SQLITE_FULL' })
      }
      return prepare(sql)
    })
    let failure: unknown
    try {
      saveProject({
        id: project.id,
        expectedGraphVersion: 1,
        tldrawSnapshot: { edit: 'new-complete-file' }
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ phase: 'update-db', backupUsed: true, rollbackFailed: true })
    expect(readFileSync(state.path + '.bak', 'utf8')).toBe(verified)
    state.fault = ''
    vi.restoreAllMocks()
    // A complete promoted file is an observable fact even if the original caller failed.
    expect(openProject(project.id)?.tldrawSnapshot).toEqual({ edit: 'new-complete-file' })
    expect(openProject(project.id)?.meta.graphVersion).toBe(2)
  })
  it.each(['graph', 'workspace'] as const)(
    'retains the valid backup for %s saves when corrupt main is followed by failed promotion',
    (kind) => {
      const project = createProject('隔离存储测试')
      saveProject({
        id: project.id,
        expectedGraphVersion: 0,
        tldrawSnapshot: { edit: 'last-verified-private-edit' }
      })
      state.path = join(state.root, 'projects', project.id, 'project.json')
      copyFileSync(state.path, state.path + '.bak')
      const verified = readFileSync(state.path + '.bak', 'utf8')
      writeFileSync(state.path, '{corrupt-private-main')
      expect(openProject(project.id)?.tldrawSnapshot).toEqual({
        edit: 'last-verified-private-edit'
      })
      for (const fault of ['write-tmp', 'flush-tmp', 'promote-tmp', 'promote-tmp']) {
        state.fault = fault
        expect(() =>
          kind === 'graph'
            ? saveProject({
                id: project.id,
                expectedGraphVersion: 1,
                tldrawSnapshot: { edit: 'not-committed' }
              })
            : saveWorkspaceProfile(project.id, {
                schemaVersion: 1,
                presetId: 'custom',
                visibleNodeTypeIds: ['text']
              })
        ).toThrow()
        expect(readFileSync(state.path + '.bak', 'utf8')).toBe(verified)
        expect(openProject(project.id)?.tldrawSnapshot).toEqual({
          edit: 'last-verified-private-edit'
        })
        expect(state.db.prepare('SELECT count(*) AS n FROM process_locks').get()).toEqual({ n: 0 })
      }
      state.fault = ''
      saveProject({
        id: project.id,
        expectedGraphVersion: 1,
        tldrawSnapshot: { edit: 'explicit-recovered-edit' }
      })
      expect(openProject(project.id)?.meta.graphVersion).toBe(2)
      expect(openProject(project.id)?.tldrawSnapshot).toEqual({ edit: 'explicit-recovered-edit' })
      expect(readFileSync(state.path + '.bak', 'utf8')).toBe(verified)
    }
  )
})
