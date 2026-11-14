// ④P6 FlowGraph 定义版本：发布/读取/列表/差异（不可变快照，与运行分离）。
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowDefinitionStore } from '../src/main/agent-flow/definition-store'
import { FlowGraphSchema } from '../src/shared/agent-flow/flow-graph'
import { diffGraphDefinitions } from '../src/shared/agent-flow/flow-definition'
import type { ProjectFile } from '../src/shared/types'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

const graph = FlowGraphSchema.parse({
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

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'isolated')
  const file = { version: 1, meta: { id: 'p', name: 'test', createdAt: 0, updatedAt: 0, graphVersion: 0 }, nodes: [], edges: [], groups: [], tldrawSnapshot: { store: {} } } as unknown as ProjectFile
  const store = new FlowDefinitionStore(db, () => file)
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
        { nodeId: 'a', title: 'a改', participation: 'autonomous', kind: 'agent', goal: '完成某事', completion: '交付成果' },
        { nodeId: 'c', title: 'c', participation: 'autonomous', kind: 'agent', goal: '新节点', completion: '交付' }
      ],
      edges: [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'c', portId: 'in-text' }, kind: 'data' }],
      entry: 'a',
      exits: ['c']
    })
    f.store.publishGraph({ projectId: 'p', definitionId: 'd', name: '流程', graph: changed })
    const diff = f.store.diffGraph('p', 'd', 1, 2)
    expect(diff.goalChanged).toBe(true)
    expect(diff.nodes.find((n) => n.nodeId === 'a')?.change).toBe('changed')
    expect(diff.nodes.find((n) => n.nodeId === 'b')?.change).toBe('removed')
    expect(diff.nodes.find((n) => n.nodeId === 'c')?.change).toBe('added')
    expect(diff.edgesAdded).toHaveLength(1)
    expect(diff.edgesRemoved).toHaveLength(1)
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