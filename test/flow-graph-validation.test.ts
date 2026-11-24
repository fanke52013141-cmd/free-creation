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

  it('有界循环图（单节点 loop 声明，不画回边）', () => {
    const g = graph(
      [
        node('a'),
        node('b', {
          loop: {
            maxIterations: 3,
            exitCondition: [{ kind: 'output-field', stageKey: 'b', path: 'text', op: 'exists' }]
          }
        })
      ],
      [dataEdge('a', 'b')],
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
      [dataEdge('a', 'b')],
      'a',
      ['b'],
      { maxLoopIterations: 8 }
    )
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'LOOP_BUDGET_EXCEEDED')).toBe(true)
  })

  it('BL-07：多节点环（即使含 loop 载体）拒绝 LOOP_BODY_UNSUPPORTED', () => {
    const g = graph(
      [
        node('a'),
        node('b', {
          loop: {
            maxIterations: 3,
            exitCondition: [{ kind: 'output-field', stageKey: 'b', path: 'text', op: 'exists' }]
          }
        }),
        node('c')
      ],
      [dataEdge('a', 'b'), dataEdge('b', 'c'), dataEdge('c', 'b')],
      'a',
      ['c']
    )
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'LOOP_BODY_UNSUPPORTED' && e.nodeId === 'b')).toBe(true)
      expect(result.errors.some((e) => e.code === 'CYCLE_WITHOUT_LOOP')).toBe(false)
    }
  })

  it('BL-07：自回边（b→b）拒绝 LOOP_BODY_UNSUPPORTED，循环只用 node.loop 声明', () => {
    const g = graph(
      [
        node('a'),
        node('b', {
          loop: {
            maxIterations: 3,
            exitCondition: [{ kind: 'output-field', stageKey: 'b', path: 'text', op: 'exists' }]
          }
        })
      ],
      [dataEdge('a', 'b'), dataEdge('b', 'b')],
      'a',
      ['b']
    )
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'LOOP_BODY_UNSUPPORTED')).toBe(true)
  })

  it('入口即出口拒绝', () => {
    const g = graph([node('a')], [], 'a', ['a'])
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'ENTRY_IS_EXIT')).toBe(true)
  })
})

describe('BL-05 校验即准入：种类白名单与能力目录', () => {
  it('state-machine 图节点在校验期即拒绝 NODE_KIND_UNSUPPORTED（与运行准入同口径）', () => {
    const g = graph(
      [node('a'), node('b', { kind: 'state-machine' })],
      [dataEdge('a', 'b')],
      'a',
      ['b']
    )
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'NODE_KIND_UNSUPPORTED' && e.nodeId === 'b')).toBe(true)
  })
  it('未知能力在校验期即拒绝 CAPABILITY_UNKNOWN（不再等到编译）', () => {
    const g = graph(
      [node('a', { kind: 'capability', capability: 'shell@1' }), node('b')],
      [dataEdge('a', 'b')],
      'a',
      ['b']
    )
    const result = validateFlowGraph(g)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.code === 'CAPABILITY_UNKNOWN' && e.nodeId === 'a')).toBe(true)
  })
  it('目录内能力与全部可分派种类通过', () => {
    const g = graph(
      [
        node('a', { kind: 'capability', capability: 'text-pass@1' }),
        node('b', { kind: 'review', review: { criteria: 'c', rejectPolicy: 'rework', maxReworks: 1 } }),
        node('c', { participation: 'human', kind: 'human-task' })
      ],
      [
        {
          from: { nodeId: 'a', portId: 'out-value' },
          to: { nodeId: 'b', portId: 'in-text' },
          kind: 'data'
        },
        {
          from: { nodeId: 'b', portId: 'out-feedback' },
          to: { nodeId: 'c', portId: 'in-text' },
          kind: 'data'
        }
      ],
      'a',
      ['c']
    )
    expect(validateFlowGraph(g)).toEqual({ ok: true })
  })
})

describe('BL-04 同源条件出边互斥', () => {
  const field = (path: string, op: 'exists' | 'missing') =>
    [{ kind: 'output-field', stageKey: 'a', path, op }] as FlowGraph['edges'][number]['condition']
  const eqv = (value: unknown) =>
    [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'equals', value }] as FlowGraph['edges'][number]['condition']
  const branch = (edges: FlowGraph['edges']) =>
    graph([node('a'), node('b'), node('c')], edges, 'a', ['b', 'c'])
  const codes = (g: FlowGraph) => {
    const result = validateFlowGraph(g)
    return result.ok ? [] : result.errors.map((e) => e.code)
  }
  it('可能同时成立的条件拒绝 CONDITION_NOT_EXCLUSIVE', () => {
    const g = branch([
      { ...dataEdge('a', 'b'), condition: field('text', 'exists') },
      { ...dataEdge('a', 'c'), condition: field('data.title', 'exists') }
    ])
    expect(codes(g)).toContain('CONDITION_NOT_EXCLUSIVE')
  })
  it('equals 不同值 / exists 与 missing / 计数区间不相交 → 互斥通过', () => {
    expect(codes(branch([{ ...dataEdge('a', 'b'), condition: eqv('yes') }, { ...dataEdge('a', 'c'), condition: eqv('no') }]))).toEqual([])
    expect(codes(branch([{ ...dataEdge('a', 'b'), condition: field('text', 'exists') }, { ...dataEdge('a', 'c'), condition: field('text', 'missing') }]))).toEqual([])
    const count = (op: 'gte' | 'lte', n: number) =>
      [{ kind: 'output-count', stageKey: 'a', op, count: n }] as FlowGraph['edges'][number]['condition']
    expect(codes(branch([{ ...dataEdge('a', 'b'), condition: count('gte', 2) }, { ...dataEdge('a', 'c'), condition: count('lte', 1) }]))).toEqual([])
    expect(codes(branch([{ ...dataEdge('a', 'b'), condition: count('gte', 2) }, { ...dataEdge('a', 'c'), condition: count('lte', 2) }]))).toContain('CONDITION_NOT_EXCLUSIVE')
  })
  it('人工决定没有否定形式：两条 human-decision 分支不互斥，须改用 otherwise', () => {
    const decided = [{ kind: 'human-decision', stageKey: 'a' }] as FlowGraph['edges'][number]['condition']
    expect(codes(branch([{ ...dataEdge('a', 'b'), condition: decided }, { ...dataEdge('a', 'c'), condition: decided }]))).toContain('CONDITION_NOT_EXCLUSIVE')
    expect(codes(branch([{ ...dataEdge('a', 'b'), condition: decided }, { ...dataEdge('a', 'c'), otherwise: true }]))).toEqual([])
  })
  it('otherwise 用法：缺条件兄弟边或多于一条拒绝 OTHERWISE_INVALID；与 condition 同用 schema 拒绝', () => {
    expect(codes(branch([dataEdge('a', 'b'), { ...dataEdge('a', 'c'), otherwise: true }]))).toContain('OTHERWISE_INVALID')
    const g = graph(
      [node('a'), node('b'), node('c'), node('d')],
      [{ ...dataEdge('a', 'b'), condition: eqv('yes') }, { ...dataEdge('a', 'c'), otherwise: true }, { ...dataEdge('a', 'd'), otherwise: true }],
      'a',
      ['b', 'c', 'd']
    )
    expect(codes(g)).toContain('OTHERWISE_INVALID')
    const parsed = FlowGraphSchema.safeParse({
      schemaVersion: 1,
      graphId: 'g',
      name: 'test',
      goal: '总目标',
      nodes: [node('a'), node('b')],
      edges: [{ ...dataEdge('a', 'b'), condition: eqv('yes'), otherwise: true }],
      entry: 'a',
      exits: ['b']
    })
    expect(parsed.success).toBe(false)
  })
})

describe('BL-05 control 边已删除', () => {
  const base = {
    schemaVersion: 1,
    graphId: 'g',
    name: 'test',
    goal: '总目标',
    nodes: [node('a'), node('b')],
    entry: 'a',
    exits: ['b']
  }
  const edge = { from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-text' } }
  it('省略 kind 兼容旧 JSON，解析为 data', () => {
    const parsed = FlowGraphSchema.parse({ ...base, edges: [edge] })
    expect(parsed.edges[0].kind).toBe('data')
  })
  it("kind:'control' 显式拒绝，错误带 FLOW_EDGE_KIND_REMOVED 并定位到边", () => {
    const result = FlowGraphSchema.safeParse({ ...base, edges: [{ ...edge, kind: 'control' }] })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((item) => item.message.includes('FLOW_EDGE_KIND_REMOVED'))
      expect(issue).toBeTruthy()
      expect(issue!.path).toEqual(['edges', 0, 'kind'])
    }
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