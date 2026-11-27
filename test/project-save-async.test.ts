import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeDb, getDb } from '../src/main/store/db'
import {
  createProject,
  openProject,
  projectJsonPath,
  saveProject,
  saveProjectAsync
} from '../src/main/store/projects.repo'
import {
  GraphVersionConflictError,
  GraphWriteInProgressError
} from '../src/shared/graph-snapshot-sync'

describe('projects.repo saveProjectAsync (non-blocking atomic persistence)', () => {
  let dataDir: string
  const originalDataDir = process.env.CANVAS_DATA_DIR

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'canvas-async-save-'))
    process.env.CANVAS_DATA_DIR = dataDir
    getDb()
  })

  afterEach(() => {
    closeDb()
    if (originalDataDir === undefined) delete process.env.CANVAS_DATA_DIR
    else process.env.CANVAS_DATA_DIR = originalDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('persists snapshots asynchronously, advances graphVersion, rotates .bak, and stays interoperable with sync saveProject', async () => {
    const meta = createProject('异步保存测试')
    const r1 = await saveProjectAsync({
      id: meta.id,
      expectedGraphVersion: 0,
      tldrawSnapshot: { store: { a: { id: 'a' } } },
      graph: { nodes: [], edges: [], groups: [] }
    })
    expect(r1).toEqual({ graphVersion: 1 })
    expect(existsSync(projectJsonPath(meta.id) + '.bak')).toBe(true)

    // Interoperate with sync saveProject
    const r2 = saveProject({
      id: meta.id,
      expectedGraphVersion: 1,
      tldrawSnapshot: { store: { b: { id: 'b' } } }
    })
    expect(r2).toEqual({ graphVersion: 2 })

    const r3 = await saveProjectAsync({
      id: meta.id,
      expectedGraphVersion: 2,
      tldrawSnapshot: { store: { c: { id: 'c' } } }
    })
    expect(r3).toEqual({ graphVersion: 3 })

    const reopened = openProject(meta.id)
    expect(reopened?.meta.graphVersion).toBe(3)
    expect((reopened?.tldrawSnapshot as { store?: Record<string, unknown> })?.store).toHaveProperty('c')
  })

  it('rejects stale expectedGraphVersion with GraphVersionConflictError without modifying disk', async () => {
    const meta = createProject('异步版本冲突')
    await saveProjectAsync({ id: meta.id, expectedGraphVersion: 0 })
    const before = readFileSync(projectJsonPath(meta.id), 'utf-8')

    await expect(
      saveProjectAsync({ id: meta.id, expectedGraphVersion: 0 })
    ).rejects.toBeInstanceOf(GraphVersionConflictError)

    expect(readFileSync(projectJsonPath(meta.id), 'utf-8')).toBe(before)
  })

  it('enforces exclusive write lock across concurrent saveProjectAsync calls', async () => {
    const meta = createProject('异步并发互斥')
    const [a, b] = await Promise.allSettled([
      saveProjectAsync({
        id: meta.id,
        expectedGraphVersion: 0,
        tldrawSnapshot: { store: { payload: 'x'.repeat(256 * 1024) } }
      }),
      saveProjectAsync({
        id: meta.id,
        expectedGraphVersion: 0,
        tldrawSnapshot: { store: { payload: 'y'.repeat(256 * 1024) } }
      })
    ])
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled')
    const rejected = [a, b].filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(GraphWriteInProgressError)
  })

  it('recovers from corrupt primary project.json via verified .bak on async save', async () => {
    const meta = createProject('异步损坏恢复')
    await saveProjectAsync({
      id: meta.id,
      expectedGraphVersion: 0,
      tldrawSnapshot: { store: { v: 1 } }
    })
    await saveProjectAsync({
      id: meta.id,
      expectedGraphVersion: 1,
      tldrawSnapshot: { store: { v: 2 } }
    })
    // Corrupt primary file; .bak still holds verified v1
    writeFileSync(projectJsonPath(meta.id), '{corrupt', 'utf-8')

    const recovered = await saveProjectAsync({
      id: meta.id,
      expectedGraphVersion: 1,
      tldrawSnapshot: { store: { v: 3 } }
    })
    expect(recovered).toEqual({ graphVersion: 2 })
    expect(openProject(meta.id)?.meta.graphVersion).toBe(2)
  })
})
