import { describe, expect, it } from 'vitest'
import { parseCompositeManifest, type CompositeManifest } from '../src/shared/composite/manifest'
import {
  COMPOSITE_MAX_CONCURRENCY,
  compositeDownstreamOf,
  compositePredecessors,
  nextSchedulableNodes,
  resolveCompositeExecutionPolicy
} from '../src/shared/composite/policy'

function sampleManifest(policy?: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'policy-demo',
    version: '1.0',
    name: '策略演示',
    inputs: [],
    outputs: [
      {
        id: 'out',
        label: '输出',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'd', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [
        textNode('a'),
        textNode('b'),
        {
          id: 'c',
          nodeType: 'processor',
          contractVersion: 1,
          title: 'C',
          dx: 0,
          dy: 0,
          w: 340,
          h: 200,
          ports: [
            { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: 'many' },
            { id: 'out-text', name: '输出', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ]
        },
        textNode('d')
      ],
      edges: [
        { from: { nodeId: 'a', portId: 'out-text' }, to: { nodeId: 'c', portId: 'in-text' }, order: 2 },
        { from: { nodeId: 'b', portId: 'out-text' }, to: { nodeId: 'c', portId: 'in-text' }, order: 1 },
        { from: { nodeId: 'c', portId: 'out-text' }, to: { nodeId: 'd', portId: 'in-text' } }
      ]
    },
    ...(policy ? { executionPolicy: policy } : {})
  }
}

function textNode(id: string): unknown {
  return {
    id,
    nodeType: 'text',
    contractVersion: 1,
    title: id.toUpperCase(),
    dx: 0,
    dy: 0,
    w: 340,
    h: 200,
    ports: [
      { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
      { id: 'out-text', name: '输出', dir: 'out', type: 'text', required: true, cardinality: 'one' }
    ]
  }
}

function parsed(policy?: Record<string, unknown>): CompositeManifest {
  const result = parseCompositeManifest(sampleManifest(policy))
  if (!result.ok) throw new Error(`MANIFEST_INVALID:${JSON.stringify(result.issues)}`)
  return result.manifest
}

describe('BL-33 NF-8.4 / NF-8.5 运行策略', () => {
  it('缺省为 fail-fast + 串行（1）', () => {
    expect(resolveCompositeExecutionPolicy(undefined)).toEqual({
      onBranchFailure: 'fail-fast',
      maxConcurrency: 1
    })
    expect(resolveCompositeExecutionPolicy(parsed().executionPolicy)).toEqual({
      onBranchFailure: 'fail-fast',
      maxConcurrency: 1
    })
  })

  it('解析声明的策略并把并发夹到 1–4', () => {
    expect(resolveCompositeExecutionPolicy({ onBranchFailure: 'continue', maxConcurrency: 3 })).toEqual({
      onBranchFailure: 'continue',
      maxConcurrency: 3
    })
    expect(resolveCompositeExecutionPolicy({ maxConcurrency: COMPOSITE_MAX_CONCURRENCY }).maxConcurrency).toBe(
      COMPOSITE_MAX_CONCURRENCY
    )
    // 越界值不进入运行时（schema 会先拒绝新发布；这里防御历史 JSON）。
    expect(resolveCompositeExecutionPolicy({ maxConcurrency: 99 }).maxConcurrency).toBe(
      COMPOSITE_MAX_CONCURRENCY
    )
    expect(resolveCompositeExecutionPolicy({ maxConcurrency: 0 }).maxConcurrency).toBe(1)
  })

  it('schema 接受合法策略并保留边上的扇入 order', () => {
    const manifest = parsed({ onBranchFailure: 'continue', maxConcurrency: 2, waitForInput: true })
    expect(manifest.executionPolicy).toMatchObject({ onBranchFailure: 'continue', maxConcurrency: 2 })
    expect(manifest.graph.edges[0]?.order).toBe(2)
    expect(manifest.graph.edges[1]?.order).toBe(1)
  })

  it('schema 拒绝越界并发与未知失败策略', () => {
    for (const policy of [
      { maxConcurrency: 0 },
      { maxConcurrency: 5 },
      { maxConcurrency: 2.5 },
      { onBranchFailure: 'ignore' }
    ]) {
      const result = parseCompositeManifest(sampleManifest(policy))
      expect(result.ok).toBe(false)
    }
  })

  it('前驱与传递下游：失败只阻塞失败分支的下游', () => {
    const manifest = parsed()
    const predecessors = compositePredecessors({ graph: manifest.graph })
    expect([...(predecessors.get('c') ?? [])].sort()).toEqual(['a', 'b'])
    expect([...(predecessors.get('d') ?? [])].sort()).toEqual(['c'])
    const downstream = compositeDownstreamOf('a', predecessors)
    expect([...downstream].sort()).toEqual(['c', 'd'])
    // 兄弟分支不受影响。
    expect(downstream.has('b')).toBe(false)
  })

  it('按拓扑顺序给出就绪批次，受 settled / blocked / running / limit 约束', () => {
    const manifest = parsed()
    const predecessors = compositePredecessors({ graph: manifest.graph })
    const order = ['a', 'b', 'c', 'd']
    const settled = new Set<string>()
    const blocked = new Set<string>()
    const running = new Set<string>()

    expect(
      nextSchedulableNodes(order, predecessors, { settled, blocked, running, limit: 2 })
    ).toEqual(['a', 'b'])
    // 并发上限为 1 时只给一个，且顺序与拓扑一致（不按完成时间）。
    expect(
      nextSchedulableNodes(order, predecessors, { settled, blocked, running, limit: 1 })
    ).toEqual(['a'])
    settled.add('a')
    settled.add('b')
    expect(
      nextSchedulableNodes(order, predecessors, { settled, blocked, running, limit: 2 })
    ).toEqual(['c'])
    // c 被阻塞：d 的前驱未落定，二者都不应再调度。
    blocked.add('c')
    expect(nextSchedulableNodes(order, predecessors, { settled, blocked, running, limit: 4 })).toEqual(
      []
    )
  })
})