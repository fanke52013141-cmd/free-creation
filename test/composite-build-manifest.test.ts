import { describe, expect, it } from 'vitest'
import type { CanvasEdge, CanvasNode, PortDecl } from '../src/shared/types'
import { buildCompositeManifestFromGraph } from '../src/renderer/src/composite/build-manifest'

function port(patch: Partial<PortDecl> & Pick<PortDecl, 'id' | 'dir' | 'type'>): PortDecl {
  return {
    name: patch.id,
    required: patch.dir === 'in',
    cardinality: 'one',
    description: patch.name ?? patch.id,
    ...patch
  }
}

function node(patch: Partial<CanvasNode> & Pick<CanvasNode, 'id' | 'type'>): CanvasNode {
  return {
    contractVersion: 1,
    title: patch.id,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: {},
    content: { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 },
    ...patch
  }
}

function fixture(): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const text = node({
    id: 'shape:text',
    type: 'text',
    title: '人物要求',
    content: { kind: 'text', text: '' },
    ports: [
      port({ id: 'in-text', dir: 'in', type: 'text', name: '人物要求' }),
      port({ id: 'out-text', dir: 'out', type: 'text', name: '文本' })
    ]
  })
  const ai = node({
    id: 'shape:ai',
    type: 'ai-process',
    title: '整理描述',
    x: 380,
    ports: [
      port({ id: 'in-text', dir: 'in', type: 'text', name: '输入文本' }),
      port({ id: 'out-text', dir: 'out', type: 'text', name: '结果文本' })
    ]
  })
  const image = node({
    id: 'shape:image',
    type: 'image-gen',
    title: '生成人物图',
    x: 760,
    ports: [
      port({ id: 'in-prompt', dir: 'in', type: 'text', name: '提示词' }),
      port({
        id: 'in-images',
        dir: 'in',
        type: 'image',
        name: '参考图',
        required: false,
        cardinality: 'many'
      }),
      port({ id: 'out-image', dir: 'out', type: 'image', name: '人物设计图' })
    ]
  })
  const outside = node({ id: 'shape:outside', type: 'text', title: '外部输入' })
  return {
    nodes: [text, ai, image, outside],
    edges: [
      {
        id: 'e-external',
        from: { nodeId: 'shape:outside', portId: 'out-text' },
        to: { nodeId: 'shape:text', portId: 'in-text' }
      },
      {
        id: 'e-1',
        from: { nodeId: 'shape:text', portId: 'out-text' },
        to: { nodeId: 'shape:ai', portId: 'in-text' }
      },
      {
        id: 'e-2',
        from: { nodeId: 'shape:ai', portId: 'out-text' },
        to: { nodeId: 'shape:image', portId: 'in-prompt' }
      }
    ]
  }
}

describe('组合草稿边界提取（P1）', () => {
  it('人物设计：外部输入→人物要求文本→AI→生图，公开输出为图片', () => {
    const { nodes, edges } = fixture()
    const result = buildCompositeManifestFromGraph({
      capabilityId: 'character-design',
      name: '人物设计',
      version: '1.0',
      nodes,
      edges,
      selectedNodeIds: ['shape:text', 'shape:ai', 'shape:image']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { manifest } = result
    expect(manifest.graph.nodes.map((item) => item.id)).toEqual(['n1', 'n2', 'n3'])
    expect(manifest.graph.edges).toHaveLength(2)
    expect(manifest.inputs).toHaveLength(1)
    expect(manifest.inputs[0].type).toBe('text')
    expect(manifest.inputs[0].targets).toEqual([{ nodeId: 'n1', portId: 'in-text' }])
    expect(manifest.outputs).toHaveLength(1)
    expect(manifest.outputs[0].type).toBe('image')
    expect(manifest.outputs[0].source).toEqual({ nodeId: 'n3', portId: 'out-image' })
    expect(manifest.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'node', id: 'text', contractVersion: 1 }),
        expect.objectContaining({ kind: 'node', id: 'image-gen', contractVersion: 1 })
      ])
    )
    expect(manifest.executionPolicy?.maxExpandedNodes).toBe(40)
  })

  it('必填但未接线的输入会成为公开输入候选', () => {
    const { nodes, edges } = fixture()
    const result = buildCompositeManifestFromGraph({
      capabilityId: 'character-design',
      name: '人物设计',
      version: '1.0',
      nodes,
      edges,
      selectedNodeIds: ['shape:ai', 'shape:image']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // ai.in-text 必填且只在选区内部没有来源 → 应列为公开输入
    expect(result.manifest.inputs.some((input) => input.targets[0]?.portId === 'in-text')).toBe(
      true
    )
  })

  it('AI 处理源节点带文本+JSON 两端口时只公开单个必填文本主输入（单输入黑盒）', () => {
    const ai = node({
      id: 'shape:ai',
      type: 'ai-process',
      title: '整理描述',
      ports: [
        port({
          id: 'in-text',
          dir: 'in',
          type: 'text',
          name: '输入文本',
          required: false,
          cardinality: 'many'
        }),
        port({ id: 'in-json', dir: 'in', type: 'json', name: 'JSON 上下文', required: false }),
        port({ id: 'out-text', dir: 'out', type: 'text', name: '结果文本' })
      ]
    })
    const image = node({
      id: 'shape:image',
      type: 'image-gen',
      title: '生成人物图',
      x: 380,
      ports: [
        port({ id: 'in-prompt', dir: 'in', type: 'text', name: '提示词', required: false }),
        port({ id: 'out-image', dir: 'out', type: 'image', name: '人物设计图' })
      ]
    })
    const result = buildCompositeManifestFromGraph({
      capabilityId: 'ai-to-image',
      name: 'AI 处理生图',
      version: '1.0',
      nodes: [ai, image],
      edges: [
        {
          id: 'e1',
          from: { nodeId: 'shape:ai', portId: 'out-text' },
          to: { nodeId: 'shape:image', portId: 'in-prompt' }
        }
      ],
      selectedNodeIds: ['shape:ai', 'shape:image']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.inputs).toHaveLength(1)
    expect(result.manifest.inputs[0]).toMatchObject({
      type: 'text',
      required: true,
      targets: [{ nodeId: 'n1', portId: 'in-text' }]
    })
    expect(result.manifest.inputs.some((input) => input.targets[0]?.portId === 'in-json')).toBe(
      false
    )
  })

  it('没有可达输出时拒绝生成', () => {
    const { nodes, edges } = fixture()
    const result = buildCompositeManifestFromGraph({
      capabilityId: 'character-design',
      name: '人物设计',
      version: '1.0',
      nodes: [nodes[0]],
      edges: edges.filter((edge) => edge.from.nodeId !== 'shape:text'),
      selectedNodeIds: ['shape:text']
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.outputs.length).toBeGreaterThan(0)
  })

  it('W1：嵌套节点流登记固定 capabilityId@version，运行语义写 2', () => {
    const nestedManifest = {
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
            ports: [
              {
                id: 'in-text',
                name: 'in-text',
                dir: 'in',
                type: 'text',
                required: true,
                cardinality: 'one'
              },
              {
                id: 'out-text',
                name: 'out-text',
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
      dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
    }
    const text = node({
      id: 'shape:text',
      type: 'text',
      title: '标题',
      content: { kind: 'text', text: '' },
      ports: [
        port({ id: 'in-text', dir: 'in', type: 'text' }),
        port({ id: 'out-text', dir: 'out', type: 'text' })
      ]
    })
    const nested = node({
      id: 'shape:nested',
      type: 'composite',
      title: '文案整理',
      x: 380,
      params: { config: JSON.stringify({ manifest: nestedManifest }) },
      ports: [
        port({ id: 'in-copy', dir: 'in', type: 'text', name: '文案' }),
        port({ id: 'out-polished', dir: 'out', type: 'text', name: '整理结果' })
      ]
    })
    const result = buildCompositeManifestFromGraph({
      capabilityId: 'title-polish',
      name: '标题整理',
      version: '1.0',
      nodes: [text, nested],
      edges: [
        {
          id: 'e1',
          from: { nodeId: 'shape:text', portId: 'out-text' },
          to: { nodeId: 'shape:nested', portId: 'in-copy' }
        }
      ],
      selectedNodeIds: ['shape:text', 'shape:nested']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.runtimeVersion).toBe(2)
    expect(result.manifest.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'capability', id: 'copy-polish', version: '1.0' })
      ])
    )
  })
})
