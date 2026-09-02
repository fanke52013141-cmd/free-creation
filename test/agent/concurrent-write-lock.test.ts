/**
 * AG-6 并发写入安全测试
 *
 * 验证三入口（Electron / CLI / MCP）共享同一 project.json 时的写入安全：
 * 1. 写锁生命周期：成功/失败后 .write-lock 都被清理
 * 2. 锁冲突检测：存在锁文件时抛 GraphWriteInProgressError
 * 3. 过期锁接管：>30s 的旧锁可被新写入者覆盖
 * 4. DesktopProjectStore 退避重试：瞬时锁冲突自动重试后成功
 * 5. NodeService 错误映射：GraphWriteInProgressError → REVISION_CONFLICT Result
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  GraphWriteInProgressError,
  GraphVersionConflictError
} from '@shared/graph-snapshot-sync'

// ── DB mock（与 graph-write-transaction.test.ts 同源模式） ────

interface StoredProjectRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  cover_media_id: string | null
  graph_version: number
  deleted: number
}

const repoState = vi.hoisted(() => ({
  projectsDir: '',
  rows: new Map<string, StoredProjectRow>()
}))

vi.mock('../../src/main/store/db', (): { getProjectsDir: () => string; getDb: () => unknown } => {
  const statement = (sql: string) => ({
    all: () => [...repoState.rows.values()].filter((row) => row.deleted === 0),
    get: (id: string) => {
      const row = repoState.rows.get(id)
      return row?.deleted === 0 ? row : undefined
    },
    run: (...values: unknown[]) => {
      if (sql.startsWith('INSERT INTO projects')) {
        const [id, name, createdAt, updatedAt] = values as [string, string, number, number]
        repoState.rows.set(id, {
          id,
          name,
          created_at: createdAt,
          updated_at: updatedAt,
          cover_media_id: null,
          graph_version: 0,
          deleted: 0
        })
      }
      if (sql.startsWith('UPDATE projects SET updated_at')) {
        const [updatedAt, graphVersion, id] = values as [number, number, string]
        const row = repoState.rows.get(id)
        if (row) {
          row.updated_at = updatedAt
          row.graph_version = graphVersion
        }
      }
      return { changes: 1 }
    }
  })
  return {
    getProjectsDir: () => repoState.projectsDir,
    getDb: () => ({ prepare: statement })
  }
})

describe('AG-6 并发写入安全', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canvas-ag6-lock-'))
    repoState.projectsDir = join(root, 'projects')
    repoState.rows.clear()
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function importRepo() {
    return import('../../src/main/store/projects.repo')
  }

  function lockPath(projectId: string): string {
    return join(repoState.projectsDir, projectId, 'project.json.write-lock')
  }

  // ── 1. 写锁生命周期 ────────────────────────────────────────

  it('成功保存后 .write-lock 被清理', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('锁清理测试')
    repo.saveProject({
      id: meta.id,
      graph: { nodes: [], edges: [], groups: [] }
    })
    expect(existsSync(lockPath(meta.id))).toBe(false)
  })

  it('版本冲突失败后 .write-lock 仍被清理', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('冲突后锁清理')
    repo.saveProject({ id: meta.id, graph: { nodes: [], edges: [], groups: [] } })

    expect(() =>
      repo.saveProject({
        id: meta.id,
        graph: { nodes: [], edges: [], groups: [] },
        expectedGraphVersion: 0 // 实际已是 1
      })
    ).toThrow(GraphVersionConflictError)

    expect(existsSync(lockPath(meta.id))).toBe(false)
  })

  // ── 2. 锁冲突检测 ──────────────────────────────────────────

  it('存在未过期的 .write-lock 时抛 GraphWriteInProgressError', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('锁占用测试')
    const lp = lockPath(meta.id)
    // 模拟另一进程正在写入：创建一个新鲜的锁文件
    writeFileSync(lp, 'fake-pid', 'utf-8')

    expect(() =>
      repo.saveProject({
        id: meta.id,
        graph: { nodes: [], edges: [], groups: [] }
      })
    ).toThrow(GraphWriteInProgressError)

    // 锁文件仍存在（本次写入没有获取到锁，不会清理它）
    expect(existsSync(lp)).toBe(true)
  })

  // ── 3. 过期锁接管 ──────────────────────────────────────────

  it('超过 30s 的旧 .write-lock 可被新写入者覆盖', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('过期锁接管')
    const lp = lockPath(meta.id)
    writeFileSync(lp, 'dead-pid', 'utf-8')

    // 把锁文件的 mtime 设为 60s 前
    const oldTime = new Date(Date.now() - 60_000)
    utimesSync(lp, oldTime, oldTime)

    const result = repo.saveProject({
      id: meta.id,
      graph: { nodes: [], edges: [], groups: [] }
    })
    expect(result).toEqual({ graphVersion: 1 })
    expect(existsSync(lp)).toBe(false)
  })

  // ── 4. DesktopProjectStore 退避重试 ─────────────────────────

  it('DesktopProjectStore 遇到 GraphWriteInProgressError 时自动重试后成功', async () => {
    const { DesktopProjectStore } = await import('@application')

    // 用 spy 让第一次 saveProject 抛锁冲突，第二次正常（mockImplementationOnce 自动恢复）
    const repo = await importRepo()
    const meta = repo.createProject('重试测试')
    const saveSpy = vi.spyOn(repo, 'saveProject')
    saveSpy.mockImplementationOnce(() => {
      throw new GraphWriteInProgressError()
    })

    const desktopStore = new DesktopProjectStore()
    const result = await desktopStore.saveGraph(
      meta.id,
      { nodes: [], edges: [], groups: [] },
      { expectedGraphVersion: 0 }
    )
    expect(result.graphVersion).toBe(1)
    expect(saveSpy).toHaveBeenCalledTimes(2) // 第一次失败，第二次成功
    saveSpy.mockRestore()
  })

  // ── 5. NodeService 错误映射 ────────────────────────────────

  it('NodeService 把 GraphWriteInProgressError 映射为 REVISION_CONFLICT', async () => {
    const { createServices } = await import('@application')
    const { FileProjectStore } = await import('@application')

    const tmpRoot = mkdtempSync(join(tmpdir(), 'canvas-ag6-mapping-'))
    try {
      const fileStore = new FileProjectStore({ dataDir: tmpRoot })
      const services = createServices(fileStore, { agentWrite: 'draft' })
      const meta = await fileStore.createProject('映射测试')

      // 通过 spy 让 saveGraph 抛 GraphWriteInProgressError
      const storeSpy = vi.spyOn(fileStore, 'saveGraph')
      storeSpy.mockRejectedValueOnce(new GraphWriteInProgressError())

      const result = await services.nodeService.createNode({
        projectId: meta.id,
        type: 'text',
        title: '测试节点'
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('REVISION_CONFLICT')
      }
      storeSpy.mockRestore()
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  // ── 6. 三入口共享同一数据源验证 ─────────────────────────────

  it('Electron 和 Agent 写入同一项目后 graphVersion 连续递增', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('三入口共享')

    // 模拟 Electron 画布保存（通过 repo.saveProject 直接调用）
    const r1 = repo.saveProject({
      id: meta.id,
      tldrawSnapshot: { store: {} },
      graph: { nodes: [], edges: [], groups: [] }
    })
    expect(r1).toEqual({ graphVersion: 1 })

    // 模拟 Agent 通过 NodeService 写入（经过 DesktopProjectStore）
    const { DesktopProjectStore } = await import('@application')
    const store = new DesktopProjectStore()
    const r2 = await store.saveGraph(
      meta.id,
      { nodes: [], edges: [], groups: [] },
      { expectedGraphVersion: 1 }
    )
    expect(r2.graphVersion).toBe(2)

    // 验证最终版本一致
    const final = repo.getProject(meta.id)
    expect(final?.graphVersion).toBe(2)
  })

  // ── 7. 故障恢复：损坏的 project.json 回退到 .bak ─────────────

  it('project.json 损坏时自动回退到 .bak 文件', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('故障恢复')
    // 写入有效数据，产生 .bak
    repo.saveProject({
      id: meta.id,
      tldrawSnapshot: { store: {} },
      graph: { nodes: [], edges: [], groups: [] }
    })
    // 再保存一次，让 .bak 保存第一版数据
    repo.saveProject({
      id: meta.id,
      tldrawSnapshot: { store: { 'page:page': { typeName: 'page' } } },
      graph: { nodes: [], edges: [], groups: [] }
    })

    // 损坏主文件
    const mainPath = join(repoState.projectsDir, meta.id, 'project.json')
    writeFileSync(mainPath, '{ "corrupted": true, "missing": ', 'utf-8')

    // openProject 应回退到 .bak
    const recovered = repo.openProject(meta.id)
    expect(recovered).not.toBeNull()
    if (recovered) {
      // .bak 保存的是倒数第二次写入的数据（graphVersion=1）
      expect(recovered.meta.graphVersion).toBeGreaterThanOrEqual(1)
    }
  })

  it('锁文件残留（进程崩溃后）不会永久阻塞后续写入', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('崩溃恢复')
    const lp = lockPath(meta.id)

    // 模拟进程崩溃：残留锁文件 + 极新的 mtime（30s 内）
    writeFileSync(lp, 'crashed-pid', 'utf-8')

    // 此时新写入应被阻塞（锁未过期）
    expect(() =>
      repo.saveProject({
        id: meta.id,
        graph: { nodes: [], edges: [], groups: [] }
      })
    ).toThrow(GraphWriteInProgressError)

    // 将锁文件 mtime 设为 35s 前（超过 30s 过期阈值）
    const oldTime = new Date(Date.now() - 35_000)
    utimesSync(lp, oldTime, oldTime)

    // 过期锁可被接管，写入成功
    const result = repo.saveProject({
      id: meta.id,
      graph: { nodes: [], edges: [], groups: [] }
    })
    expect(result).toEqual({ graphVersion: 1 })
    expect(existsSync(lp)).toBe(false)
  })
})
