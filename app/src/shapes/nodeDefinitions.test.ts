import { describe, expect, it } from 'vitest'
import { getNodeDefinition, getShapeOutputKinds, isNodeShape, NODE_DEFINITIONS } from './nodeDefinitions'

describe('node definition contract', () => {
  it('uses unique types and a single 360x360 creation grid', () => {
    expect(new Set(NODE_DEFINITIONS.map((node) => node.type)).size).toBe(NODE_DEFINITIONS.length)
    for (const node of NODE_DEFINITIONS) expect(node.defaultSize).toEqual({ w: 360, h: 360 })
  })

  it('keeps every port name unique inside its node', () => {
    for (const node of NODE_DEFINITIONS) {
      expect(new Set(node.inputs.map((port) => port.name)).size).toBe(node.inputs.length)
      expect(new Set(node.outputs.map((port) => port.name)).size).toBe(node.outputs.length)
    }
  })

  it('uses compact typographic symbols instead of emoji for node catalog icons', () => {
    const emoji = /[\u{1F000}-\u{1FAFF}]/u
    for (const node of NODE_DEFINITIONS) expect(node.icon).not.toMatch(emoji)
  })

  it('declares the current Merge implementation honestly', () => {
    const merge = getNodeDefinition('merge')!
    expect(merge.inputs[0].kinds).toEqual(['Text[]'])
    expect(merge.outputs[0].kinds).toEqual(['Text'])
  })

  it('recognizes video nodes in the canonical graph registry', () => {
    const video = { type: 'video-gen', meta: {}, props: {} }
    expect(isNodeShape(video as never)).toBe(true)
    expect(getShapeOutputKinds(video as never)).toEqual(['Video[]'])
  })

  it('resolves OneShot output as Text[] only after a mapped run', () => {
    expect(getShapeOutputKinds({ type: 'one-shot', meta: {}, props: {} } as never)).toEqual(['Text'])
    expect(getShapeOutputKinds({ type: 'one-shot', meta: { outputItems: ['a', 'b'] }, props: {} } as never)).toEqual(['Text[]'])
  })
})
