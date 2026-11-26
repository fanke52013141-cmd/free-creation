// ④P6 FlowGraph 定义版本：发布/读取/列表/差异（不可变快照，与运行分离）。
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowDefinitionStore } from '../src/main/agent-flow/definition-store'
import { FlowGraphSchema } from '../src/shared/agent-flow/flow-graph'
import { diffGraphDefinitions } from '../src/shared/agent-flow/flow-definition'
import type { ProjectFile } from '../src/shared/types'
import { buildCapabilityCatalog } from '../src/shared/agent-flow/capability-catalog'
import type { CompositeVersionRecord } from '../src/shared/composite/types'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

const graph = FlowGraphSchema.parse({
  schemaVersion: 1,
  graphId: 'g',
  name: '顺序',
  goal: '总目标',
  nodes: [
    { nodeId: 'a', title: 'a', participation: 'autonomous', kind: 'agent', goal: '完成某事', completion: '交付成果', modelDefinitionId: 'fixture-model', allowedNodeIds: ['sink'] },
    { nodeId: 'sink', title: 'sink', participation: 'autonomous', kind: 'capability', capability: 'text-pass@1', goal: '固化成果', completion: '输出固定文本' }
  ],
  edges: [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'sink', portId: 'in-value' }, kind: 'data' }],
  entry: 'a',
  exits: ['sink']
})

function fixture(composites: CompositeVersionRecord[] = []) {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'isolated')
  const file = { version: 1, meta: { id: 'p', name: 'test', createdAt: 0, updatedAt: 0, graphVersion: 0 }, nodes: [], edges: [], groups: [], tldrawSnapshot: { store: {} } } as unknown as ProjectFile
  const store = new FlowDefinitionStore(db, () => file, () => buildCapabilityCatalog(composites))
  return { db, store }
}

describe('④P6 FlowGraph 定义版本存储', () => {
  it('发布递增版本 + contentHash；get/list 读取', () => {
    const f = fixture()
    const v1 = f.store.publishGraph({ projectId: 'p', definitionId: 'd', name: '流程', graph })
    expect(v1.version).toBe(1)
    expect(v1.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    const v2 = f.store.publishGraph({ projectId: 'p', definitionId: 'd', name: '流程', graph })
    expect(v2.version).toBe(2)
    expect(v2.contentHash).toBe(v1.contentHash)
    expect(f.store.getGraph('p', 'd')?.version).toBe(2)
    expect(f.store.getGraph('p', 'd', 1)?.version).toBe(1)
    const list = f.store.listGraph('p')
    expect(list).toHaveLength(1)
    expect(list[0].version).toBe(2)
  })

  it('图定义与固定顺序定义按 schema 区分（listGraph 不混入 fixed-order）', () => {
    const f = fixture()
    f.store.publishGraph({ projectId: 'p', definitionId: 'gd', name: '图流程', graph })
    f.db.prepare('INSERT INTO flow_definitions VALUES (?,?,?,?,?,?)').run('p', 'fd', 1, JSON.stringify({ schemaVersion: 1, definitionId: 'fd', version: 1, name: '固定', coordinatorGoal: 'x', stages: [], contentHash: 'sha256:' + 'a'.repeat(64), createdAt: 0 }), 'sha256:' + 'a'.repeat(64), 0)
    const list = f.store.listGraph('p')
    expect(list.map((d) => d.definitionId)).toEqual(['gd'])
  })

  it('diff 比较节点增删改与数据边增删', () => {
    const f = fixture()
    f.store.publishGraph({ projectId: 'p', definitionId: 'd', name: '流程', graph })
    const changed = FlowGraphSchema.parse({
      ...graph,
      goal: '新目标',
      nodes: [
        { nodeId: 'a', title: 'a改', participation: 'autonomous', kind: 'agent', goal: '完成某事', completion: '交付成果', modelDefinitionId: 'fixture-model', allowedNodeIds: ['c'] },
        { nodeId: 'c', title: 'c', participation: 'autonomous', kind: 'capability', capability: 'text-pass@1', goal: '新节点', completion: '交付' }
      ],
      edges: [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'c', portId: 'in-value' }, kind: 'data' }],
      entry: 'a',
      exits: ['c']
    })
    f.store.publishGraph({ projectId: 'p', definitionId: 'd', name: '流程', graph: changed })
    const diff = f.store.diffGraph('p', 'd', 1, 2)
    expect(diff.goalChanged).toBe(true)
    expect(diff.nodes.find((n) => n.nodeId === 'a')?.change).toBe('changed')
    expect(diff.nodes.find((n) => n.nodeId === 'sink')?.change).toBe('removed')
    expect(diff.nodes.find((n) => n.nodeId === 'c')?.change).toBe('added')
    expect(diff.edgesAdded).toHaveLength(1)
    expect(diff.edgesRemoved).toHaveLength(1)
  })

  it('publishGraph 与 compile 共用完整 composite catalog，合法固定版本可发布', () => {
    const composite: CompositeVersionRecord = {
      capabilityId: 'fixed-composite',
      version: '1.0',
      contentHash: 'a'.repeat(64),
      publishedAt: 1,
      manifest: {
        schemaVersion: 1,
        runtimeVersion: 2,
        capabilityId: 'fixed-composite',
        version: '1.0',
        name: '固定文本流',
        inputs: [{ id: 'source', label: '输入', type: 'text', required: false, cardinality: 'many', targets: [{ nodeId: 'n1', portId: 'in-text' }] }],
        outputs: [{ id: 'result', label: '结果', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } }],
        graph: {
          nodes: [{ id: 'n1', nodeType: 'text', contractVersion: 3, title: '文本', dx: 0, dy: 0, w: 340, h: 300, ports: [] }],
          edges: []
        }
      }
    }
    const f = fixture([composite])
    const compositeGraph = FlowGraphSchema.parse({
      ...graph,
      nodes: [
        graph.nodes[0]!,
        {
          nodeId: 'sink', title: 'sink', participation: 'autonomous', kind: 'capability',
          capabilityRef: { kind: 'composite', id: 'fixed-composite', version: '1.0' },
          goal: '使用固定文本流', completion: '交付固定结果'
        }
      ],
      edges: [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'sink', portId: 'in-source' }, kind: 'data' }]
    })
    const published = f.store.publishGraph({
      projectId: 'p', definitionId: 'composite-definition', name: '组合定义', graph: compositeGraph
    })
    expect(published.version).toBe(1)
    expect(published.graph.nodes[1]?.capabilityRef).toMatchObject({
      kind: 'composite', id: 'fixed-composite', version: '1.0'
    })
  })

  it('diffGraphDefinitions 纯函数：相同图无差异', () => {
    const diff = diffGraphDefinitions({ name: '流程', graph }, { name: '流程', graph })
    expect(diff.nameChanged).toBe(false)
    expect(diff.goalChanged).toBe(false)
    expect(diff.nodes).toHaveLength(0)
    expect(diff.edgesAdded).toHaveLength(0)
    expect(diff.edgesRemoved).toHaveLength(0)
  })
})