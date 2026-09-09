// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { createShapeId, type TLShapeId } from 'tldraw'
import { readConnectedNodeInputs } from '../src/renderer/src/canvas/graph'
import type { NodeCardShape } from '../src/renderer/src/canvas/NodeCardShape'
import { registerAllNodeTypes } from './helpers/registerNodes'

beforeAll(() => registerAllNodeTypes())

function card(
  id: TLShapeId,
  nodeType: string,
  title: string,
  extra: Partial<NodeCardShape['props']> = {}
): NodeCardShape {
  return {
    id,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: `a${id}`,
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 340,
      h: 260,
      nodeType,
      title,
      config: '',
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      ...extra
    }
  }
}

describe('已连接输入摘要', () => {
  it('仅通过真实边与端口读取来源、投影输出和 many 顺序', () => {
    const imageA = card(createShapeId('image-a'), 'image', '参考图 A', {
      mediaId: 'asset-a',
      mediaPath: 'assets/a.png',
      mediaMime: 'image/png'
    })
    const imageB = card(createShapeId('image-b'), 'image', '参考图 B', {
      mediaId: 'asset-b',
      mediaPath: 'assets/b.png',
      mediaMime: 'image/png'
    })
    const text = card(createShapeId('text'), 'text', '画面描述', { text: '雨夜的城市街道' })
    const target = card(createShapeId('target'), 'image-gen', '生图')
    const arrowA = {
      id: createShapeId('arrow-a'),
      type: 'arrow',
      index: 'a1',
      meta: { fromPort: 'out-image', toPort: 'in-images' }
    }
    const arrowB = {
      id: createShapeId('arrow-b'),
      type: 'arrow',
      index: 'a2',
      meta: { fromPort: 'out-image', toPort: 'in-images' }
    }
    const arrowText = {
      id: createShapeId('arrow-text'),
      type: 'arrow',
      index: 'a3',
      meta: { fromPort: 'out-text', toPort: 'in-text' }
    }
    const shapes = [target, imageB, arrowText, imageA, arrowA, text, arrowB] as unknown[]
    const byId = new Map([
      [imageA.id, imageA],
      [imageB.id, imageB],
      [text.id, text],
      [target.id, target]
    ])
    const bindings = new Map([
      [
        arrowA.id,
        [
          { props: { terminal: 'start' }, toId: imageA.id },
          { props: { terminal: 'end' }, toId: target.id }
        ]
      ],
      [
        arrowB.id,
        [
          { props: { terminal: 'start' }, toId: imageB.id },
          { props: { terminal: 'end' }, toId: target.id }
        ]
      ],
      [
        arrowText.id,
        [
          { props: { terminal: 'start' }, toId: text.id },
          { props: { terminal: 'end' }, toId: target.id }
        ]
      ]
    ])
    const editor = {
      getShape: (id: TLShapeId) => byId.get(id),
      getCurrentPageShapes: () => shapes,
      getBindingsFromShape: (id: TLShapeId) => bindings.get(id) ?? []
    }

    const inputs = readConnectedNodeInputs(editor as never, target.id)

    expect(inputs).toEqual([
      expect.objectContaining({
        targetPortId: 'in-images',
        sourceNodeName: '参考图 A',
        sourcePortName: '图片',
        order: 1,
        value: expect.objectContaining({ kind: 'image', mediaId: 'asset-a' })
      }),
      expect.objectContaining({
        targetPortId: 'in-images',
        sourceNodeName: '参考图 B',
        order: 2,
        value: expect.objectContaining({ kind: 'image', mediaId: 'asset-b' })
      }),
      expect.objectContaining({
        targetPortId: 'in-text',
        sourceNodeName: '画面描述',
        sourcePortName: '文本',
        order: 1,
        value: { kind: 'text', text: '雨夜的城市街道' }
      })
    ])
  })
})
