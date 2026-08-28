// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { BUILTIN_TEMPLATES } from '@renderer/canvas/CanvasSidePanel'
import { getNodePorts, getNodeType, portCompatible } from '@renderer/nodes/registry'
import { nodeSchemasCompatible } from '@shared/node-schemas'
import { registerAllNodeTypes } from './helpers/registerNodes'

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
  it.each(['角色→场景→分镜', '分镜→导演台', '提示词包→生图', '分镜→批量生图'])(
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
})
