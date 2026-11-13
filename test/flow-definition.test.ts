import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { ProjectFile } from '../src/shared/types'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowDefinitionStore } from '../src/main/agent-flow/definition-store'
import { diffDefinitions } from '../src/shared/agent-flow/flow-definition'
import { FlowStagesSchema } from '../src/shared/agent-flow/stage-contracts'

const dbs: Database.Database[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

function fixture() {
  const db = new Database(':memory:')
  dbs.push(db)
  migrateDatabase(db)
  const stages = FlowStagesSchema.parse([
    {
      stageKey: 'organize',
      nodeId: 'first',
      goal: '整理',
      completion: '交付',
      method: { instructions: '先结论后论据' }
    },
    { stageKey: 'write', nodeId: 'second', goal: '写作', completion: '交付成稿' }
  ])
  const coordinatorConfig = {
    schemaVersion: 1,
    role: 'coordinator',
    interactionMode: 'autonomous',
    skills: [],
    tools: [{ id: 'agent.dispatch', version: '1' }],
    allowedNodeIds: ['first', 'second'],
    maxSteps: 8,
    relations: [],
    executionMode: 'fixed-order',
    stages
  }
  const file = {
    version: 1,
    meta: { id: 'p', name: 'isolated', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: [],
    edges: [],
    groups: [],
    tldrawSnapshot: {
      store: {
        main: {
          props: {
            nodeType: 'agent',
            config: JSON.stringify(coordinatorConfig),
            text: '固定任务目标'
          }
        }
      }
    }
  } as unknown as ProjectFile
  const open = (id: string) => (id === 'p' ? file : null)
  const store = new FlowDefinitionStore(db, open)
  return { db, file, store, coordinatorConfig }
}

describe('AF-06 flow definition versions', () => {
  it('发布不可变定义版本，版本递增，与运行分离', () => {
    const f = fixture()
    const v1 = f.store.publish({
      projectId: 'p',
      definitionId: 'def-1',
      name: '写作流程',
      coordinatorNodeId: 'main'
    })
    expect(v1.version).toBe(1)
    expect(v1.contentHash).toMatch(/^sha256:/)
    expect(v1.stages).toHaveLength(2)
    const v2 = f.store.publish({
      projectId: 'p',
      definitionId: 'def-1',
      name: '写作流程',
      coordinatorNodeId: 'main'
    })
    expect(v2.version).toBe(2)
    // v1 不可变
    expect(f.store.get('p', 'def-1', 1)!.version).toBe(1)
    expect(f.store.get('p', 'def-1')!.version).toBe(2)
    expect(f.store.list('p')).toHaveLength(1)
  })

  it('非固定顺序节点拒绝发布', () => {
    const f = fixture()
    const cfg = { ...f.coordinatorConfig, executionMode: undefined, stages: undefined }
    ;(
      f.file.tldrawSnapshot as { store: Record<string, { props: { config: string } }> }
    ).store.main.props.config = JSON.stringify(cfg)
    expect(() =>
      f.store.publish({
        projectId: 'p',
        definitionId: 'def-1',
        name: 'x',
        coordinatorNodeId: 'main'
      })
    ).toThrow(/FLOW_DEFINITION_NOT_FIXED_ORDER/)
  })

  it('差异预览：阶段增删改与变更字段', () => {
    const f = fixture()
    f.store.publish({
      projectId: 'p',
      definitionId: 'def-1',
      name: '写作流程',
      coordinatorNodeId: 'main'
    })
    // 修改：改 organize 方法、删 write、加 review
    const newStages = FlowStagesSchema.parse([
      {
        stageKey: 'organize',
        nodeId: 'first',
        goal: '整理',
        completion: '交付',
        method: { instructions: '先案例后分析' }
      },
      { stageKey: 'review', nodeId: 'second', goal: '审核', completion: '交付审核' }
    ])
    const cfg = { ...f.coordinatorConfig, stages: newStages }
    ;(
      f.file.tldrawSnapshot as { store: Record<string, { props: { config: string } }> }
    ).store.main.props.config = JSON.stringify(cfg)
    f.store.publish({
      projectId: 'p',
      definitionId: 'def-1',
      name: '写作流程',
      coordinatorNodeId: 'main'
    })
    const diff = f.store.diff('p', 'def-1', 1, 2)
    const organize = diff.stages.find((s) => s.stageKey === 'organize')!
    expect(organize.change).toBe('changed')
    expect(organize.fields).toContain('method')
    expect(diff.stages.find((s) => s.stageKey === 'write')!.change).toBe('removed')
    expect(diff.stages.find((s) => s.stageKey === 'review')!.change).toBe('added')
  })

  it('纯函数 diff：名称/目标变更', () => {
    const stages = FlowStagesSchema.parse([
      { stageKey: 'a', nodeId: 'n', goal: 'g', completion: 'c' }
    ])
    const diff = diffDefinitions(
      { name: '旧', coordinatorGoal: '目标1', stages },
      { name: '新', coordinatorGoal: '目标2', stages }
    )
    expect(diff.nameChanged).toBe(true)
    expect(diff.goalChanged).toBe(true)
    expect(diff.stages).toEqual([])
  })

  it('缺失版本差异拒绝', () => {
    const f = fixture()
    f.store.publish({ projectId: 'p', definitionId: 'def-1', name: 'x', coordinatorNodeId: 'main' })
    expect(() => f.store.diff('p', 'def-1', 1, 99)).toThrow(/FLOW_DEFINITION_MISSING/)
  })
})
