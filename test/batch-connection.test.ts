import { describe, expect, it } from 'vitest'
import type { PortDecl } from '../src/shared/types'
import { planHeterogeneousBatchConnections } from '../src/renderer/src/canvas/graph'
import type { BatchConnectionMember } from '../src/renderer/src/stores/connection'
import { batchConnectionFromSelection } from '../src/renderer/src/canvas/batch-connection'
import {
  registerNodeType,
  unregisterNodeType,
  type NodeTypeSpec
} from '../src/renderer/src/nodes/registry'
import type { NodeCardShape } from '../src/renderer/src/canvas/NodeCardShape'
import type { Editor, TLShapeId } from 'tldraw'

function output(
  shapeId: string,
  portId: string,
  portType: BatchConnectionMember['portType']
): BatchConnectionMember {
  return { shapeId: shapeId as BatchConnectionMember['shapeId'], portId, portType }
}

function input(
  id: string,
  type: PortDecl['type'],
  cardinality: PortDecl['cardinality'] = 'many'
): PortDecl {
  return {
    id,
    name: id,
    dir: 'in',
    type,
    required: false,
    cardinality,
    description: id
  }
}

describe('异构多选连接计划', () => {
  it('文本和图片选区会暴露各自真实输出，而非伪造一个共同 any 端口', () => {
    const textType = 'test-batch-text-source'
    const imageType = 'test-batch-image-source'
    const sourceSpec = (type: string, port: PortDecl): NodeTypeSpec => ({
      type: type as NodeTypeSpec['type'],
      contractVersion: 1,
      label: type,
      icon: 'text',
      color: '#fff',
      defaultSize: { w: 340, h: 260 },
      description: '测试批量来源。',
      category: 'input',
      creatable: false,
      ports: { in: [], out: [port] },
      projectOutputs: () => ({}),
      Body: () => null as never
    })
    registerNodeType(
      sourceSpec(textType, {
        ...input('out-text', 'text', 'one'),
        dir: 'out'
      })
    )
    registerNodeType(
      sourceSpec(imageType, {
        ...input('out-image', 'image', 'one'),
        dir: 'out'
      })
    )
    const shape = (id: string, nodeType: string) =>
      ({
        id: id as TLShapeId,
        type: 'node-card',
        props: {
          w: 340,
          h: 260,
          nodeType,
          title: nodeType,
          config: '',
          text: '',
          mediaId: '',
          mediaPath: '',
          mediaMime: '',
          exec: 'idle'
        }
      }) as NodeCardShape
    const textShape = shape('shape:text', textType)
    const imageShape = shape('shape:image', imageType)
    const editor = {
      getShape: (id: TLShapeId) =>
        id === textShape.id ? textShape : id === imageShape.id ? imageShape : undefined
    } as unknown as Editor

    try {
      expect(batchConnectionFromSelection(editor, [textShape.id, imageShape.id])).toMatchObject({
        memberIds: [textShape.id, imageShape.id],
        memberPorts: [
          { shapeId: textShape.id, portId: 'out-text', portType: 'text' },
          { shapeId: imageShape.id, portId: 'out-image', portType: 'image' }
        ]
      })
    } finally {
      unregisterNodeType(textType as NodeTypeSpec['type'])
      unregisterNodeType(imageType as NodeTypeSpec['type'])
    }
  })

  it('为文本和图片分别分配 image-gen 声明的 in-text / in-images', () => {
    const plan = planHeterogeneousBatchConnections(
      [output('shape:text', 'out-text', 'text'), output('shape:image', 'out-image', 'image')],
      [input('in-images', 'image'), input('in-prompt', 'json', 'one'), input('in-text', 'text')],
      new Set()
    )

    expect(plan).toEqual([
      { sourcePortId: 'out-text', targetPortId: 'in-text' },
      { sourcePortId: 'out-image', targetPortId: 'in-images' }
    ])
  })

  it('拒绝目标单值输入已被占用，且不退化为隐式 any', () => {
    const plan = planHeterogeneousBatchConnections(
      [output('shape:text', 'out-text', 'text'), output('shape:image', 'out-image', 'image')],
      [input('in-text', 'text', 'one'), input('in-image', 'image', 'one')],
      new Set(['in-image'])
    )

    expect(plan).toBeNull()
  })

  it('同类多值来源仍可映射到同一个 many 输入', () => {
    const plan = planHeterogeneousBatchConnections(
      [output('shape:one', 'out-image', 'image'), output('shape:two', 'out-image', 'image')],
      [input('in-images', 'image', 'many')],
      new Set()
    )

    expect(plan).toEqual([
      { sourcePortId: 'out-image', targetPortId: 'in-images' },
      { sourcePortId: 'out-image', targetPortId: 'in-images' }
    ])
  })

  it('在可选端口重叠时回溯分配，保留更窄的真实端口给唯一兼容来源', () => {
    const plan = planHeterogeneousBatchConnections(
      [output('shape:any', 'out-any', 'any'), output('shape:image', 'out-image', 'image')],
      [input('in-any', 'any', 'one'), input('in-image', 'image', 'one')],
      new Set()
    )

    expect(plan).toEqual([
      { sourcePortId: 'out-any', targetPortId: 'in-any' },
      { sourcePortId: 'out-image', targetPortId: 'in-image' }
    ])
  })
})
