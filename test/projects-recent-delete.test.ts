import AdmZip from 'adm-zip'
import { exportProject } from '../src/main/store/transfer'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { migrateDatabase } from '../src/main/store/db-migrations'
const state = vi.hoisted(() => ({ root: '', database: null as unknown }))
vi.mock('../src/main/store/db', () => ({
  getDataDir: () => state.root,
  getProjectsDir: () => join(state.root, 'projects'),
  getDb: () => state.database
}))
import {
  cloneProject,
  createProject,
  deleteProject,
  listDeletedProjects,
  listProjects,
  restoreDeletedProject,
  openProject
} from '../src/main/store/projects.repo'
let db: DatabaseSync
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'canvas-undelete-'))
  db = new DatabaseSync(':memory:')
  state.database = {
    prepare: (sql: string) => db.prepare(sql),
    transaction: (fn: () => unknown) => () => {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
  migrateDatabase({
    exec: (sql) => db.exec(sql),
    pragma: (sql, options) =>
      options?.simple
        ? (db.prepare(`PRAGMA ${sql}`).get() as { user_version: number }).user_version
        : db.exec(`PRAGMA ${sql}`)
  })
})
afterEach(() => {
  db.close()
  rmSync(state.root, { recursive: true, force: true })
})
it('delete and restore preserve the exact project file and graph version', () => {
  const p = createProject('原项目')
  const file = join(state.root, 'projects', p.id, 'project.json')
  const original = readFileSync(file, 'utf8')
  expect(deleteProject(p.id)).toBe(true)
  expect(listProjects()).toHaveLength(0)
  expect(listDeletedProjects()[0].id).toBe(p.id)
  expect(openProject(p.id)).toBeNull()
  expect(restoreDeletedProject(p.id)?.graphVersion).toBe(0)
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(openProject(p.id)?.meta.id).toBe(p.id)
  expect(listDeletedProjects()).toHaveLength(0)
})
it('resolves live name collisions and refuses a missing file without changing deletion', () => {
  const p = createProject('same')
  deleteProject(p.id)
  createProject('same')
  expect(restoreDeletedProject(p.id)?.name).toBe('same · 恢复1')
  deleteProject(p.id)
  rmSync(join(state.root, 'projects', p.id, 'project.json'))
  expect(() => restoreDeletedProject(p.id)).toThrow()
  expect(listDeletedProjects()).toHaveLength(1)
  expect(restoreDeletedProject('absent')).toBeNull()
})

it('含下划线的项目克隆/导出只复制本项目文件，不计入邻居素材', () => {
  const id = 'ab_cdefghijk'
  const neighbor = 'abXcdefghijk'
  for (const projectId of [id, neighbor]) {
    const meta = { id: projectId, name: projectId, createdAt: 1, updatedAt: 1, graphVersion: 0 }
    db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,1,1)').run(
      projectId,
      projectId
    )
    const dir = join(state.root, 'projects', projectId, 'media')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'one.png'), 'image')
    writeFileSync(
      join(state.root, 'projects', projectId, 'project.json'),
      JSON.stringify({ version: 1, meta, nodes: [], edges: [], groups: [] })
    )
    db.prepare(
      'INSERT INTO media (id,kind,mime,path,size_bytes,created_at) VALUES (?,?,?,?,5,1)'
    ).run(projectId + '-media', 'image', 'image/png', `projects/${projectId}/media/one.png`)
  }
  const cloned = cloneProject(id, '独立副本')
  const copyRows = db
    .prepare('SELECT path FROM media WHERE substr(path,1,length(?)) = ?')
    .all(`projects/${cloned.id}/media/`, `projects/${cloned.id}/media/`)
  expect(copyRows).toHaveLength(1)
  const exported = exportProject(id, join(state.root, 'safe.canvasbundle'))
  expect(exported.missingMediaCount).toBe(0)
  expect(
    new AdmZip(exported.path).getEntries().filter((entry) => entry.entryName.startsWith('media/'))
  ).toHaveLength(1)
})
