// O4-P3 声明式图路由：顺序/条件分支/汇合（all/any）；路由只认交付事实，模型文字不能改路由。
import { describe, expect, it } from 'vitest'
import { nextReadyNodes, isFlowComplete, deliveredGraphNodes } from '../src/shared/agent-flow/flow-graph-router'
import { FlowGraphSchema, type FlowNode, type FlowGraph } from '../src/shared/agent-flow/flow-graph'
import type { StageEntryFacts, StageDeliveryFact } from '../src/shared/agent-flow/stage-contracts'

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

const graph = (nodes: FlowNode[], edges: FlowGraph['edges'], entry: string, exits: string[]): FlowGraph =>
  FlowGraphSchema.parse({ schemaVersion: 1, graphId: 'g', name: 'test', goal: '总目标', nodes, edges, entry, exits })

const dataEdge = (from: string, to: string, condition?: FlowGraph['edges'][number]['condition']): FlowGraph['edges'][number] => ({
  from: { nodeId: from, portId: 'out-text' },
  to: { nodeId: to, portId: 'in-text' },
  kind: 'data',
  ...(condition ? { condition } : {})
})

const delivery = (stageKey: string, text: string): StageDeliveryFact => ({
  stageKey,
  nodeId: stageKey,
  outputs: [{ kind: 'text', text }],
  humanDecided: false
})
const facts = (deliveries: StageDeliveryFact[]): StageEntryFacts => ({ deliveries, reviews: [] })
const eq = (stageKey: string, value: string) =>
  [{ kind: 'output-field', stageKey, path: 'text', op: 'equals', value }] as const

describe('O4-P3 顺序路由', () => {
  const g = graph([node('a'), node('b'), node('c')], [dataEdge('a', 'b'), dataEdge('b', 'c')], 'a', ['c'])
  it('初始只有入口就绪', () => {
    expect(nextReadyNodes(g, facts([]), new Set()).ready).toEqual(['a'])
  })
  it('a 交付后 b 就绪', () => {
    expect(nextReadyNodes(g, facts([delivery('a', 'x')]), new Set(['a'])).ready).toEqual(['b'])
  })
  it('b 交付后 c 就绪；c 交付后流程完成', () => {
    expect(nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'y')]), new Set(['a', 'b'])).ready).toEqual(['c'])
    expect(isFlowComplete(g, facts([]), new Set(['a', 'b', 'c']))).toBe(true)
    expect(isFlowComplete(g, facts([]), new Set(['a', 'b']))).toBe(false)
  })
})

describe('O4-P3 条件分支路由', () => {
  const g = graph(
    [node('a'), node('b'), node('c'), node('d', { joinPolicy: 'any' })],
    [dataEdge('a', 'b', eq('a', 'yes')), dataEdge('a', 'c', eq('a', 'no')), dataEdge('b', 'd'), dataEdge('c', 'd')],
    'a',
    ['d']
  )
  it('a 交付 yes → 走 b 分支，c 跳过（BL-03 死路径消除）', () => {
    const result = nextReadyNodes(g, facts([delivery('a', 'yes')]), new Set(['a']))
    expect(result.ready).toEqual(['b'])
    expect(result.skipped).toContain('c')
  })
  it('a 交付 no → 走 c 分支，b 跳过', () => {
    const result = nextReadyNodes(g, facts([delivery('a', 'no')]), new Set(['a']))
    expect(result.ready).toEqual(['c'])
    expect(result.skipped).toContain('b')
  })
  it('路由只认交付事实：节点未交付即使有模型文字声称完成也不就绪', () => {
    // delivered 集合为空（无权威交付），即便 facts 里塞入"声称"也不算数——ready 只有入口。
    const result = nextReadyNodes(g, facts([delivery('a', 'yes')]), new Set())
    expect(result.ready).toEqual(['a'])
    expect(result.ready).not.toContain('b')
  })
})

describe('O4-P3 汇合路由', () => {
  const edges = [dataEdge('a', 'b'), dataEdge('a', 'c'), dataEdge('b', 'd'), dataEdge('c', 'd')]
  it('join=any：任一分支交付即汇合就绪', () => {
    const g = graph([node('a'), node('b'), node('c'), node('d', { joinPolicy: 'any' })], edges, 'a', ['d'])
    const result = nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'y')]), new Set(['a', 'b']))
    expect(result.ready).toContain('d')
  })
  it('join=all（缺省）：须所有分支交付才汇合', () => {
    const g = graph([node('a'), node('b'), node('c'), node('d')], edges, 'a', ['d'])
    const partial = nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'y')]), new Set(['a', 'b']))
    expect(partial.ready).not.toContain('d')
    const full = nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'y'), delivery('c', 'z')]), new Set(['a', 'b', 'c']))
    expect(full.ready).toContain('d')
  })
})

describe('O4-P4 循环路由（retry/until，迭代计数由宿主传入）', () => {
  const loopGraph = (maxIterations: number) =>
    graph(
      [
        node('a'),
        node('b', {
          loop: {
            maxIterations,
            exitCondition: [{ kind: 'output-field', stageKey: 'b', path: 'text', op: 'equals', value: 'done' }]
          }
        }),
        node('c')
      ],
      [dataEdge('a', 'b'), dataEdge('b', 'c')],
      'a',
      ['c']
    )

  it('循环未达退出条件：重复分派 b，下游 c 阻塞', () => {
    const g = loopGraph(3)
    const result = nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'working')]), new Set(['a', 'b']), { b: 1 })
    expect(result.ready).toContain('b')
    expect(result.ready).not.toContain('c')
    expect(isFlowComplete(g, facts([delivery('b', 'working')]), new Set(['a', 'b']), { b: 1 })).toBe(false)
  })

  it('退出条件满足：b settled，下游 c 就绪', () => {
    const g = loopGraph(3)
    const result = nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'done')]), new Set(['a', 'b']), { b: 1 })
    expect(result.ready).not.toContain('b')
    expect(result.ready).toContain('c')
  })

  it('达到 maxIterations：强制退出，b settled，c 就绪', () => {
    const g = loopGraph(3)
    const result = nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'working')]), new Set(['a', 'b']), { b: 3 })
    expect(result.ready).not.toContain('b')
    expect(result.ready).toContain('c')
    expect(isFlowComplete(g, facts([delivery('b', 'working')]), new Set(['a', 'b', 'c']), { b: 3 })).toBe(true)
  })
})

describe('BL-06 交付判定：completed 即交付（不要求产出非空）', () => {
  it('completed 且 outputs 为空的子任务计入交付；未完成的不计入', () => {
    const delivered = deliveredGraphNodes([
      { nodeId: 'a', state: 'completed' },
      { nodeId: 'b', state: 'waiting' },
      { nodeId: 'c', state: 'blocked' }
    ])
    expect([...delivered]).toEqual(['a'])
  })
  it('上游零输出完成后下游就绪（可选输出未产出是合法完成）', () => {
    const g = graph([node('a'), node('b')], [dataEdge('a', 'b')], 'a', ['b'])
    const delivered = deliveredGraphNodes([{ nodeId: 'a', state: 'completed' }])
    // a 没有任何交付输出（facts 为空），但已 completed → b 就绪
    expect(nextReadyNodes(g, facts([]), delivered).ready).toEqual(['b'])
  })
})

describe('BL-07 现状记录：带回边的多节点环在 v1 路由下不可执行', () => {
  // 该图会被 validateFlowGraph 以 LOOP_BODY_UNSUPPORTED 拒绝；这里只用 schema 解析，
  // 记录拒绝的原因：环内 c 要等载体 b settled（循环结束）才就绪，循环过程中 c 从不运行。
  const g = graph(
    [
      node('a'),
      node('b', {
        joinPolicy: 'any',
        loop: {
          maxIterations: 3,
          exitCondition: [{ kind: 'output-field', stageKey: 'b', path: 'text', op: 'equals', value: 'done' }]
        }
      }),
      node('c')
    ],
    [dataEdge('a', 'b'), dataEdge('b', 'c'), dataEdge('c', 'b')],
    'a',
    ['c']
  )
  it('b 未达退出条件时只会重复 b，c 不就绪', () => {
    const result = nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'working')]), new Set(['a', 'b']), { b: 1 })
    expect(result.ready).toContain('b')
    expect(result.ready).not.toContain('c')
  })
})

describe('BL-03 死路径消除与汇合', () => {
  const xor = (joinPolicy?: 'all' | 'any', exits: string[] = ['d']) =>
    graph(
      [node('a'), node('b'), node('c'), node('d', joinPolicy ? { joinPolicy } : {})],
      [dataEdge('a', 'b', eq('a', 'yes')), dataEdge('a', 'c', eq('a', 'no')), dataEdge('b', 'd'), dataEdge('c', 'd')],
      'a',
      exits
    )
  it('XOR 分支 + 缺省 all 汇合：未选分支跳过后汇合点就绪，流程能完成', () => {
    const g = xor()
    const f = facts([delivery('a', 'yes'), delivery('b', 'y')])
    const result = nextReadyNodes(g, f, new Set(['a', 'b']))
    expect(result.skipped).toEqual(['c'])
    expect(result.ready).toEqual(['d'])
    expect(isFlowComplete(g, f, new Set(['a', 'b', 'd']))).toBe(true)
  })
  it('跳过沿数据边传播：只依赖未选分支的下游也跳过', () => {
    const g = graph(
      [node('a'), node('b'), node('c'), node('e')],
      [dataEdge('a', 'b', eq('a', 'yes')), dataEdge('a', 'c', eq('a', 'no')), dataEdge('c', 'e')],
      'a',
      ['b', 'e']
    )
    const result = nextReadyNodes(g, facts([delivery('a', 'yes')]), new Set(['a']))
    expect(result.skipped.sort()).toEqual(['c', 'e'])
  })
  it('出口落在未选分支上：已选分支出口交付即完成', () => {
    const g = xor(undefined, ['b', 'c'])
    expect(isFlowComplete(g, facts([delivery('a', 'yes'), delivery('b', 'y')]), new Set(['a', 'b']))).toBe(true)
  })
  it('全部出口都被跳过：流程不算完成（宿主据此报停滞）', () => {
    const g = graph([node('a'), node('b')], [dataEdge('a', 'b', eq('a', 'never'))], 'a', ['b'])
    const f = facts([delivery('a', 'x')])
    expect(nextReadyNodes(g, f, new Set(['a'])).skipped).toEqual(['b'])
    expect(isFlowComplete(g, f, new Set(['a']))).toBe(false)
  })
  it('条件引用的节点尚未落定时不判死边（不提前跳过）', () => {
    const g = graph(
      [node('a'), node('b'), node('c'), node('d')],
      [dataEdge('a', 'b'), dataEdge('a', 'c'), dataEdge('b', 'd', eq('c', 'go'))],
      'a',
      ['d']
    )
    const early = nextReadyNodes(g, facts([delivery('a', 'x'), delivery('b', 'y')]), new Set(['a', 'b']))
    expect(early.skipped).toEqual([])
    expect(early.blocked.find((x) => x.nodeId === 'd')?.reason).toBe('INCOMING_EDGES_PENDING')
    const late = nextReadyNodes(
      g,
      facts([delivery('a', 'x'), delivery('b', 'y'), delivery('c', 'stop')]),
      new Set(['a', 'b', 'c'])
    )
    expect(late.skipped).toEqual(['d'])
  })
})

describe('BL-04 otherwise 边与多值歧义', () => {
  const g = graph(
    [node('a'), node('b'), node('c')],
    [dataEdge('a', 'b', eq('a', 'yes')), { ...dataEdge('a', 'c'), otherwise: true }],
    'a',
    ['b', 'c']
  )
  it('条件不成立 → otherwise 分支就绪，条件分支跳过', () => {
    const result = nextReadyNodes(g, facts([delivery('a', 'no')]), new Set(['a']))
    expect(result.ready).toEqual(['c'])
    expect(result.skipped).toEqual(['b'])
  })
  it('条件成立 → 条件分支就绪，otherwise 分支跳过', () => {
    const result = nextReadyNodes(g, facts([delivery('a', 'yes')]), new Set(['a']))
    expect(result.ready).toEqual(['b'])
    expect(result.skipped).toEqual(['c'])
  })
  it('多值交付同时命中两个互斥分支 → ambiguous（宿主拒绝推进）', () => {
    const xor = graph(
      [node('a'), node('b'), node('c')],
      [dataEdge('a', 'b', eq('a', 'yes')), dataEdge('a', 'c', eq('a', 'no'))],
      'a',
      ['b', 'c']
    )
    const twoValues: StageDeliveryFact = {
      stageKey: 'a',
      nodeId: 'a',
      outputs: [{ kind: 'text', text: 'yes' }, { kind: 'text', text: 'no' }],
      humanDecided: false
    }
    expect(nextReadyNodes(xor, facts([twoValues]), new Set(['a'])).ambiguous).toEqual(['a'])
  })
})

