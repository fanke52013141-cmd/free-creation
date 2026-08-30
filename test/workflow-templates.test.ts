// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { BUILTIN_TEMPLATES } from '@renderer/canvas/CanvasSidePanel'
import { getNodePorts, getNodeType, portCompatible } from '@renderer/nodes/registry'
import { nodeSchemasCompatible } from '@shared/node-schemas'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { extractTemplateFromSelection, templateNodeProps } from '@renderer/stores/workflow'

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
  it.each(['角色→场景→分镜', '分镜→3D预演', '提示词包→生图', '图片修改→后续创作', '分镜→批量生图'])(
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

  it('图片修改后续创作从同一张修改结果分支到三个正式图片输入', () => {
    const template = BUILTIN_TEMPLATES.find((item) => item.name === '图片修改→后续创作')!
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
      { from: 1, to: 3, fromPort: 'out-image', toPort: 'in-image' },
      { from: 1, to: 4, fromPort: 'out-image', toPort: 'in-image' }
    ])
  })
})

describe('工作流模板配置保存', () => {
  it('保存选中节点时保留 config，套用后可恢复动态端口和 Schema', () => {
    const node = shapeFor({
      type: 'code',
      title: '代码',
      config: JSON.stringify({
        source: 'return input',
        outputName: 'result',
        outputType: 'json',
        params: [{ name: 'scene', type: 'string' }]
      }),
      dx: 0,
      dy: 0
    })
    const payload = extractTemplateFromSelection([node], [])
    expect(payload.nodes[0]?.config).toContain('result')
    expect(payload.nodes[0]?.config).toContain('scene')
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
