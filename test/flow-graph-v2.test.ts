import { describe, expect, it } from 'vitest'
import type { CompositeVersionRecord } from '../src/shared/composite/types'
import {
  FlowGraphSchema,
  validateFlowGraph,
  type FlowGraph,
  type FlowNode
} from '../src/shared/agent-flow/flow-graph'
import { compileFlowGraph } from '../src/shared/agent-flow/flow-graph-compiler'
import { buildCapabilityCatalog } from '../src/shared/agent-flow/capability-catalog'

const validateFlowGraphTopology = (
  value: FlowGraph,
  options: Parameters<typeof validateFlowGraph>[1] = {}
) => validateFlowGraph(value, { ...options, requireRuntime: false })

const HASH = 'b'.repeat(64)

const agent = (nodeId: string): FlowNode => ({
  nodeId,
  title: nodeId,
  participation: 'autonomous',
  kind: 'agent',
  goal: `目标 ${nodeId}`,
  completion: `完成 ${nodeId}`
})

const capability = (
  nodeId: string,
  id: string,
  version: string,
  extra: Partial<FlowNode> = {}
): FlowNode => ({
  nodeId,
  title: nodeId,
  participation: 'autonomous',
  kind: 'capability',
  capabilityRef: { kind: 'node', id, version },
  goal: `目标 ${nodeId}`,
  completion: `完成 ${nodeId}`,
  ...extra
})

const edge = (from: string, fromPort: string, to: string, toPort: string): FlowGraph['edges'][number] => ({
  from: { nodeId: from, portId: fromPort },
  to: { nodeId: to, portId: toPort },
  kind: 'data'
})

function graph(
  nodes: FlowNode[],
  edges: FlowGraph['edges'],
  entry: string,
  exits: string[]
): FlowGraph {
  return FlowGraphSchema.parse({
    schemaVersion: 1,
    graphId: 'v2-graph',
    name: 'v2 图',
    goal: '验证 FlowGraph v2',
    nodes,
    edges,
    entry,
    exits
  })
}

const compositeRecord: CompositeVersionRecord = {
  capabilityId: 'material-flow',
  version: '1.0',
  contentHash: HASH,
  publishedAt: 1,
  manifest: {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'material-flow',
    version: '1.0',
    name: '材料整理流',
    inputs: [
      {
        id: 'source',
        label: '来源',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'result',
        label: '结果',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'text',
          contractVersion: 3,
          title: '整理',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          ports: []
        }
      ],
      edges: []
    },
    executionPolicy: { waitForInput: true },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
  }
}

describe('BL-11 FlowGraph v2：params / 真实端口 / 子图循环', () => {
  it('params 合并进目标节点固定配置（模型/比例/张数生效）', () => {
    const g = graph(
      [
        agent('a'),
        capability('img', 'image-gen', '3', {
          params: { modelKey: 'model-x', aspectRatio: '16:9', count: 2 }
        })
      ],
      [edge('a', 'out-text', 'img', 'in-text')],
      'a',
      ['img']
    )
    expect(validateFlowGraphTopology(g)).toEqual({ ok: true })
    const compiled = compileFlowGraph(g)
    const img = compiled.nodes.find((node) => node.id === 'shape:img')!
    expect(JSON.parse(img.config)).toMatchObject({
      modelKey: 'model-x',
      aspectRatio: '16:9',
      count: 2
    })
  })

  it('params 非法、复合能力带 params、非能力节点带 params 都被拒绝', () => {
    const bad = graph(
      [
        agent('a'),
        capability('img', 'image-gen', '3', { params: { count: 99 } })
      ],
      [edge('a', 'out-text', 'img', 'in-text')],
      'a',
      ['img']
    )
    const invalid = validateFlowGraphTopology(bad)
    expect(invalid.ok).toBe(false)
    if (!invalid.ok)
      expect(invalid.errors.some((error) => error.code === 'CAPABILITY_PARAMS_INVALID')).toBe(true)

    const composite = graph(
      [
        agent('a'),
        capability('flow', 'material-flow', '1.0', {
          params: { x: 1 },
          capabilityRef: { kind: 'composite', id: 'material-flow', version: '1.0' }
        })
      ],
      [edge('a', 'out-text', 'flow', 'in-source')],
      'a',
      ['flow']
    )
    const catalog = buildCapabilityCatalog([compositeRecord])
    const compositeResult = validateFlowGraphTopology(composite, { catalog })
    expect(compositeResult.ok).toBe(false)
    if (!compositeResult.ok)
      expect(
        compositeResult.errors.some((error) => error.code === 'CAPABILITY_PARAMS_UNSUPPORTED')
      ).toBe(true)

    // schema 层：非 capability 节点声明 params 直接失败。
    expect(
      FlowGraphSchema.safeParse({
        schemaVersion: 1,
        graphId: 'g',
        name: 'n',
        goal: 'g',
        nodes: [{ ...agent('a'), params: { x: 1 } }],
        edges: [],
        entry: 'a',
        exits: ['a']
      }).success
    ).toBe(false)
  })

  it('数据边必须使用真实端口；类型不兼容在编译前拒绝', () => {
    const unknown = graph(
      [agent('a'), capability('img', 'image-gen', '3')],
      [edge('a', 'out-text', 'img', 'in-nope')],
      'a',
      ['img']
    )
    const unknownResult = validateFlowGraphTopology(unknown)
    expect(unknownResult.ok).toBe(false)
    if (!unknownResult.ok)
      expect(unknownResult.errors.some((error) => error.code === 'PORT_NOT_FOUND')).toBe(true)

    const mismatch = graph(
      [agent('a'), capability('video', 'video', '7')],
      [edge('a', 'out-text', 'video', 'in-images')],
      'a',
      ['video']
    )
    const mismatchResult = validateFlowGraphTopology(mismatch)
    expect(mismatchResult.ok).toBe(false)
    if (!mismatchResult.ok)
      expect(mismatchResult.errors.some((error) => error.code === 'PORT_TYPE_MISMATCH')).toBe(true)
  })

  it('v1 多节点环仍拒绝；v2 三节点循环体通过并重映射 body', () => {
    const v1 = graph(
      [
        { ...agent('a'), loop: { maxIterations: 2, exitCondition: [{ kind: 'output-field', stageKey: 'c', path: 'text', op: 'exists' }] } },
        agent('b'),
        agent('c')
      ],
      [edge('a', 'out-text', 'b', 'in-text'), edge('b', 'out-text', 'c', 'in-text'), edge('c', 'out-text', 'a', 'in-text')],
      'a',
      ['c']
    )
    const v1Result = validateFlowGraphTopology(v1)
    expect(v1Result.ok).toBe(false)
    if (!v1Result.ok)
      expect(v1Result.errors.some((error) => error.code === 'LOOP_BODY_UNSUPPORTED')).toBe(true)

    const v2 = graph(
      [
        {
          ...agent('a'),
          loop: {
            body: ['a', 'b', 'c'],
            maxIterations: 2,
            exitCondition: [
              { kind: 'output-field', stageKey: 'c', path: 'text', op: 'equals', value: 'done' }
            ]
          }
        },
        agent('b'),
        agent('c')
      ],
      [edge('a', 'out-text', 'b', 'in-text'), edge('b', 'out-text', 'c', 'in-text'), edge('c', 'out-text', 'a', 'in-text')],
      'a',
      ['c']
    )
    expect(validateFlowGraphTopology(v2)).toEqual({ ok: true })
    expect(validateFlowGraphTopology({ ...v2, budgets: { ...v2.budgets, maxSteps: 5 } })).toEqual({
      ok: false,
      errors: [{ code: 'STEP_BUDGET_INSUFFICIENT', message: 'maxSteps 5 must be at least 6' }]
    })
    expect(validateFlowGraphTopology({ ...v2, budgets: { ...v2.budgets, maxSteps: 6 } })).toEqual({ ok: true })
    const compiled = compileFlowGraph(v2)
    const carrier = compiled.nodes.find((node) => node.id === 'shape:a')!
    expect(JSON.parse(carrier.config)).toBeTruthy()
    // body 与 exitCondition 一样重映射为画布 shape id。
    expect(compiled.edges.map((item) => item.from.portId)).toEqual([
      'out-text',
      'out-text',
      'out-text'
    ])
    const runGraph = JSON.parse(
      compiled.nodes.find((node) => node.id === compiled.coordinatorNodeId)!.config
    ).graph as FlowGraph
    expect(runGraph.nodes.find((node) => node.nodeId === 'shape:a')!.loop!.body).toEqual([
      'shape:a',
      'shape:b',
      'shape:c'
    ])
  })

  it('循环体缺少载体/没有出口时明确拒绝', () => {
    const noCarrier = graph(
      [
        agent('a'),
        {
          ...agent('b'),
          loop: {
            body: ['a'],
            maxIterations: 2,
            exitCondition: [{ kind: 'output-field', stageKey: 'a', path: 'text', op: 'exists' }]
          }
        }
      ],
      [edge('a', 'out-text', 'b', 'in-text')],
      'a',
      ['b']
    )
    const noCarrierResult = validateFlowGraphTopology(noCarrier)
    expect(noCarrierResult.ok).toBe(false)
    if (!noCarrierResult.ok)
      expect(noCarrierResult.errors.some((error) => error.code === 'LOOP_BODY_INVALID')).toBe(true)

    const noExit = graph(
      [
        {
          ...agent('a'),
          loop: {
            body: ['a', 'b'],
            maxIterations: 2,
            exitCondition: [{ kind: 'output-field', stageKey: 'b', path: 'text', op: 'exists' }]
          }
        },
        agent('b'),
        agent('c')
      ],
      [edge('a', 'out-text', 'b', 'in-text')],
      'a',
      ['c']
    )
    const noExitResult = validateFlowGraphTopology(noExit)
    expect(noExitResult.ok).toBe(false)
    if (!noExitResult.ok)
      expect(noExitResult.errors.some((error) => error.code === 'LOOP_BODY_NO_EXIT')).toBe(true)
  })

  it('V14 × BL-21：声明 roles 时，显式 decider=human 的能力节点必须声明 humanRole，纯 AI 节点禁止声明', () => {
    const withRoles = (capExtra: Partial<FlowNode> = {}): FlowGraph =>
      FlowGraphSchema.parse({
        schemaVersion: 1,
        graphId: 'v2-role-decider',
        name: '角色与人工采用校验',
        goal: '验证 capability decider=human 的角色归属',
        roles: [
          { roleId: 'editor', name: '编辑' },
          { roleId: 'reviewer', name: '审校' }
        ],
        nodes: [
          agent('entry'),
          capability('cap', 'image-gen', '3', capExtra)
        ],
        edges: [edge('entry', 'out-text', 'cap', 'in-text')],
        entry: 'entry',
        exits: ['cap']
      })

    // decider='human' 缺少 humanRole → HUMAN_ROLE_REQUIRED
    const missingRole = validateFlowGraphTopology(withRoles({ decider: 'human' }))
    expect(missingRole.ok).toBe(false)
    if (!missingRole.ok)
      expect(missingRole.errors.map((e) => e.code)).toContain('HUMAN_ROLE_REQUIRED')

    // decider='human' 声明合法 humanRole → 通过（不再误报 HUMAN_ROLE_UNEXPECTED）
    expect(
      validateFlowGraphTopology(withRoles({ decider: 'human', humanRole: 'reviewer' }))
    ).toEqual({ ok: true })

    // 纯 AI（decider 缺省 none）声明 humanRole → HUMAN_ROLE_UNEXPECTED
    const unexpectedRole = validateFlowGraphTopology(withRoles({ humanRole: 'editor' }))
    expect(unexpectedRole.ok).toBe(false)
    if (!unexpectedRole.ok)
      expect(unexpectedRole.errors.map((e) => e.code)).toContain('HUMAN_ROLE_UNEXPECTED')
  })
})
