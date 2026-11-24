import { describe, expect, it } from 'vitest'
import type { CompositeVersionRecord } from '../src/shared/composite/types'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import { ACTIVE_NODE_TYPE_IDS } from '../src/shared/types'
import { GENERATED_NODE_CONTRACTS } from '../src/shared/agent-access/generated/node-contracts.generated'
import {
  buildCapabilityCatalog,
  capabilityCatalogDto,
  capabilityRefKey,
  compositeCapabilityDescriptor,
  findCapability,
  nodeCapabilityDescriptors,
  parseLegacyCapability,
  planCapabilityCatalog
} from '../src/shared/agent-flow/capability-catalog'
import {
  FlowGraphSchema,
  validateFlowGraph,
  type FlowGraph
} from '../src/shared/agent-flow/flow-graph'
import {
  compileFlowGraph,
  FlowGraphCompileError
} from '../src/shared/agent-flow/flow-graph-compiler'

const HASH = 'a'.repeat(64)

function manifest(overrides: Partial<CompositeManifest> = {}): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'material-flow',
    version: '1.0',
    name: '材料整理流',
    description: '把来源材料整理成一份可交付文本',
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
          ports: [
            {
              id: 'in-text',
              name: '文本',
              dir: 'in',
              type: 'text',
              required: false,
              cardinality: 'many'
            },
            {
              id: 'out-text',
              name: '文本',
              dir: 'out',
              type: 'text',
              required: true,
              cardinality: 'one'
            }
          ]
        }
      ],
      edges: []
    },
    executionPolicy: { waitForInput: true },
    ...overrides
  }
}

function record(overrides: Partial<CompositeManifest> = {}): CompositeVersionRecord {
  return {
    capabilityId: 'material-flow',
    version: '1.0',
    manifest: manifest(overrides),
    contentHash: HASH,
    publishedAt: 1
  }
}

function graph(
  nodes: FlowGraph['nodes'],
  edges: FlowGraph['edges'],
  entry = 'a',
  exits = ['b']
): FlowGraph {
  return FlowGraphSchema.parse({
    schemaVersion: 1,
    graphId: 'capability-graph',
    name: '能力图',
    goal: '验证能力目录与编译',
    nodes,
    edges,
    entry,
    exits
  })
}

function errorCode(
  g: FlowGraph,
  catalog?: ReturnType<typeof buildCapabilityCatalog>
): string | undefined {
  const result = validateFlowGraph(g, catalog ? { catalog } : {})
  if (result.ok) throw new Error('expected validation errors')
  return result.errors[0]?.code
}

const agentNode = (id: string): FlowGraph['nodes'][number] => ({
  nodeId: id,
  title: id,
  participation: 'autonomous',
  kind: 'agent',
  goal: `目标 ${id}`,
  completion: `完成 ${id}`
})

const compositeCapabilityNode = (id: string): FlowGraph['nodes'][number] => ({
  nodeId: id,
  title: id,
  participation: 'autonomous',
  kind: 'capability',
  capabilityRef: { kind: 'composite', id: 'material-flow', version: '1.0' },
  goal: `目标 ${id}`,
  completion: `完成 ${id}`
})

describe('BL-10 能力目录（节点注册表 + 已发布节点流）', () => {
  it('每个 Active 节点类型都有一条能力描述，契约版本与导出快照一致', () => {
    const descriptors = nodeCapabilityDescriptors()
    const byId = new Map(descriptors.map((descriptor) => [descriptor.capabilityRef.id, descriptor]))
    for (const typeId of ACTIVE_NODE_TYPE_IDS) {
      const record = GENERATED_NODE_CONTRACTS.find((item) => item.typeId === typeId)!
      const descriptor = byId.get(typeId)
      expect(descriptor, typeId).toBeTruthy()
      expect(descriptor!.capabilityRef).toEqual({
        kind: 'node',
        id: typeId,
        version: String(record.contractVersion)
      })
      expect(descriptor!.inputs.map((port) => port.portId)).toEqual(
        record.ports.in.map((port) => port.id)
      )
      expect(descriptor!.outputs.map((port) => port.portId)).toEqual(
        record.ports.out.map((port) => port.id)
      )
    }
  })

  it('媒体能力可调度且携带真实编译载体；其余节点如实标记不可调度原因', () => {
    const descriptors = nodeCapabilityDescriptors()
    const byType = new Map(
      descriptors.map((descriptor) => [descriptor.capabilityRef.id, descriptor])
    )
    expect(byType.get('image-gen')!.agentSchedulable).toBe(true)
    expect(byType.get('image-gen')!.carrier).toMatchObject({
      type: 'image-gen',
      contractVersion: 3,
      inputPort: 'in-text',
      outputPort: 'out-image'
    })
    expect(byType.get('text-template')!.carrier).toMatchObject({
      type: 'processor',
      inputPort: 'in-value',
      outputPort: 'out-value'
    })
    expect(byType.get('text')!.agentSchedulable).toBe(false)
    expect(byType.get('text')!.reason).toContain('尚未声明')
    expect(byType.get('text')!.carrier).toBeUndefined()
  })

  it('计划面按历史 7 项顺序生成，不维护第二份白名单', () => {
    expect(planCapabilityCatalog().map((item) => item.id)).toEqual([
      'text-template@1',
      'text-pass@1',
      'image-gen@3',
      'image-edit@2',
      'video@7',
      'speech@4',
      'tts@4'
    ])
  })

  it('节点流能力：公开端口、参与形态下限、成本/网络从内部节点推导', () => {
    const deep = record({
      executionPolicy: { waitForInput: true },
      graph: {
        nodes: [
          {
            id: 'n1',
            nodeType: 'image-gen',
            contractVersion: 3,
            title: '生图',
            dx: 0,
            dy: 0,
            w: 340,
            h: 300,
            ports: []
          }
        ],
        edges: []
      }
    })
    const descriptor = compositeCapabilityDescriptor(deep)
    expect(descriptor.capabilityRef).toEqual({
      kind: 'composite',
      id: 'material-flow',
      version: '1.0'
    })
    expect(descriptor.inputs.map((port) => port.portId)).toEqual(['in-source'])
    expect(descriptor.outputs.map((port) => port.portId)).toEqual(['out-result'])
    expect(descriptor.participation).toBe('collaborative')
    expect(descriptor.cost).toBe('certain')
    expect(descriptor.network).toBe('required')
    expect(descriptor.agentSchedulable).toBe(true)
    expect(descriptor.contentHash).toBe(HASH)
    expect(JSON.parse(descriptor.carrier!.config)).toMatchObject({
      capabilityId: 'material-flow',
      version: '1.0',
      contentHash: HASH
    })
  })

  it('含 human-task 的节点流推导为 collaborative 下限', () => {
    const human = record({
      executionPolicy: {},
      graph: {
        nodes: [
          {
            id: 'n1',
            nodeType: 'human-task',
            contractVersion: 1,
            title: '人工',
            dx: 0,
            dy: 0,
            w: 340,
            h: 300,
            ports: []
          }
        ],
        edges: []
      }
    })
    expect(compositeCapabilityDescriptor(human).participation).toBe('collaborative')
  })

  it('目录合并节点能力与已发布版本，旧 id@version 仍可解析；对外 DTO 不泄漏载体配置', () => {
    const catalog = buildCapabilityCatalog([record()])
    const composite = catalog.find((item) => item.capabilityRef.kind === 'composite')
    expect(composite).toBeTruthy()
    expect(
      findCapability(catalog, { kind: 'composite', id: 'material-flow', version: '1.0' })
    ).toBe(composite)
    expect(parseLegacyCapability('image-gen@3')).toEqual({
      kind: 'node',
      id: 'image-gen',
      version: '3'
    })
    expect(capabilityRefKey(composite!.capabilityRef)).toBe('composite:material-flow@1.0')
    const dto = capabilityCatalogDto(catalog).find(
      (item) => item.capabilityRef.kind === 'composite'
    )!
    expect(dto).not.toHaveProperty('carrier')
    expect(dto).not.toHaveProperty('builder')
    expect(JSON.stringify(dto)).not.toContain('"config"')
  })
})

describe('BL-10 FlowGraph 能力引用编译与准入', () => {
  it('节点能力按目录解析为真实载体并重映射边端口', () => {
    const g = graph(
      [
        agentNode('a'),
        {
          nodeId: 'b',
          title: 'b',
          participation: 'autonomous',
          kind: 'capability',
          capabilityRef: { kind: 'node', id: 'image-gen', version: '3' },
          goal: '生图',
          completion: '完成'
        }
      ],
      [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-text' } }]
    )
    const compiled = compileFlowGraph(g)
    const capability = compiled.nodes.find((node) => node.id === 'shape:b')!
    expect(capability.type).toBe('image-gen')
    expect(capability.contractVersion).toBe(3)
    expect(compiled.edges).toContainEqual({
      from: { nodeId: 'shape:a', portId: 'out-text' },
      to: { nodeId: 'shape:b', portId: 'in-text' }
    })
  })

  it('已发布节点流编译为 composite 实例，公开端口不重映射', () => {
    const catalog = buildCapabilityCatalog([record()])
    const g = graph(
      [agentNode('a'), { ...compositeCapabilityNode('b'), participation: 'collaborative' }],
      [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-source' } }]
    )
    expect(validateFlowGraph(g, { catalog }).ok).toBe(true)
    const compiled = compileFlowGraph(g, { catalog })
    const composite = compiled.nodes.find((node) => node.id === 'shape:b')!
    expect(composite.type).toBe('composite')
    expect(composite.contractVersion).toBe(1)
    expect(JSON.parse(composite.config)).toMatchObject({
      capabilityId: 'material-flow',
      version: '1.0',
      contentHash: HASH
    })
    expect(compiled.edges).toContainEqual({
      from: { nodeId: 'shape:a', portId: 'out-text' },
      to: { nodeId: 'shape:b', portId: 'in-source' }
    })
  })

  it('未知能力、不可调度能力与参与形态低于下限都在编译前拒绝', () => {
    const unknown = graph(
      [
        agentNode('a'),
        {
          nodeId: 'b',
          title: 'b',
          participation: 'autonomous',
          kind: 'capability',
          capabilityRef: { kind: 'node', id: 'nope', version: '1' },
          goal: 'x',
          completion: 'x'
        }
      ],
      [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-text' } }]
    )
    expect(errorCode(unknown)).toBe('CAPABILITY_UNKNOWN')

    const unschedulable = graph(
      [
        agentNode('a'),
        {
          nodeId: 'b',
          title: 'b',
          participation: 'autonomous',
          kind: 'capability',
          capabilityRef: { kind: 'node', id: 'text', version: '3' },
          goal: 'x',
          completion: 'x'
        }
      ],
      [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-text' } }]
    )
    expect(errorCode(unschedulable)).toBe('CAPABILITY_NOT_SCHEDULABLE')

    const catalog = buildCapabilityCatalog([record()])
    const belowFloor = graph(
      [agentNode('a'), compositeCapabilityNode('b')],
      [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-source' } }]
    )
    expect(errorCode(belowFloor, catalog)).toBe('CAPABILITY_PARTICIPATION_BELOW_FLOOR')
    const raised: FlowGraph = {
      ...belowFloor,
      nodes: belowFloor.nodes.map((node) =>
        node.nodeId === 'b' ? { ...node, participation: 'collaborative' as const } : node
      )
    }
    expect(validateFlowGraph(raised, { catalog }).ok).toBe(true)
    expect(() => compileFlowGraph(belowFloor, { catalog })).toThrow(FlowGraphCompileError)
  })

  it('旧 capability: id@version 仍按节点能力编译（兼容历史 JSON）', () => {
    const legacy = graph(
      [
        agentNode('a'),
        {
          nodeId: 'b',
          title: 'b',
          participation: 'autonomous',
          kind: 'capability',
          capability: 'text-pass@1',
          goal: 'pass',
          completion: 'done'
        }
      ],
      [{ from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'b', portId: 'in-value' } }]
    )
    const compiled = compileFlowGraph(legacy)
    expect(compiled.nodes.find((node) => node.id === 'shape:b')!.type).toBe('processor')
  })
})
