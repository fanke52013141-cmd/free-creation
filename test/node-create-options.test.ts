import { beforeAll, describe, expect, it } from 'vitest'
import {
  compatibleNodeCreateChoices,
  compatibleUpstreamCreateChoices
} from '../src/renderer/src/canvas/node-create-options'
import { registerBaseNodeTypes, registerExtendedNodeTypes } from '../src/renderer/src/nodes/specs'

beforeAll(() => {
  registerBaseNodeTypes()
  registerExtendedNodeTypes()
})

describe('node creation options', () => {
  it('exposes every compatible target input as an explicit choice', () => {
    const choices = compatibleNodeCreateChoices({
      shapeId: 'shape:source',
      portId: 'out-json',
      portType: 'json',
      schema: { id: 'json.any', version: 1 }
    })

    expect(choices).toContainEqual(
      expect.objectContaining({ type: 'ai-process', targetPortId: 'in-json' })
    )
    expect(choices).toContainEqual(
      expect.objectContaining({ type: 'image-gen', targetPortId: 'in-prompt' })
    )
  })

  it('only exposes the matching schema port on a multi-input node', () => {
    const choices = compatibleNodeCreateChoices({
      shapeId: 'shape:source',
      portId: 'out-camera',
      portType: 'camera',
      schema: { id: 'previs.camera', version: 1 }
    })

    expect(choices).toContainEqual(
      expect.objectContaining({ type: 'director', targetPortId: 'in-camera-preset' })
    )
    expect(choices).not.toContainEqual(
      expect.objectContaining({ type: 'director', targetPortId: 'in-storyboard' })
    )
  })
})

describe('反向拉线（从输入端口拖到空白）的上游候选', () => {
  it('文本输入的上游：暴露各节点的文本/Markdown 输出（而非只选第一个）', () => {
    const choices = compatibleUpstreamCreateChoices({
      shapeId: 'shape:target',
      portId: 'in-prompt',
      portType: 'text',
      direction: 'in'
    })

    expect(choices).toContainEqual(
      expect.objectContaining({ type: 'text', targetPortId: 'out-text' })
    )
    expect(choices).toContainEqual(
      expect.objectContaining({ type: 'chat', targetPortId: 'out-markdown' })
    )
    // 文本输入不应匹配图片输出节点。
    expect(choices).not.toContainEqual(
      expect.objectContaining({ type: 'image', targetPortId: 'out-image' })
    )
  })

  it('json 输入按 Schema 匹配：list.items 输入只接同 Schema 输出', () => {
    const choices = compatibleUpstreamCreateChoices({
      shapeId: 'shape:target',
      portId: 'in-list',
      portType: 'json',
      schema: { id: 'list.items', version: 1 },
      direction: 'in'
    })

    expect(choices).toContainEqual(
      expect.objectContaining({ type: 'image-split', targetPortId: 'out-images' })
    )
    // storyboard.shots 输出与 list.items 输入 Schema 不同，不应出现在上游候选。
    expect(choices).not.toContainEqual(
      expect.objectContaining({ type: 'storyboard', targetPortId: 'out-json' })
    )
  })

  it('机位通道按 Schema 收紧：无 Schema 的 camera 输出不会进入候选', () => {
    const choices = compatibleUpstreamCreateChoices({
      shapeId: 'shape:target',
      portId: 'in-camera-preset',
      portType: 'camera',
      schema: { id: 'previs.camera', version: 1 },
      direction: 'in'
    })

    expect(choices).toContainEqual(
      expect.objectContaining({ type: 'director', targetPortId: 'out-camera' })
    )
  })

  it('iteration 输出可作为 json 输入的上游（非对称规则在反向菜单同样成立）', () => {
    const choices = compatibleUpstreamCreateChoices({
      shapeId: 'shape:target',
      portId: 'in-json',
      portType: 'json',
      schema: { id: 'json.any', version: 1 },
      direction: 'in'
    })

    expect(choices).toContainEqual(
      expect.objectContaining({ type: 'iterate', targetPortId: 'out-item' })
    )
  })
})
