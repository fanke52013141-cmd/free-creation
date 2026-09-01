/**
 * P2 安全写入事务测试（HANDOFF_2026_09_01_AGENT_SAFETY_BASELINE）
 *
 * 覆盖四个层面：
 * 1. syncGraphSnapshot：图数据 ↔ tldraw 快照的纯函数同步（增/改/删/幂等）
 * 2. projects.repo.saveProject：expectedGraphVersion 原子乐观锁 + 失败回滚
 * 3. FileProjectStore + NodeService：Agent 写入后快照与图数据同源落盘、
 *    版本冲突映射为 REVISION_CONFLICT Result 而非异常
 * 4. agentWriteEnabledFromEnv：draft 写入开关
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CanvasNode, CanvasEdge, ProjectFile } from '@shared/types'
import { GraphVersionConflictError, syncGraphSnapshot } from '@shared/graph-snapshot-sync'

// ── 测试数据 ───────────────────────────────────────────────

function textNode(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'shape:node-a',
    type: 'text',
    contractVersion: 1,
    title: '文本',
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [
      {
        id: 'in-text',
        name: '文本',
        dir: 'in',
        type: 'text',
        required: false,
        cardinality: 'many',
        description: '上游文本'
      },
      {
        id: 'out-text',
        name: '文本',
        dir: 'out',
        type: 'text',
        required: true,
        cardinality: 'one',
        description: '节点文本'
      }
    ],
    params: {},
    content: { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 },
    ...overrides
  }
}

function edge(id: string, from: string, to: string): CanvasEdge {
  return { id, from: { nodeId: from, portId: 'out-text' }, to: { nodeId: to, portId: 'in-text' } }
}

function storeOf(snapshot: unknown): Record<string, Record<string, unknown>> {
  const store = (snapshot as { store: Record<string, Record<string, unknown>> }).store
  return store
}

// ── 1. syncGraphSnapshot 纯函数 ───────────────────────────

describe('syncGraphSnapshot', () => {
  it('无快照时构建可加载的最小快照：schema + page + document + node-card', () => {
    const { snapshot } = syncGraphSnapshot(undefined, {
      nodes: [textNode()],
      edges: [],
      groups: []
    })
    const snap = snapshot as { store: Record<string, unknown>; schema: { schemaVersion: number } }
    expect(snap.schema.schemaVersion).toBe(2)
    expect(snap.store['page:page']).toMatchObject({ typeName: 'page' })
    expect(snap.store['document:document']).toMatchObject({ typeName: 'document' })
    expect(snap.store['shape:node-a']).toMatchObject({
      typeName: 'shape',
      type: 'node-card',
      x: 0,
      y: 0,
      props: { nodeType: 'text', title: '文本', w: 340, h: 260 }
    })
  })

  it('已有快照上新增节点：record 带完整 node-card props 与 parentId', () => {
    const first = syncGraphSnapshot(undefined, {
      nodes: [textNode()],
      edges: [],
      groups: []
    })
    const second = syncGraphSnapshot(first.snapshot, {
      nodes: [textNode(), textNode({ id: 'shape:node-b', x: 500, y: 100 })],
      edges: [],
      groups: []
    })
    const store = storeOf(second.snapshot)
    expect(store['shape:node-b']).toMatchObject({
      type: 'node-card',
      parentId: 'page:page',
      x: 500,
      y: 100
    })
    // 两个 node-card 的 fractional index 必须不同（z-order 唯一）
    const idxA = (store['shape:node-a'].index as string) ?? ''
    const idxB = (store['shape:node-b'].index as string) ?? ''
    expect(idxA).not.toBe(idxB)
  })

  it('更新节点时保留 meta.nodeResult 等运行数据，只改位置与 props', () => {
    const base = syncGraphSnapshot(undefined, {
      nodes: [textNode()],
      edges: [],
      groups: []
    })
    // 模拟画布执行后写入的运行数据
    const baseStore = storeOf(base.snapshot)
    baseStore['shape:node-a'].meta = { nodeResult: '{"kind":"text"}', nodeRun: { runId: 'r1' } }

    const { snapshot } = syncGraphSnapshot(base.snapshot, {
      nodes: [textNode({ x: 222, y: 333, title: '改名', content: { kind: 'text', text: '正文' } })],
      edges: [],
      groups: []
    })
    const record = storeOf(snapshot)['shape:node-a']
    expect(record.x).toBe(222)
    expect(record.y).toBe(333)
    expect(record.meta).toMatchObject({ nodeResult: '{"kind":"text"}', nodeRun: { runId: 'r1' } })
    expect(record.props).toMatchObject({ title: '改名', text: '正文' })
  })

  it('params.config 与 media content 正确映射进 props', () => {
    const { snapshot } = syncGraphSnapshot(undefined, {
      nodes: [
        textNode({ params: { config: '{"model":"x"}' } }),
        textNode({
          id: 'shape:node-m',
          content: { kind: 'media', mediaId: 'media-1' }
        })
      ],
      edges: [],
      groups: []
    })
    const store = storeOf(snapshot)
    expect(store['shape:node-a'].props).toMatchObject({ config: '{"model":"x"}' })
    expect(store['shape:node-m'].props).toMatchObject({ mediaId: 'media-1', text: '' })
  })

  it('新增边：arrow + start/end 两条 binding，端口写入 meta，几何按端口落点计算', () => {
    const from = textNode({ id: 'shape:from', x: 0, y: 0 })
    const to = textNode({ id: 'shape:to', x: 600, y: 200 })
    const { snapshot } = syncGraphSnapshot(undefined, {
      nodes: [from, to],
      edges: [edge('shape:edge-1', 'shape:from', 'shape:to')],
      groups: []
    })
    const store = storeOf(snapshot)
    const arrow = store['shape:edge-1']
    expect(arrow).toMatchObject({
      type: 'arrow',
      x: from.w, // start = 源节点右缘
      y: from.h / 2, // 单输出端口落点 = 卡片中线
      meta: { fromPort: 'out-text', toPort: 'in-text' }
    })
    expect((arrow.props as { end: { x: number } }).end.x).toBeCloseTo(600 - from.w, 5)

    const bindings = Object.values(store).filter((r) => r.typeName === 'binding')
    expect(bindings).toHaveLength(2)
    const terminals = bindings.map((b) => (b.props as { terminal: string }).terminal).sort()
    expect(terminals).toEqual(['end', 'start'])
    for (const b of bindings) {
      expect(b.fromId).toBe('shape:edge-1')
      expect(b.toId === 'shape:from' || b.toId === 'shape:to').toBe(true)
    }
  })

  it('删除节点时级联清理其 node-card、关联 arrow 与 binding', () => {
    const from = textNode({ id: 'shape:from' })
    const to = textNode({ id: 'shape:to', x: 600 })
    const withEdge = syncGraphSnapshot(undefined, {
      nodes: [from, to],
      edges: [edge('shape:edge-1', 'shape:from', 'shape:to')],
      groups: []
    })

    const { snapshot } = syncGraphSnapshot(withEdge.snapshot, {
      nodes: [to], // from 节点被删除
      edges: [],
      groups: []
    })
    const store = storeOf(snapshot)
    expect(store['shape:from']).toBeUndefined()
    expect(store['shape:edge-1']).toBeUndefined()
    expect(Object.values(store).filter((r) => r.typeName === 'binding')).toHaveLength(0)
    expect(store['shape:to']).toMatchObject({ type: 'node-card' })
  })

  it('端点节点缺失的悬空边不进入快照', () => {
    const { snapshot } = syncGraphSnapshot(undefined, {
      nodes: [textNode()],
      edges: [edge('shape:edge-x', 'shape:ghost', 'shape:node-a')],
      groups: []
    })
    expect(storeOf(snapshot)['shape:edge-x']).toBeUndefined()
  })

  it('幂等：同一图数据同步两次，第二次 changed=false 且内容一致', () => {
    const from = textNode({ id: 'shape:from' })
    const to = textNode({ id: 'shape:to', x: 600 })
    const graph = {
      nodes: [from, to],
      edges: [edge('shape:edge-1', 'shape:from', 'shape:to')],
      groups: []
    }
    const first = syncGraphSnapshot(undefined, graph)
    const second = syncGraphSnapshot(first.snapshot, graph)
    expect(second.changed).toBe(false)
    expect(second.snapshot).toEqual(first.snapshot)
  })

  it('裸 id（无 shape: 前缀）按 shape:<id> 映射，与画布 deriveGraph 同源', () => {
    const { snapshot } = syncGraphSnapshot(undefined, {
      nodes: [textNode({ id: 'bare-id-1' })],
      edges: [],
      groups: []
    })
    const store = storeOf(snapshot)
    expect(store['shape:bare-id-1']).toMatchObject({ type: 'node-card' })
    expect(store['bare-id-1']).toBeUndefined()
  })

  it('已有快照的 schema 顶层键原样保留', () => {
    const existing = {
      schema: { schemaVersion: 2, sequences: { 'com.tldraw.store': 5 } },
      store: {
        'page:page': { typeName: 'page', id: 'page:page', name: 'Page 1', index: 'a1', meta: {} },
        'document:document': { typeName: 'document', id: 'document:document', meta: {} }
      }
    }
    const { snapshot } = syncGraphSnapshot(existing, {
      nodes: [textNode()],
      edges: [],
      groups: []
    })
    expect((snapshot as { schema: unknown }).schema).toEqual(existing.schema)
  })
})

// ── 2. projects.repo 原子乐观锁与回滚 ─────────────────────

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
  rows: new Map<string, StoredProjectRow>(),
  failOnUpdate: false
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
        if (repoState.failOnUpdate) throw new Error('SQLite 写入失败（注入）')
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

describe('projects.repo.saveProject 图写入事务', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canvas-graph-tx-'))
    repoState.projectsDir = join(root, 'projects')
    repoState.rows.clear()
    repoState.failOnUpdate = false
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function importRepo() {
    return import('../../src/main/store/projects.repo')
  }

  it('expectedGraphVersion 匹配时保存成功并推进版本', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('事务项目')
    const saved = repo.saveProject({
      id: meta.id,
      graph: { nodes: [], edges: [], groups: [] },
      expectedGraphVersion: 0
    })
    expect(saved).toEqual({ graphVersion: 1 })
  })

  it('expectedGraphVersion 不匹配时抛 GraphVersionConflictError 且文件不被修改', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('冲突项目')
    repo.saveProject({
      id: meta.id,
      tldrawSnapshot: { store: { 'page:page': { typeName: 'page' } } }
    })
    const path = join(repoState.projectsDir, meta.id, 'project.json')
    const before = readFileSync(path, 'utf-8')

    expect(() =>
      repo.saveProject({
        id: meta.id,
        graph: { nodes: [], edges: [], groups: [] },
        expectedGraphVersion: 0 // 实际已是 1
      })
    ).toThrow(GraphVersionConflictError)

    expect(readFileSync(path, 'utf-8')).toBe(before)
    expect(repo.getProject(meta.id)?.graphVersion).toBe(1)
  })

  it('SQLite 更新失败时回滚：project.json 恢复为上一版内容', async () => {
    const repo = await importRepo()
    const meta = repo.createProject('回滚项目')
    repo.saveProject({
      id: meta.id,
      graph: { nodes: [], edges: [], groups: [] }
    })
    const path = join(repoState.projectsDir, meta.id, 'project.json')
    const before = readFileSync(path, 'utf-8')

    repoState.failOnUpdate = true
    expect(() =>
      repo.saveProject({
        id: meta.id,
        graph: { nodes: [], edges: [], groups: [] },
        tldrawSnapshot: { store: {} }
      })
    ).toThrow('SQLite 写入失败（注入）')

    expect(readFileSync(path, 'utf-8')).toBe(before)
    expect(existsSync(path + '.tmp')).toBe(false)
    repoState.failOnUpdate = false
    expect(repo.getProject(meta.id)?.graphVersion).toBe(1)
  })
})

// ── 3. FileProjectStore + NodeService 端到端（真实临时目录） ──

describe('Agent 写入事务 · FileProjectStore 集成', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canvas-agent-write-'))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function setup() {
    const { createServices, FileProjectStore } = await import('@application')
    const store = new FileProjectStore({ dataDir: root })
    const services = createServices(store)
    const meta = await store.createProject('Agent 写入')
    return { store, services, projectId: meta.id }
  }

  function readDiskProject(projectId: string): ProjectFile {
    return JSON.parse(
      readFileSync(join(root, 'projects', projectId, 'project.json'), 'utf-8')
    ) as ProjectFile
  }

  it('createNode 落盘后，快照中出现同 id 的 node-card record', async () => {
    const { services, projectId } = await setup()
    const result = await services.nodeService.createNode({
      projectId,
      type: 'text',
      title: '提示词',
      x: 100,
      y: 80
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // id 采用 tldraw shape id 形态，Agent 侧与画布侧同源
    expect(result.data.id.startsWith('shape:')).toBe(true)

    const file = readDiskProject(projectId)
    const snap = file.tldrawSnapshot as { store: Record<string, Record<string, unknown>> }
    expect(snap.store['page:page']).toBeDefined()
    expect(snap.store['document:document']).toBeDefined()
    expect(snap.store[result.data.id]).toMatchObject({
      type: 'node-card',
      x: 100,
      y: 80,
      props: { nodeType: 'text', title: '提示词' }
    })
    expect(file.nodes.map((n) => n.id)).toEqual([result.data.id])
  })

  it('connectNodes 落盘后，快照中出现 arrow 与 start/end binding', async () => {
    const { services, projectId } = await setup()
    const a = await services.nodeService.createNode({ projectId, type: 'text', x: 0, y: 0 })
    const b = await services.nodeService.createNode({ projectId, type: 'text', x: 600, y: 200 })
    if (!a.ok || !b.ok) throw new Error('前置节点创建失败')
    const conn = await services.nodeService.connectNodes({
      projectId,
      from: { nodeId: a.data.id, portId: 'out-text' },
      to: { nodeId: b.data.id, portId: 'in-text' }
    })
    expect(conn.ok).toBe(true)
    if (!conn.ok) return

    const file = readDiskProject(projectId)
    const snap = file.tldrawSnapshot as { store: Record<string, Record<string, unknown>> }
    expect(snap.store[conn.data.id]).toMatchObject({
      type: 'arrow',
      meta: { fromPort: 'out-text', toPort: 'in-text' }
    })
    const bindings = Object.values(snap.store).filter((r) => r.typeName === 'binding')
    expect(bindings).toHaveLength(2)
    expect(file.edges.map((e) => e.id)).toEqual([conn.data.id])
  })

  it('deleteNode 落盘后，快照中的 node-card 与关联 arrow/binding 一并移除', async () => {
    const { services, projectId } = await setup()
    const a = await services.nodeService.createNode({ projectId, type: 'text' })
    const b = await services.nodeService.createNode({ projectId, type: 'text', x: 600 })
    if (!a.ok || !b.ok) throw new Error('前置节点创建失败')
    await services.nodeService.connectNodes({
      projectId,
      from: { nodeId: a.data.id, portId: 'out-text' },
      to: { nodeId: b.data.id, portId: 'in-text' }
    })

    const del = await services.nodeService.deleteNode(projectId, a.data.id)
    expect(del.ok).toBe(true)

    const file = readDiskProject(projectId)
    const snap = file.tldrawSnapshot as { store: Record<string, Record<string, unknown>> }
    expect(snap.store[a.data.id]).toBeUndefined()
    expect(Object.values(snap.store).filter((r) => r.type === 'arrow')).toHaveLength(0)
    expect(Object.values(snap.store).filter((r) => r.typeName === 'binding')).toHaveLength(0)
    expect(file.nodes.map((n) => n.id)).toEqual([b.data.id])
    expect(file.edges).toHaveLength(0)
  })

  it('expectedGraphVersion 冲突时返回 REVISION_CONFLICT Result，而非抛出异常', async () => {
    const { services, projectId } = await setup()
    const first = await services.nodeService.createNode({
      projectId,
      type: 'text',
      expectedGraphVersion: 0
    })
    expect(first.ok).toBe(true)

    // 模拟外部写入推进版本后，仍用旧版本号提交
    const stale = await services.nodeService.createNode({
      projectId,
      type: 'text',
      expectedGraphVersion: 0
    })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error.code).toBe('REVISION_CONFLICT')
    expect(stale.error.details).toMatchObject({ actualGraphVersion: 1 })
  })

  it('保存失败（非冲突）映射为 SAVE_FAILED Result，不中断调用方', async () => {
    const { FileProjectStore } = await import('@application')
    const brokenStore = new FileProjectStore({ dataDir: root })
    vi.spyOn(brokenStore, 'saveGraph').mockRejectedValue(new Error('磁盘写入失败'))
    const { createServices } = await import('@application')
    const services = createServices(brokenStore)
    const meta = await brokenStore.createProject('失败注入')
    const result = await services.nodeService.createNode({ projectId: meta.id, type: 'text' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('SAVE_FAILED')
    expect(result.error.message).toContain('磁盘写入失败')
  })
})

// ── 4. draft 写入环境开关 ─────────────────────────────────

describe('agentWriteEnabledFromEnv', () => {
  it('仅 CANVAS_AGENT_WRITE=draft 开启写入', async () => {
    const { agentWriteEnabledFromEnv } = await import('@application')
    expect(agentWriteEnabledFromEnv('draft')).toBe(true)
    expect(agentWriteEnabledFromEnv(undefined)).toBe(false)
    expect(agentWriteEnabledFromEnv('')).toBe(false)
    expect(agentWriteEnabledFromEnv('full')).toBe(false)
    expect(agentWriteEnabledFromEnv('DRAFT')).toBe(false)
  })
})
