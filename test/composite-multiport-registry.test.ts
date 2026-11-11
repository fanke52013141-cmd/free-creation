// W3 回归：组合能力公开端口允许同类型多输入/多输出（稳定 ID 映射）。
// 真实缺陷：getNodePorts 曾只对 code 节点豁免同类型重复，导致多输出节点流
// 实例在渲染层抛「输出端口类型重复」，graph.patch 桌面握手变成 OUTCOME_UNKNOWN。
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodePorts, getNodeType } from '@renderer/nodes/registry'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { CompositeManifest } from '@shared/composite/manifest'

beforeAll(() => {
  registerAllNodeTypes()
})

function multiManifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'multi-out',
    version: '1.0',
    name: '多输出',
    inputs: [
      { id: 'a', label: '甲输入', type: 'text', required: true, cardinality: 'one', targets: [{ nodeId: 'n1', portId: 'in-text' }] },
      { id: 'b', label: '乙输入', type: 'text', required: false, cardinality: 'one', targets: [{ nodeId: 'n2', portId: 'in-text' }] }
    ],
    outputs: [
      { id: 'o1', label: '甲', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } },
      { id: 'o2', label: '乙', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n2', portId: 'out-text' } }
    ],
    graph: { nodes: [], edges: [] },
    dependencies: []
  }
}

function shape(config: string, meta?: Record<string, unknown>): NodeCardShape {
  return { props: { config }, meta: meta ?? {} } as unknown as NodeCardShape
}

describe('composite 公开端口 · 同类型多端口', () => {
  it('内嵌 manifest 的两个 text 输出与两个 text 输入全部解析为稳定端口', () => {
    const spec = getNodeType('composite')!
    const ports = getNodePorts(spec, shape(JSON.stringify({ manifest: multiManifest() })))
    expect(ports.out.map((p) => p.id)).toEqual(['out-o1', 'out-o2'])
    expect(ports.in.map((p) => p.id)).toEqual(['in-a', 'in-b'])
    expect(ports.out.every((p) => p.type === 'text')).toBe(true)
  })

  it('引用形态从 meta 缓存快照解析同样的多端口', () => {
    const spec = getNodeType('composite')!
    const ports = getNodePorts(
      spec,
      shape(JSON.stringify({ capabilityId: 'multi-out', version: '1.0' }), {
        compositeManifest: multiManifest()
      })
    )
    expect(ports.out.map((p) => p.id)).toEqual(['out-o1', 'out-o2'])
    expect(ports.in.map((p) => p.id)).toEqual(['in-a', 'in-b'])
  })

  it('其它动态端口节点仍遵守同类型单端口规则（豁免不扩散）', () => {
    const spec = getNodeType('code')!
    expect(spec.resolvePorts).toBeDefined()
    // code 节点本身允许具名重复；用一个非 code/composite 的静态规格验证规则仍在。
    const textSpec = getNodeType('text')!
    expect(() =>
      getNodePorts(
        {
          ...textSpec,
          resolvePorts: () => ({
            in: [],
            out: [
              { id: 'out-x', name: 'X', dir: 'out', type: 'text', required: true, cardinality: 'one', description: 'X' },
              { id: 'out-y', name: 'Y', dir: 'out', type: 'text', required: true, cardinality: 'one', description: 'Y' }
            ]
          })
        },
        shape('{}')
      )
    ).toThrow(/输出端口类型重复/)
  })
})