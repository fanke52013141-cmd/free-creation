import { describe, expect, it } from 'vitest'
import {
  FlowGraphSchema,
  validateFlowGraph,
  type FlowGraph,
  type FlowNode
} from '../src/shared/agent-flow/flow-graph'
import { nextReadyNodes } from '../src/shared/agent-flow/flow-graph-router'
import {
  compileFlowGraph,
  FlowGraphCompileError
} from '../src/shared/agent-flow/flow-graph-compiler'
import { diffGraphDefinitions } from '../src/shared/agent-flow/flow-definition'
import type { StageEntryFacts } from '../src/shared/agent-flow/stage-contracts'

const cap = (nodeId: string, extra: Partial<FlowNode> = {}): FlowNode => ({
  nodeId,
  title: nodeId,
  participation: 'autonomous',
  kind: 'capability',
  capabilityRef: { kind: 'node', id: 'text-pass', version: '1' },
  goal: '处理',
  completion: '交付',
  ...extra
})
const human = (nodeId: string, extra: Partial<FlowNode> = {}): FlowNode => ({
  nodeId,
  title: nodeId,
  participation: 'human',
  kind: 'human-task',
  goal: '人工输入',
  completion: '人工交付',
  ...extra
})
const graph = (
  nodes: FlowNode[],
  edges: FlowGraph['edges'],
  entry: string,
  exits: string[],
  extra: Partial<FlowGraph> = {}
): FlowGraph => FlowGraphSchema.parse({
  schemaVersion: 1,
  graphId: 'second-round',
  name: 'second round',
  goal: '回归',
  nodes,
  edges,
  entry,
  exits,
  ...extra
})
const edge = (
  from: string,
  to: string,
  fromPort = 'out-value',
  toPort = 'in-value',
  extra: Partial<FlowGraph['edges'][number]> = {}
): FlowGraph['edges'][number] => ({
  from: { nodeId: from, portId: fromPort },
  to: { nodeId: to, portId: toPort },
  ...extra
})
const loopGraph = (joinPolicy: 'all' | 'any' = 'all'): FlowGraph => graph([
  human('a', { humanOutputType: 'text' }),
  human('l', {
    humanOutputType: 'text',
    joinPolicy,
    loop: {
      body: ['l', 'b'],
      maxIterations: 2,
      exitCondition: [{ kind: 'output-field', stageKey: 'b', path: 'text', op: 'exists' }]
    }
  }),
  cap('m'),
  cap('b')
], [
  edge('a', 'l', 'out-text', 'in-text', {
    condition: [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'equals', value: 'yes' }]
  }),
  edge('a', 'm', 'out-text', 'in-value', {
    condition: [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'equals', value: 'no' }]
  }),
  edge('m', 'l', 'out-value', 'in-text'),
  edge('l', 'b', 'out-text'),
  edge('b', 'l', 'out-value', 'in-text')
], 'a', ['b'])
const routeFacts = (text: string): StageEntryFacts => ({
  deliveries: [{ stageKey: 'a', nodeId: 'a', outputs: [{ kind: 'text', text }], humanDecided: true }],
  reviews: []
})

describe('第二轮图路由回归', () => {
  it('循环载体接受体外 satisfied+dead，不再把未选分支当成阻塞', () => {
    const g = loopGraph()
    expect(validateFlowGraph(g)).toEqual({ ok: true })
    const route = nextReadyNodes(g, routeFacts('yes'), new Set(['a']))
    expect(route.ready).toContain('l')
    expect(route.skipped).toContain('m')
  })

  it('循环载体 joinPolicy=any 在另一条体外输入 pending 时仍可进入', () => {
    const g = loopGraph('any')
    g.edges[1]!.condition = undefined
    const route = nextReadyNodes(g, routeFacts('yes'), new Set(['a']))
    expect(route.ready).toContain('m')
    expect(route.ready).toContain('l')
  })

  it('所有体外条件均不成立时，载体和循环体沿 dead 路径整体跳过', () => {
    const route = nextReadyNodes(loopGraph(), routeFacts('neither'), new Set(['a']))
    expect(route.ready).toEqual([])
    expect(route.skipped).toEqual(expect.arrayContaining(['m', 'l', 'b']))
  })
})

describe('第二轮真实端口与 ID/边校验', () => {
  it('human-task 缺省只开放 out-text；显式 json 才开放 out-json', () => {
    const invalid = graph(
      [human('h'), cap('c')],
      [edge('h', 'c', 'out-json')],
      'h',
      ['c']
    )
    expect(validateFlowGraph(invalid)).toMatchObject({
      ok: false,
      errors: [{ code: 'PORT_NOT_FOUND', nodeId: 'h' }]
    })
    expect(() => compileFlowGraph(invalid)).toThrow(FlowGraphCompileError)

    const explicitJson = graph(
      [human('h', { humanOutputType: 'json' }), cap('c')],
      [edge('h', 'c', 'out-json')],
      'h',
      ['c']
    )
    expect(validateFlowGraph(explicitJson)).toEqual({ ok: true })
    const defaultText = graph(
      [human('h'), cap('c')],
      [edge('h', 'c', 'out-text')],
      'h',
      ['c']
    )
    expect(validateFlowGraph(defaultText)).toEqual({ ok: true })
  })

  it('语义 ID 映射碰撞与派生协调器碰撞均返回 NODE_ID_COLLISION', () => {
    for (const g of [
      graph([cap('a:b'), cap('a.b')], [edge('a:b', 'a.b')], 'a:b', ['a.b']),
      graph([cap('coordinator-second-round'), cap('b')], [edge('coordinator-second-round', 'b')], 'coordinator-second-round', ['b'])
    ]) {
      expect(validateFlowGraph(g)).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({ code: 'NODE_ID_COLLISION' })]
      })
      try {
        compileFlowGraph(g)
        throw new Error('expected compile failure')
      } catch (error) {
        expect(error).toBeInstanceOf(FlowGraphCompileError)
        expect((error as FlowGraphCompileError).errors)
          .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'NODE_ID_COLLISION' })]))
      }
    }
  })

  it('重复边和 cardinality=one 多连在 validate 拒绝，many 正向不受影响', () => {
    const duplicate = graph([cap('a'), cap('b')], [edge('a', 'b'), edge('a', 'b')], 'a', ['b'])
    expect(validateFlowGraph(duplicate)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'EDGE_DUPLICATE' })]
    })
    const single = graph(
      [cap('a'), cap('b'), cap('c')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'c')],
      'a',
      ['c']
    )
    expect(validateFlowGraph(single)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'PORT_CARDINALITY', nodeId: 'c' })]
    })
    const many = graph(
      [cap('a'), cap('b'), human('h', { humanOutputType: 'text' })],
      [edge('a', 'b'), edge('a', 'h', 'out-value', 'in-text'), edge('b', 'h', 'out-value', 'in-text')],
      'a',
      ['h']
    )
    expect(validateFlowGraph(many)).toEqual({ ok: true })
  })
})

describe('第二轮定义 diff', () => {
  it('entry/exits/roles 变化均可见，相同定义不产生伪差异', () => {
    const before = graph(
      [cap('a'), cap('b'), cap('c')],
      [edge('a', 'b'), edge('a', 'c')],
      'a',
      ['b']
    )
    const after = graph(
      [cap('a'), cap('b'), cap('c')],
      [edge('a', 'b'), edge('a', 'c')],
      'a',
      ['c'],
      { roles: [{ roleId: 'owner', name: '我' }] }
    )
    expect(diffGraphDefinitions(
      { name: before.name, graph: before },
      { name: after.name, graph: after }
    )).toMatchObject({
      entryChanged: false,
      exitsChanged: true,
      rolesChanged: true,
      budgetsChanged: false,
      nodes: []
    })
    const movedEntry = graph(before.nodes, before.edges, 'b', before.exits)
    expect(diffGraphDefinitions(
      { name: before.name, graph: before },
      { name: before.name, graph: movedEntry }
    ).entryChanged).toBe(true)
    expect(diffGraphDefinitions(
      { name: before.name, graph: before },
      { name: before.name, graph: before }
    )).toMatchObject({
      entryChanged: false,
      exitsChanged: false,
      rolesChanged: false,
      budgetsChanged: false,
      nodes: []
    })
  })
})
