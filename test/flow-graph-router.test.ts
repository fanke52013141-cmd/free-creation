// O4-P3 声明式图路由：顺序/条件分支/汇合（all/any）；路由只认交付事实，模型文字不能改路由。
import { describe, expect, it } from 'vitest'
import { nextReadyNodes, isFlowComplete } from '../src/shared/agent-flow/flow-graph-router'
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
  it('a 交付 yes → 走 b 分支，c 阻塞', () => {
    const result = nextReadyNodes(g, facts([delivery('a', 'yes')]), new Set(['a']))
    expect(result.ready).toEqual(['b'])
    expect(result.blocked.some((x) => x.nodeId === 'c')).toBe(true)
  })
  it('a 交付 no → 走 c 分支，b 阻塞', () => {
    const result = nextReadyNodes(g, facts([delivery('a', 'no')]), new Set(['a']))
    expect(result.ready).toEqual(['c'])
    expect(result.blocked.some((x) => x.nodeId === 'b')).toBe(true)
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