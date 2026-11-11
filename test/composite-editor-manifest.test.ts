import { describe, expect, it } from 'vitest'
import type { CanvasEdge, CanvasNode } from '../src/shared/types'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import { buildCompositeManifestFromEditor } from '../src/renderer/src/composite/editor-manifest'

function port(id: string, dir: 'in' | 'out', type: 'text' = 'text') {
  return { id, name: id, dir, type, required: dir === 'in', cardinality: 'one' as const }
}

function node(id: string, title: string): CanvasNode {
  return {
    id,
    type: 'text',
    contractVersion: 3,
    title,
    x: 0,
    y: 0,
    w: 340,
    h: 300,
    ports: [port('in-text', 'in'), port('out-text', 'out')],
    params: {},
    content: { kind: 'text', text: title },
    exec: { status: 'idle' },
    meta: {}
  }
}

function manifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'copy-polish',
    version: '1.0',
    name: '文案整理',
    inputs: [
      {
        id: 'copy',
        label: '文案',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'polished',
        label: '整理结果',
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
          title: '文案',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          text: '正文',
          ports: [port('in-text', 'in'), port('out-text', 'out')]
        }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
  }
}

describe('节点流编辑画布 → manifest（边界随内部图自动推导）', () => {
  it('稳定内部 ID 不按数组下标重排；公开边界按源/汇节点规范推导', () => {
    const nodes = [node('shape:a', '文案'), node('shape:b', '新增')]
    const edges: CanvasEdge[] = [
      {
        id: 'e1',
        from: { nodeId: 'shape:a', portId: 'out-text' },
        to: { nodeId: 'shape:b', portId: 'in-text' }
      }
    ]
    let index = 0
    const result = buildCompositeManifestFromEditor({
      manifest: manifest(),
      nodes,
      edges,
      internalIdByShapeId: new Map([['shape:a', 'n1']]),
      nextInternalId: () => `n-new-${index++}`
    })
    expect(result.issues).toEqual([])
    expect(result.manifest.graph.nodes.map((item) => item.id)).toEqual(['n1', 'n-new-0'])
    // 输入来自源文本节点（带默认正文），输出来自汇节点的主输出。
    expect(result.manifest.inputs).toHaveLength(1)
    expect(result.manifest.inputs[0].type).toBe('text')
    expect(result.manifest.inputs[0].targets).toEqual([{ nodeId: 'n1', portId: 'in-text' }])
    expect(result.manifest.inputs[0].defaultValue).toBe('文案')
    expect(result.manifest.outputs).toHaveLength(1)
    expect(result.manifest.outputs[0].source).toEqual({ nodeId: 'n-new-0', portId: 'out-text' })
    expect(result.manifest.graph.edges).toEqual([
      { from: { nodeId: 'n1', portId: 'out-text' }, to: { nodeId: 'n-new-0', portId: 'in-text' } }
    ])
  })

  it('删除节点后边界跟随新图推导，不保留失效的旧映射', () => {
    const nodes = [node('shape:b', '其他')]
    const result = buildCompositeManifestFromEditor({
      manifest: manifest(),
      nodes,
      edges: [],
      internalIdByShapeId: new Map(),
      nextInternalId: () => 'n-new'
    })
    expect(result.manifest.inputs[0].targets).toEqual([{ nodeId: 'n-new', portId: 'in-text' }])
    expect(result.manifest.outputs[0].source).toEqual({ nodeId: 'n-new', portId: 'out-text' })
  })
})
