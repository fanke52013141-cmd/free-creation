// P5 外部 FlowGraph 建图宿主：proposeGraph/previewGraph/discardGraph/listGraphPreviews。
// 复用 flow_builds（source=graph）+ committed/CAS；接收外部已生成图，不调模型、不写画布。
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowBuilderHost } from '../src/main/agent-flow/builder-host'
import type { ProjectFile } from '../src/shared/types'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import { FlowGraphSchema } from '../src/shared/agent-flow/flow-graph'
import { FlowGraphCompileError } from '../src/shared/agent-flow/flow-graph-compiler'
import { AgentNodeConfigSchema } from '../src/shared/agent-flow/node-contracts'
import { AgentRuntimeError } from '../src/shared/agent-flow/runtime-contracts'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

const seqGraph = FlowGraphSchema.parse({
  schemaVersion: 1,
  graphId: 'g',
  name: '顺序',
  goal: '总目标',
  nodes: [
    { nodeId: 'a', title: 'a', participation: 'autonomous', kind: 'agent', goal: '完成某事', completion: '交付成果' },
    { nodeId: 'b', title: 'b', participation: 'autonomous', kind: 'agent', goal: '完成某事', completion: '交付成果' }
  ],
  edges: [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-text' }, kind: 'data' }],
  entry: 'a',
  exits: ['b']
})
const cycleGraph = FlowGraphSchema.parse({
  schemaVersion: 1,
  graphId: 'g',
  name: '无界环',
  goal: '总目标',
  nodes: [
    { nodeId: 'a', title: 'a', participation: 'autonomous', kind: 'agent', goal: 'x', completion: 'x' },
    { nodeId: 'b', title: 'b', participation: 'autonomous', kind: 'agent', goal: 'x', completion: 'x' }
  ],
  edges: [
    { from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-text' }, kind: 'data' },
    { from: { nodeId: 'b', portId: 'out-text' }, to: { nodeId: 'a', portId: 'in-text' }, kind: 'data' }
  ],
  entry: 'a',
  exits: ['b']
})

function fixture(existingIds: string[] = []) {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'isolated')
  const store: Record<string, unknown> = {}
  for (const id of existingIds) {
    store[id] = { id, type: 'node-card', x: 0, y: 0, props: { nodeType: 'text', title: id, text: '', config: '{}' }, meta: {} }
  }
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'p', name: 'test', createdAt: 0, updatedAt: 0, graphVersion: 0 },
    nodes: [],
    edges: [],
    groups: [],
    tldrawSnapshot: { store }
  }
  let modelCalls = 0
  const model: AgentModelPort = {
    decide: async () => {
      modelCalls++
      return { kind: 'wait' }
    }
  } as AgentModelPort
  const host = new FlowBuilderHost(db, () => file, () => true, async () => model)
  return { db, host, file, modelCalls: () => modelCalls }
}

describe('P5 flowGraph.propose（外部建图提案）', () => {
  it('合法图持久化预览：source=graph，锚点=coordinator，节点带布局，coordinator 走 graph 模式', async () => {
    const f = fixture()
    const preview = await f.host.proposeGraph({ projectId: 'p', graph: seqGraph, requestId: 'r1' })
    expect(preview.source).toBe('graph')
    expect(preview.state).toBe('preview')
    expect(preview.nodeId).toBe(preview.coordinatorNodeId)
    expect(preview.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['a', 'b', preview.coordinatorNodeId, preview.stateNodeId]))
    for (const n of preview.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
    const coord = preview.nodes.find((n) => n.id === preview.coordinatorNodeId)!
    expect(AgentNodeConfigSchema.parse(JSON.parse(coord.config)).executionMode).toBe('graph')
    const row = f.db.prepare('SELECT source FROM flow_builds WHERE project_id=? AND build_id=?').get('p', preview.buildId) as { source: string }
    expect(row.source).toBe('graph')
    // 不写画布、不调模型。
    expect(f.modelCalls()).toBe(0)
    expect(Object.keys(f.file.tldrawSnapshot.store)).toHaveLength(0)
  })

  it('同图同 requestId 幂等返回同 buildId（不重复持久化）', async () => {
    const f = fixture()
    const first = await f.host.proposeGraph({ projectId: 'p', graph: seqGraph, requestId: 'r1' })
    const replay = await f.host.proposeGraph({ projectId: 'p', graph: seqGraph, requestId: 'r1' })
    expect(replay.buildId).toBe(first.buildId)
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM flow_builds WHERE project_id=?').get('p') as { n: number }
    expect(count.n).toBe(1)
  })

  it('非法图（无界环）抛 FlowGraphCompileError，不持久化', async () => {
    const f = fixture()
    await expect(f.host.proposeGraph({ projectId: 'p', graph: cycleGraph, requestId: 'r1' })).rejects.toBeInstanceOf(FlowGraphCompileError)
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM flow_builds WHERE project_id=?').get('p') as { n: number }
    expect(count.n).toBe(0)
  })

  it('预览节点已存在于画布 → FLOW_BUILD_CONFLICT', async () => {
    const f = fixture(['a'])
    await expect(f.host.proposeGraph({ projectId: 'p', graph: seqGraph, requestId: 'r1' })).rejects.toMatchObject({ code: 'FLOW_BUILD_CONFLICT' })
  })

  it('新建项目无 tldrawSnapshot 也能提案（空态语义修订，不抛 FLOW_SNAPSHOT_MISSING）', async () => {
    const db = new Database(':memory:')
    databases.push(db)
    migrateDatabase(db)
    db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'isolated')
    // createProject 的产物不含 tldrawSnapshot。
    const file = { version: 1, meta: { id: 'p', name: 'test', createdAt: 0, updatedAt: 0, graphVersion: 0 }, nodes: [], edges: [], groups: [] } as unknown as ProjectFile
    const host = new FlowBuilderHost(db, () => file, () => true, async () => ({ decide: async () => ({ kind: 'wait' }) } as AgentModelPort))
    const preview = await host.proposeGraph({ projectId: 'p', graph: seqGraph, requestId: 'r1' })
    expect(preview.state).toBe('preview')
    expect(preview.semanticRevision).toMatch(/^sha256:/)
    // preview/discard 在无快照项目上也正常（committed 按空 store 判 false）。
    const read = await host.previewGraph({ projectId: 'p', buildId: preview.buildId })
    expect(read?.state).toBe('preview')
    const discarded = await host.discardGraph({ projectId: 'p', buildId: preview.buildId })
    expect(discarded.state).toBe('discarded')
  })
})

describe('P5 flowGraph.preview / list / discard', () => {
  it('preview 读回最近预览；list 列出本项目 graph 预览', async () => {
    const f = fixture()
    const proposed = await f.host.proposeGraph({ projectId: 'p', graph: seqGraph, requestId: 'r1' })
    const read = await f.host.previewGraph({ projectId: 'p' })
    expect(read?.buildId).toBe(proposed.buildId)
    const byId = await f.host.previewGraph({ projectId: 'p', buildId: proposed.buildId })
    expect(byId?.buildId).toBe(proposed.buildId)
    const list = f.host.listGraphPreviews('p')
    expect(list.map((p) => p.buildId)).toEqual([proposed.buildId])
  })

  it('discard 置 discarded；重复 discard 幂等', async () => {
    const f = fixture()
    const proposed = await f.host.proposeGraph({ projectId: 'p', graph: seqGraph, requestId: 'r1' })
    const discarded = await f.host.discardGraph({ projectId: 'p', buildId: proposed.buildId })
    expect(discarded.state).toBe('discarded')
    const again = await f.host.discardGraph({ projectId: 'p', buildId: proposed.buildId })
    expect(again.state).toBe('discarded')
  })

  it('discard 不存在的 buildId → FLOW_BUILD_MISSING', async () => {
    const f = fixture()
    await expect(f.host.discardGraph({ projectId: 'p', buildId: 'graph-nope' })).rejects.toMatchObject({ code: 'FLOW_BUILD_MISSING' })
  })

  it('builder 预览与 graph 预览按 source 隔离（list 不混入 builder）', async () => {
    const f = fixture()
    await f.host.proposeGraph({ projectId: 'p', graph: seqGraph, requestId: 'r1' })
    f.db.prepare('INSERT INTO flow_builds(project_id,node_id,build_id,body_json,source) VALUES (?,?,?,?,?)').run('p', 'builder', 'build-x', '{}', 'builder')
    const list = f.host.listGraphPreviews('p')
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe('graph')
  })
})