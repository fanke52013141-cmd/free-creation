// O4-P1 FlowGraph schema + 静态校验：合法图通过；各类非法图稳定拒绝（引用/参与/环/可达/预算）。
import { describe, expect, it } from 'vitest'
import {
  FlowGraphSchema,
  validateFlowGraph,
  type FlowNode,
  type FlowGraph
} from '../src/shared/agent-flow/flow-graph'

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
  exits: string[],
  budgets?: Partial<FlowGraph['budgets']>
): FlowGraph =>
  FlowGraphSchema.parse({
    schemaVersion: 1,
    graphId: 'g',
    name: 'test',
    goal: '总目标',
    nodes,
    edges,
    entry,
    exits,
    ...(budgets ? { budgets } : {})
  })

const dataEdge = (from: string, to: string): FlowGraph['edges'][number] => ({
  from: { nodeId: from, portId: 'out-text' },
  to: { nodeId: to, portId: 'in-text' },
  kind: 'data'
})

describe('O4-P1 合法图通过', () => {
  it('顺序图', () => {
    const g = graph([node('a'), node('b')], [dataEdge('a', 'b')], 'a', ['b'])
    expect(validateFlowGraph(g)).toEqual({ ok: true })
  })

  it('条件分支图', () => {
    const cond = { kind: 'output-field', stageKey: 'a', path: 'text', op: 'exists' } as const
    const g = graph(
      [node('a'), node('b'), node('c'), node('d')],
      [
        { ...dataEdge('a', 'b'), condition: [cond] },
        { ...dataEdge('a', 'c'), condition: [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'missing' }] },
        dataEdge('b', 'd'),
        dataEdge('c', 'd')
      ],
      'a',
      ['d']
    )
    expect(validateFlowGraph(g)).toEqual({ ok: true })
  })

  it('有界循环图（环含 loop 载体）', () => {
    const g = graph(
      [
        node('a'),
        node('b', {
          loop: {
            maxIterations: 3,
            exitCondition: [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'exists' }]
          }
        })
      ],
      [dataEdge('a', 'b'), dataEdge('b', 'a')],
      'a',
      ['b']
    )
    expect(validateFlowGraph(g)).toEqual({ ok: true })
  })

  it('人机协作 + 纯人节点混合图', () => {
    const g = graph(
      [
        node('a'),
        node('b', {
          participation: 'collaborative',
          decisions: { allowed: ['approve', 'edit', 'reject'] }
        }),
        node('c', { participation: 'human', kind: 'human-task' })
      ],
      [dataEdge('a', 'b'), dataEdge('b', 'c')],
      'a',
      ['c']
    )
    expect(validateFlowGraph(g)).toEqual({ ok: true })
  })
})

describe('O4-P1 拓扑/预算拒绝', () => {
  it('无界环（无 loop 载体）拒绝', () => {
    const g = graph([node('a'), node('b')], [dataEdge('a', 'b'), dataEdge('b', 'a')], 'a', ['b'])
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'CYCLE_WITHOUT_LOOP')).toBe(true)
  })

  it('孤岛节点拒绝', () => {
    const g = graph([node('a'), node('b'), node('c')], [dataEdge('a', 'b')], 'a', ['b'])
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'UNREACHABLE_NODE' && e.nodeId === 'c')).toBe(true)
  })

  it('出口不可达拒绝', () => {
    const g = graph([node('a'), node('b'), node('c')], [dataEdge('a', 'b')], 'a', ['c'])
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'EXIT_UNREACHABLE')).toBe(true)
  })

  it('循环超预算拒绝', () => {
    const g = graph(
      [
        node('a'),
        node('b', {
          loop: {
            maxIterations: 10,
            exitCondition: [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'exists' }]
          }
        })
      ],
      [dataEdge('a', 'b'), dataEdge('b', 'a')],
      'a',
      ['b'],
      { maxLoopIterations: 8 }
    )
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'LOOP_BUDGET_EXCEEDED')).toBe(true)
  })

  it('入口即出口拒绝', () => {
    const g = graph([node('a')], [], 'a', ['a'])
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'ENTRY_IS_EXIT')).toBe(true)
  })
})

describe('O4-P1 schema 层拒绝', () => {
  const base = {
    schemaVersion: 1,
    graphId: 'g',
    name: 'test',
    goal: '总目标',
    entry: 'a',
    exits: ['a']
  }
  it('human 参与不能用 agent 节点', () => {
    expect(
      FlowGraphSchema.safeParse({ ...base, nodes: [node('a', { participation: 'human', kind: 'agent' })], edges: [] }).success
    ).toBe(false)
  })
  it('collaborative 缺 decisions 拒绝', () => {
    expect(
      FlowGraphSchema.safeParse({ ...base, nodes: [node('a', { participation: 'collaborative' })], edges: [] }).success
    ).toBe(false)
  })
  it('autonomous 带 decisions 拒绝', () => {
    expect(
      FlowGraphSchema.safeParse({
        ...base,
        nodes: [node('a', { decisions: { allowed: ['approve'] } })],
        edges: []
      }).success
    ).toBe(false)
  })
  it('悬空边引用拒绝', () => {
    expect(
      FlowGraphSchema.safeParse({ ...base, nodes: [node('a')], edges: [dataEdge('a', 'ghost')] }).success
    ).toBe(false)
  })
  it('selector 引用未声明节点拒绝', () => {
    expect(
      FlowGraphSchema.safeParse({
        ...base,
        nodes: [
          node('a', {
            inputs: { selectors: [{ sourceStageKey: 'ghost', path: '', required: true }], budgetBytes: 131072 }
          })
        ],
        edges: []
      }).success
    ).toBe(false)
  })
  it('capability 节点缺 capability 拒绝', () => {
    expect(
      FlowGraphSchema.safeParse({ ...base, nodes: [node('a', { kind: 'capability' })], edges: [] }).success
    ).toBe(false)
  })
})