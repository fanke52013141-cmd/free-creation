// O4-P2 FlowGraph 纯编译器：合法图编译为画布图（协调器+专业节点+状态机+边），配置过契约 schema；
// 非法图抛 FlowGraphCompileError；能力/人工/审核节点正确映射。
import { describe, expect, it } from 'vitest'
import {
  compileFlowGraph,
  FlowGraphCompileError,
  canvasNodeId
} from '../src/shared/agent-flow/flow-graph-compiler'
import { FlowGraphSchema, type FlowNode, type FlowGraph } from '../src/shared/agent-flow/flow-graph'
import {
  AgentNodeConfigSchema,
  StateMachineNodeConfigSchema,
  HumanTaskNodeConfigSchema,
  ReviewNodeConfigSchema
} from '../src/shared/agent-flow/node-contracts'

const node = (nodeId: string, overrides: Partial<FlowNode> = {}): FlowNode =>
  ({
    nodeId,
    title: nodeId,
    participation: 'autonomous',
    kind: 'agent',
    goal: '完成某事',
    completion: '交付正式成果',
    ...overrides
  }) as FlowNode

const graph = (
  nodes: FlowNode[],
  edges: FlowGraph['edges'],
  entry: string,
  exits: string[]
): FlowGraph =>
  FlowGraphSchema.parse({ schemaVersion: 1, graphId: 'g', name: 'test', goal: '总目标', nodes, edges, entry, exits })

const dataEdge = (from: string, to: string): FlowGraph['edges'][number] => ({
  from: { nodeId: from, portId: 'out-text' },
  to: { nodeId: to, portId: 'in-text' },
  kind: 'data'
})

describe('O4-P2 编译器', () => {
  it('顺序图编译为协调器 + 专业节点 + 状态机 + 数据边', () => {
    const compiled = compileFlowGraph(graph([node('a'), node('b')], [dataEdge('a', 'b')], 'a', ['b']))
    const ids = compiled.nodes.map((n) => n.id)
    expect(ids).toEqual(expect.arrayContaining([canvasNodeId('a'), canvasNodeId('b'), compiled.coordinatorNodeId, compiled.stateNodeId]))

    const coord = compiled.nodes.find((n) => n.id === compiled.coordinatorNodeId)!
    const coordConfig = AgentNodeConfigSchema.parse(JSON.parse(coord.config))
    expect(coordConfig.role).toBe('coordinator')
    expect(coordConfig.allowedNodeIds).toEqual(expect.arrayContaining([canvasNodeId('a'), canvasNodeId('b')]))
    expect(coordConfig.relations.some((r) => r.kind === 'observes' && r.targetNodeId === compiled.stateNodeId)).toBe(true)

    const a = compiled.nodes.find((n) => n.id === canvasNodeId('a'))!
    expect(AgentNodeConfigSchema.parse(JSON.parse(a.config)).role).toBe('specialist')

    const sm = compiled.nodes.find((n) => n.id === compiled.stateNodeId)!
    const smConfig = StateMachineNodeConfigSchema.parse(JSON.parse(sm.config))
    expect(smConfig.states).toEqual(expect.arrayContaining(['idle', canvasNodeId('a'), canvasNodeId('b'), 'completed']))

    expect(compiled.edges).toEqual([
      { from: { nodeId: canvasNodeId('a'), portId: 'out-text' }, to: { nodeId: canvasNodeId('b'), portId: 'in-text' } }
    ])
  })

  it('所有编译产物配置都过契约 schema', () => {
    const compiled = compileFlowGraph(
      graph(
        [
          node('a'),
          node('b', { participation: 'collaborative', decisions: { allowed: ['approve', 'reject'] } }),
          node('c', { participation: 'human', kind: 'human-task' })
        ],
        [dataEdge('a', 'b'), dataEdge('b', 'c')],
        'a',
        ['c']
      )
    )
    for (const n of compiled.nodes) {
      if (n.type === 'agent') expect(() => AgentNodeConfigSchema.parse(JSON.parse(n.config))).not.toThrow()
      if (n.type === 'state-machine') expect(() => StateMachineNodeConfigSchema.parse(JSON.parse(n.config))).not.toThrow()
      if (n.type === 'human-task') expect(() => HumanTaskNodeConfigSchema.parse(JSON.parse(n.config))).not.toThrow()
    }
    const b = compiled.nodes.find((n) => n.id === canvasNodeId('b'))!
    expect(AgentNodeConfigSchema.parse(JSON.parse(b.config)).interactionMode).toBe('collaborative')
  })

  it('非法图（无界环）抛 FlowGraphCompileError', () => {
    const g = graph([node('a'), node('b')], [dataEdge('a', 'b'), dataEdge('b', 'a')], 'a', ['b'])
    expect(() => compileFlowGraph(g)).toThrow(FlowGraphCompileError)
  })

  it('capability 节点编译为 processor', () => {
    const compiled = compileFlowGraph(
      graph([node('a', { kind: 'capability', capability: 'text-pass@1' }), node('b')], [dataEdge('a', 'b')], 'a', ['b'])
    )
    const a = compiled.nodes.find((n) => n.id === canvasNodeId('a'))!
    expect(a.type).toBe('processor')
    expect(JSON.parse(a.config).operation).toBe('pass')
  })

  it('human-task 节点编译为 human-task 配置', () => {
    const compiled = compileFlowGraph(
      graph([node('a'), node('b', { participation: 'human', kind: 'human-task' })], [dataEdge('a', 'b')], 'a', ['b'])
    )
    const b = compiled.nodes.find((n) => n.id === canvasNodeId('b'))!
    expect(b.type).toBe('human-task')
    expect(HumanTaskNodeConfigSchema.parse(JSON.parse(b.config)).outputType).toBe('text')
  })

  it('review 节点编译为 ai-review 配置', () => {
    const compiled = compileFlowGraph(
      graph(
        [node('a'), node('b', { kind: 'review', review: { criteria: '审核标准', rejectPolicy: 'rework', maxReworks: 2 } })],
        [dataEdge('a', 'b')],
        'a',
        ['b']
      )
    )
    const b = compiled.nodes.find((n) => n.id === canvasNodeId('b'))!
    expect(b.type).toBe('ai-review')
    expect(ReviewNodeConfigSchema.parse(JSON.parse(b.config)).maxReworks).toBe(2)
    expect(b.text).toBe('审核标准')
  })

  it('有界循环图可编译（循环载体保留）', () => {
    const compiled = compileFlowGraph(
      graph(
        [
          node('a'),
          node('b', { loop: { maxIterations: 3, exitCondition: [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'exists' }] } })
        ],
        [dataEdge('a', 'b'), dataEdge('b', 'a')],
        'a',
        ['b']
      )
    )
    expect(compiled.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([canvasNodeId('a'), canvasNodeId('b')]))
  })
})

describe('P5 编译器补全（落画布后走图路由 + 预览布局）', () => {
  it('coordinator 配置带 executionMode:graph + graph（落画布后走 graphStep，不退回模型分派）', () => {
    const g = graph([node('a'), node('b')], [dataEdge('a', 'b')], 'a', ['b'])
    const compiled = compileFlowGraph(g)
    const coord = compiled.nodes.find((n) => n.id === compiled.coordinatorNodeId)!
    const coordConfig = AgentNodeConfigSchema.parse(JSON.parse(coord.config))
    expect(coordConfig.executionMode).toBe('graph')
    expect(coordConfig.graph).toBeTruthy()
    expect(coordConfig.graph!.graphId).toBe('g')
    expect(coordConfig.graph!.nodes.map((n) => n.nodeId)).toEqual([canvasNodeId('a'), canvasNodeId('b')])
  })

  it('编译产物节点 id 均为 tldraw 合法 shape id（shape: 前缀，可直接落画布）', () => {
    const compiled = compileFlowGraph(graph([node('a'), node('b')], [dataEdge('a', 'b')], 'a', ['b']))
    for (const n of compiled.nodes) expect(n.id.startsWith('shape:')).toBe(true)
    expect(compiled.coordinatorNodeId.startsWith('shape:')).toBe(true)
    expect(compiled.stateNodeId.startsWith('shape:')).toBe(true)
    for (const e of compiled.edges) {
      expect(e.from.nodeId.startsWith('shape:')).toBe(true)
      expect(e.to.nodeId.startsWith('shape:')).toBe(true)
    }
  })

  it('所有编译产物节点带有限布局坐标，且不全重叠在原点', () => {
    const compiled = compileFlowGraph(graph([node('a'), node('b'), node('c')], [dataEdge('a', 'b'), dataEdge('b', 'c')], 'a', ['c']))
    for (const n of compiled.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
    const distinct = new Set(compiled.nodes.map((n) => `${n.x},${n.y}`))
    expect(distinct.size).toBeGreaterThan(1)
  })
})