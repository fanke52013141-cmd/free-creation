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
    expect(smConfig.states).toEqual([
      'idle', 'running', 'waiting-human', 'reviewing', 'paused', 'completed', 'failed', 'stopped'
    ])
    expect(smConfig.transitions).toEqual(expect.arrayContaining([
      { from: 'running', event: 'agent.completed', to: 'running' },
      { from: 'running', event: 'review.started', to: 'reviewing' },
      { from: 'reviewing', event: 'review.passed', to: 'running' },
      { from: 'running', event: 'human.wait', to: 'waiting-human' },
      { from: 'waiting-human', event: 'flow.stopped', to: 'stopped' },
      { from: 'reviewing', event: 'flow.failed', to: 'failed' }
    ]))

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
      graph(
        [node('a', { kind: 'capability', capability: 'text-pass@1' }), node('b')],
        [
          {
            from: { nodeId: 'a', portId: 'out-value' },
            to: { nodeId: 'b', portId: 'in-text' },
            kind: 'data'
          }
        ],
        'a',
        ['b']
      )
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
          node('b', { loop: { maxIterations: 3, exitCondition: [{ kind: 'output-field', stageKey: 'b', path: 'text', op: 'exists' }] } })
        ],
        [dataEdge('a', 'b')],
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

describe('BL-03 编译重映射：条件与最小输入里的节点引用', () => {
  it('带条件分支、otherwise 与 selectors 的图可编译，引用全部映射为画布 id', () => {
    const eq = (value: string) =>
      [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'equals', value }] as FlowGraph['edges'][number]['condition']
    const compiled = compileFlowGraph(
      graph(
        [
          node('a'),
          node('b', { inputs: { selectors: [{ sourceStageKey: 'a', path: 'text', required: true }], budgetBytes: 4096 } }),
          node('c'),
          node('d')
        ],
        [
          { ...dataEdge('a', 'b'), condition: eq('yes') },
          { ...dataEdge('a', 'c'), condition: eq('no') },
          { ...dataEdge('a', 'd'), otherwise: true }
        ],
        'a',
        ['b', 'c', 'd']
      )
    )
    const coord = compiled.nodes.find((n) => n.id === compiled.coordinatorNodeId)!
    const config = AgentNodeConfigSchema.parse(JSON.parse(coord.config))
    const edges = config.graph!.edges
    expect(edges[0].condition?.[0]).toMatchObject({ stageKey: canvasNodeId('a') })
    expect(edges[1].condition?.[0]).toMatchObject({ stageKey: canvasNodeId('a') })
    expect(edges[2].otherwise).toBe(true)
    const b = config.graph!.nodes.find((n) => n.nodeId === canvasNodeId('b'))!
    expect(b.inputs?.selectors[0].sourceStageKey).toBe(canvasNodeId('a'))
  })
})


describe('BL-18 流程阶段机（AF-12.3a 冻结：阶段 FSM）', () => {
  const PHASES = ['idle', 'running', 'waiting-human', 'reviewing', 'paused', 'completed', 'failed', 'stopped']
  const phaseGraphs: Array<[string, FlowGraph]> = [
    [
      '并行 fork',
      graph([node('a'), node('b'), node('c')], [dataEdge('a', 'b'), dataEdge('a', 'c')], 'a', ['b', 'c'])
    ],
    [
      '循环',
      graph(
        [
          node('a'),
          node('b', {
            loop: {
              maxIterations: 2,
              exitCondition: [
                { kind: 'output-field', stageKey: 'b', path: 'text', op: 'exists' }
              ]
            }
          })
        ],
        [dataEdge('a', 'b')],
        'a',
        ['b']
      )
    ],
    [
      '条件分支 + otherwise',
      graph(
        [node('a'), node('b'), node('c')],
        [
          {
            ...dataEdge('a', 'b'),
            condition: [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'exists' }]
          },
          { ...dataEdge('a', 'c'), otherwise: true }
        ],
        'a',
        ['b', 'c']
      )
    ]
  ]

  it.each(phaseGraphs)('%s：编译出的状态机只包含流程阶段，不含节点级状态', (_label, flowGraph) => {
    const compiled = compileFlowGraph(flowGraph)
    const stateNode = compiled.nodes.find((n) => n.id === compiled.stateNodeId)!
    const config = StateMachineNodeConfigSchema.parse(JSON.parse(stateNode.config))
    expect(config.states).toEqual(PHASES)
    const serialized = JSON.stringify(config)
    for (const flowNode of flowGraph.nodes) {
      expect(config.states).not.toContain(flowNode.nodeId)
      expect(config.transitions.some((t) => t.from === flowNode.nodeId || t.to === flowNode.nodeId)).toBe(false)
      expect(serialized).not.toContain(`shape:${flowNode.nodeId}`)
    }
    const declared = new Set(config.states)
    for (const transition of config.transitions) {
      expect(declared.has(transition.from)).toBe(true)
      expect(declared.has(transition.to)).toBe(true)
      expect(transition.event).toMatch(/^(flow|agent|human|review|rework)\./)
    }
  })

  it('阶段迁移覆盖协调器实际会发出的事件（续跑/人工等待/返工/停止）', () => {
    const compiled = compileFlowGraph(
      graph([node('a'), node('b')], [dataEdge('a', 'b')], 'a', ['b'])
    )
    const stateNode = compiled.nodes.find((n) => n.id === compiled.stateNodeId)!
    const config = StateMachineNodeConfigSchema.parse(JSON.parse(stateNode.config))
    const transitions = config.transitions
    for (const event of [
      'flow.started',
      'human.continue',
      'human.wait',
      'agent.dispatched',
      'agent.completed',
      'flow.rework',
      'flow.completed',
      'flow.failed',
      'flow.stopped'
    ]) {
      expect(transitions.some((t) => t.event === event)).toBe(true)
    }
  })
})
