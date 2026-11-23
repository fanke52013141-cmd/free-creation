// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import type { Editor, TLShapeId } from 'tldraw'
import type { CanvasNode } from '@shared/types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { BUILTIN_TEMPLATES } from './fixtures/workflow-builtin-fixtures'
import { getNodePorts, getNodeType, portCompatible } from '@renderer/nodes/registry'
import { nodeSchemasCompatible } from '@shared/node-schemas'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { deriveGraph } from '@renderer/canvas/graph'
import { addNodeLibraryEntry } from '@renderer/canvas/node-library'
import {
  extractTemplateFromSelection,
  templateNodeProps,
  templatePayloadFromGraph,
  type SavePayload,
  type TemplateEdge,
  type TemplateNode,
  type WorkflowTemplate
} from '@renderer/stores/workflow'

beforeAll(registerAllNodeTypes)

function shapeFor(node: (typeof BUILTIN_TEMPLATES)[number]['nodes'][number]): NodeCardShape {
  return {
    id: `shape:${node.type}` as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: node.type,
      title: node.title ?? node.type,
      config: node.config ?? '',
      text: node.text ?? '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  }
}

describe('P2/P3 内置创作模板', () => {
  it.each(['角色→场景→分镜', '分镜→3D预演', '提示词包→生图', 'P图→后续创作', '分镜→批量生图'])(
    '%s 的每条连线均为真实契约连接',
    (name) => {
      const template = BUILTIN_TEMPLATES.find((item) => item.name === name)!
      expect(template).toBeDefined()
      for (const edge of template.edges) {
        const fromNode = template.nodes[edge.from]!
        const toNode = template.nodes[edge.to]!
        const fromSpec = getNodeType(fromNode.type)!
        const toSpec = getNodeType(toNode.type)!
        const fromPort = getNodePorts(fromSpec, shapeFor(fromNode)).out.find(
          (port) => port.id === edge.fromPort
        )
        const toPort = getNodePorts(toSpec, shapeFor(toNode)).in.find(
          (port) => port.id === edge.toPort
        )
        expect(fromPort, `${name} 缺少源端口 ${edge.fromPort}`).toBeDefined()
        expect(toPort, `${name} 缺少目标端口 ${edge.toPort}`).toBeDefined()
        expect(portCompatible(fromPort!.type, toPort!.type)).toBe(true)
        if (fromPort!.type === 'json' && toPort!.type === 'json') {
          expect(nodeSchemasCompatible(fromPort!.schema, toPort!.schema)).toBe(true)
        }
      }
    }
  )

  it('分镜→批量生图以 out-item 明确圈定循环体，结果列表不混入循环控制', () => {
    const template = BUILTIN_TEMPLATES.find((item) => item.name === '分镜→批量生图')!
    const iterateIndex = template.nodes.findIndex((node) => node.type === 'iterate')
    const itemEdges = template.edges.filter((edge) => edge.from === iterateIndex)
    expect(itemEdges).toEqual([
      { from: iterateIndex, to: iterateIndex + 1, fromPort: 'out-item', toPort: 'in-context' }
    ])
    expect(template.nodes[iterateIndex]?.config).toContain('"runMode":"resume"')
  })

  it('P图后续创作从同一张修改结果分支到三个正式图片输入', () => {
    const template = BUILTIN_TEMPLATES.find((item) => item.name === 'P图→后续创作')!
    expect(template.nodes.map((node) => node.type)).toEqual([
      'image',
      'image-edit',
      'image-crop',
      'image-gen',
      'video'
    ])
    expect(template.edges).toEqual([
      { from: 0, to: 1, fromPort: 'out-image', toPort: 'in-image' },
      { from: 1, to: 2, fromPort: 'out-image', toPort: 'in-image' },
      { from: 1, to: 3, fromPort: 'out-image', toPort: 'in-images' },
      { from: 1, to: 4, fromPort: 'out-image', toPort: 'in-images' }
    ])
  })
})

describe('工作流模板配置保存', () => {
  it('单个节点也可以保存到节点库并恢复固定配置', () => {
    const node = shapeFor({
      type: 'website',
      title: '网址节点',
      config: JSON.stringify({ name: '官方主页', url: 'https://example.com' }),
      dx: 0,
      dy: 0
    })
    const payload = extractTemplateFromSelection([node], [])
    expect(payload.nodes).toHaveLength(1)
    expect(templateNodeProps(payload.nodes[0]!)).toMatchObject({
      nodeType: 'website',
      config: JSON.stringify({ name: '官方主页', url: 'https://example.com' })
    })
    expect(payload.edges).toEqual([])
  })

  it('保存选中节点时保留 config，套用后可恢复动态端口和 Schema', () => {
    const node = shapeFor({
      type: 'code',
      title: '代码',
      config: JSON.stringify({
        source: 'return input',
        outputName: 'result',
        outputType: 'object',
        params: [{ name: 'scene', type: 'string' }]
      }),
      dx: 0,
      dy: 0
    })
    const payload = extractTemplateFromSelection([node], [])
    const savedNode = payload.nodes[0]!
    expect(savedNode.config).toContain('result')
    expect(savedNode.config).toContain('scene')
    const restored = {
      ...node,
      props: { ...node.props, ...templateNodeProps(savedNode) }
    }
    expect(
      getNodePorts(getNodeType('code')!, restored).out.some((port) => port.name === 'result')
    ).toBe(true)
  })

  it('模板不会保存或重放项目媒体，即使旧记录含有媒体字段', () => {
    const legacyTemplateNode = {
      nodeType: 'image',
      title: '旧图片入口',
      dx: 0,
      dy: 0,
      w: 340,
      h: 220,
      mediaId: 'old-project-media',
      mediaPath: 'projects/old/media/reference.png',
      mediaMime: 'image/png'
    }
    expect(templateNodeProps(legacyTemplateNode)).toMatchObject({
      nodeType: 'image',
      mediaId: '',
      mediaPath: '',
      mediaMime: ''
    })
  })
})

// ── 节点库条目 ↔ 全屏编辑页（2026-11-23 用户裁决：节点流的编辑都用专门页面，不在主画布上铺开改） ──

/** 记录型伪 editor：只实现「条目铺开 → 建线 → 读回内部图」用到的最小 API（做法同 edge-same-source-replace）。 */
function recordingEditor(): Editor {
  const shapes: Record<string, unknown>[] = []
  const bindings = new Map<TLShapeId, { props: { terminal: 'start' | 'end' }; toId: TLShapeId }[]>()
  const editor = {
    getViewportPageBounds: () => ({
      minX: 0,
      minY: 0,
      maxX: 1280,
      maxY: 720,
      width: 1280,
      height: 720,
      center: { x: 640, y: 360 }
    }),
    getShape: (id: TLShapeId) => shapes.find((shape) => shape.id === id),
    getCurrentPageShapes: () => shapes,
    getBindingsFromShape: (id: TLShapeId) => bindings.get(id) ?? [],
    getShapePageBounds: (id: TLShapeId) => {
      const shape = editor.getShape(id) as { x: number; y: number } | undefined
      return shape ? { x: shape.x, y: shape.y, maxX: shape.x + 340, height: 260 } : null
    },
    createShape: (input: Record<string, unknown>) => {
      shapes.push(input)
    },
    createBinding: (input: {
      fromId: TLShapeId
      toId: TLShapeId
      props: { terminal: 'start' | 'end' }
    }) => {
      const list = bindings.get(input.fromId) ?? []
      list.push({ props: input.props, toId: input.toId })
      bindings.set(input.fromId, list)
    },
    deleteShapes: (ids: TLShapeId[]) => {
      for (const id of ids) {
        const index = shapes.findIndex((shape) => shape.id === id)
        if (index >= 0) shapes.splice(index, 1)
        bindings.delete(id)
      }
    },
    run: (fn: () => void) => fn()
  }
  return editor as unknown as Editor
}

function entryOf(nodes: TemplateNode[], edges: TemplateEdge[]): WorkflowTemplate {
  return { id: 'entry-1', name: '教授', createdAt: 0, nodeCount: nodes.length, nodes, edges }
}

function sizeOf(nodeType: string): { w: number; h: number } {
  const spec = getNodeType(nodeType)
  if (!spec) throw new Error(`未知节点类型 ${nodeType}`)
  return { w: spec.defaultSize.w, h: spec.defaultSize.h }
}

/** 同内置模板「提示词包→生图」：提示词包(out-json) → 生图(in-prompt)，是真实契约连接。 */
function promptToImageGen(): TemplateNode[] {
  return [
    {
      nodeType: 'structured',
      title: '提示词包',
      dx: -200,
      dy: 0,
      ...sizeOf('structured'),
      text: JSON.stringify({ prompt: '电影感雨夜街头', style: '35mm 胶片', aspectRatio: '16:9' }),
      config: JSON.stringify({ schema: { id: 'prompt.bundle', version: 1 } })
    },
    {
      nodeType: 'image-gen',
      title: '生图',
      dx: 200,
      dy: 0,
      ...sizeOf('image-gen'),
      text: '',
      config: ''
    }
  ]
}

/** 条目铺进编辑页再保存回来的负载——编辑页的载入与保存走的正是这两个函数。 */
function roundTrip(template: WorkflowTemplate): { payload: SavePayload; skippedEdges: number } {
  const editor = recordingEditor()
  const { skippedEdges } = addNodeLibraryEntry(editor, template, false)
  return { payload: templatePayloadFromGraph(deriveGraph(editor)), skippedEdges }
}

/** 中心归一化有 1e-15 级浮点误差，按 1e-6 取整后比较。 */
function rounded(payload: SavePayload): SavePayload {
  const round = (value: number) => Math.round(value * 1e6) / 1e6
  return {
    nodes: payload.nodes.map((node) => ({ ...node, dx: round(node.dx), dy: round(node.dy) })),
    edges: payload.edges
  }
}

function canvasNode(
  id: string,
  type: CanvasNode['type'],
  patch: Partial<CanvasNode> = {}
): CanvasNode {
  return {
    id,
    type,
    contractVersion: 1,
    title: type,
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

describe('节点库条目 ↔ 全屏编辑页', () => {
  it('条目铺进编辑页再保存：节点、配置、正文与连线原样回来', () => {
    const nodes = promptToImageGen()
    const edges: TemplateEdge[] = [{ fromIdx: 0, toIdx: 1, fromPort: 'out-json', toPort: 'in-prompt' }]
    const first = roundTrip(entryOf(nodes, edges))
    expect(first.skippedEdges).toBe(0)
    expect(rounded(first.payload)).toEqual(rounded({ nodes, edges }))
    // 再进出一次结果不变：反复编辑不会让条目漂移。
    const second = roundTrip(entryOf(first.payload.nodes, first.payload.edges))
    expect(rounded(second.payload)).toEqual(rounded(first.payload))
  })

  it('老条目（连线没有端口 ID）在编辑页里不丢线，保存后带上推断出的端口', () => {
    const first = roundTrip(entryOf(promptToImageGen(), [{ fromIdx: 0, toIdx: 1 }]))
    expect(first.skippedEdges).toBe(0)
    expect(first.payload.edges).toEqual([
      { fromIdx: 0, toIdx: 1, fromPort: 'out-json', toPort: 'in-prompt' }
    ])
  })

  it('保存回条目时不携带项目媒体，位置以整组中心为原点，悬空连线不写', () => {
    const payload = templatePayloadFromGraph({
      nodes: [
        canvasNode('shape:a', 'text', {
          x: 1000,
          y: 300,
          content: { kind: 'text', text: '正文' },
          params: { config: '{"k":1}' }
        }),
        canvasNode('shape:b', 'image', {
          x: 1400,
          y: 500,
          content: { kind: 'media', mediaId: 'media-1' },
          params: { mediaPath: 'projects/p/media/a.png', mediaMime: 'image/png' }
        }),
        canvasNode('shape:c', 'text', { x: 0, y: 100 })
      ],
      edges: [
        { id: 'shape:e1', from: { nodeId: 'shape:a', portId: 'out-text' }, to: { nodeId: 'shape:b', portId: '' } },
        { id: 'shape:e2', from: { nodeId: 'shape:a', portId: 'out-text' }, to: { nodeId: 'shape:gone', portId: 'in-text' } }
      ]
    })
    expect(
      payload.nodes.map((node) => [node.nodeType, node.dx, node.dy, node.text, node.config])
    ).toEqual([
      ['text', 200, 0, '正文', '{"k":1}'],
      ['image', 600, 200, '', ''],
      ['text', -800, -200, '', '']
    ])
    expect(payload.nodes[1]).not.toHaveProperty('mediaId')
    expect(payload.edges).toEqual([{ fromIdx: 0, toIdx: 1, fromPort: 'out-text' }])
    expect(templatePayloadFromGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] })
  })
})
