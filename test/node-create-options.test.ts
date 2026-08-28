import { beforeAll, describe, expect, it } from 'vitest'
import { compatibleNodeCreateChoices } from '../src/renderer/src/canvas/node-create-options'
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
    expect(choices.some((choice) => choice.type === 'image-gen')).toBe(false)
  })

  it('only exposes the matching schema port on a multi-input node', () => {
    const choices = compatibleNodeCreateChoices({
      shapeId: 'shape:source',
      portId: 'out-camera',
      portType: 'json',
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
