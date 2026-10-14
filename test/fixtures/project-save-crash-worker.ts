// Test-only fs/SQLite cut points; the repository has no production fault switches.
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { closeDb, getDb, getProjectsDir } from '../../src/main/store/db'
import { createProject, openProject, saveProject } from '../../src/main/store/projects.repo'

const directory = process.argv[2],
  boundary = process.argv[3]
if (
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-save-main-')
)
  throw new Error('SAVE_FIXTURE_DIRECTORY_REJECTED')
process.env.CANVAS_DATA_DIR = directory
const db = getDb()
db.pragma('synchronous = FULL')
const cut = (): never => {
  fs.writeSync(1, 'cut-ready\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('CUT_NOT_TERMINATED')
}
if (boundary === 'recover' || boundary === 'continue' || boundary === 'stale-edit') {
  const id = fs.readFileSync(join(directory, 'project-id'), 'utf8')
  const file = openProject(id)!
  let saved: number | undefined,
    blocked = false,
    conflict = false
  if (boundary !== 'recover') {
    try {
      saved = saveProject({
        id,
        expectedGraphVersion: file.meta.graphVersion - (boundary === 'stale-edit' ? 1 : 0),
        tldrawSnapshot: { material: 'explicit-next-edit' }
      })!.graphVersion
    } catch (error) {
      if ((error as Error).name === 'GraphWriteInProgressError') blocked = true
      else if ((error as Error).name === 'GraphVersionConflictError') conflict = true
      else throw error
    }
  }
  const row = db.prepare('SELECT graph_version FROM projects WHERE id = ?').get(id)
  fs.writeSync(
    1,
    JSON.stringify({
      version: file.meta.graphVersion,
      snapshot: file.tldrawSnapshot,
      row,
      saved,
      blocked,
      conflict
    }) + '\n'
  )
  closeDb()
} else {
  const project = createProject('测试：main 保存强杀')
  fs.writeFileSync(join(directory, 'project-id'), project.id)
  saveProject({
    id: project.id,
    expectedGraphVersion: 0,
    tldrawSnapshot: { material: 'last-valid-edit' }
  })
  const path = join(getProjectsDir(), project.id, 'project.json')
  const mutableFs = createRequire(__filename)('fs') as typeof fs
  const write = mutableFs.writeFileSync,
    rename = mutableFs.renameSync
  const close = mutableFs.closeSync
  mutableFs.closeSync = ((fd) => {
    if (boundary === 'committed') cut()
    close(fd)
  }) as typeof fs.closeSync
  mutableFs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    write(...args)
    if (boundary === 'tmp' && String(args[0]) === path + '.tmp') cut()
  }) as typeof fs.writeFileSync
  mutableFs.renameSync = ((from, to) => {
    rename(from, to)
    if (
      (boundary === 'bak' && String(to) === path + '.bak') ||
      (boundary === 'promoted' && String(to) === path)
    )
      cut()
  }) as typeof fs.renameSync
  if (boundary === 'transaction') {
    db.function('cut_save', cut)
    db.exec(
      'CREATE TEMP TRIGGER save_cut AFTER UPDATE OF graph_version ON projects BEGIN SELECT cut_save(); END'
    )
  }
  saveProject({
    id: project.id,
    expectedGraphVersion: 1,
    tldrawSnapshot: { material: 'new-valid-edit' }
  })
  cut()
}
