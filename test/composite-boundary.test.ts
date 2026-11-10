import { describe, expect, it } from 'vitest'
import { deriveCompositeBoundary } from '../src/shared/composite/boundary'
import type { CompositeManifest } from '../src/shared/composite/manifest'

function manifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId: 'character-design',
    version: '1.0',
    name: '角色设计',
    inputs: [],
    outputs: [],
    graph: {
      nodes: [
        {
          id: 'n1', nodeType: 'text', contractVersion: 3, title: '文本',
          dx: 0, dy: 0, w: 340, h: 300,
          ports: [
            { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
            { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ]
        },
        {
          id: 'n2', nodeType: 'ai-process', contractVersion: 1, title: 'AI 处理',
          dx: 400, dy: 0, w: 340, h: 300,
          ports: [
            { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
            { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' },
            { id: 'out-markdown', name: 'Markdown', dir: 'out', type: 'markdown', required: false, cardinality: 'one' },
            { id: 'out-json', name: 'JSON', dir: 'out', type: 'json', required: false, cardinality: 'one' }
          ]
        },
        {
          id: 'n3', nodeType: 'image-gen', contractVersion: 3, title: '生图',
          dx: 800, dy: 0, w: 340, h: 300,
          ports: [
            { id: 'in-text', name: '提示词', dir: 'in', type: 'text', required: false, cardinality: 'many' },
            { id: 'out-image', name: '图片', dir: 'out', type: 'image', required: true, cardinality: 'one' }
          ]
        }
      ],
      edges: [
        { from: { nodeId: 'n1', portId: 'out-text' }, to: { nodeId: 'n2', portId: 'in-text' } },
        { from: { nodeId: 'n2', portId: 'out-text' }, to: { nodeId: 'n3', portId: 'in-text' } }
      ]
    },
    dependencies: [
      { kind: 'node', id: 'text', contractVersion: 3 },
      { kind: 'node', id: 'ai-process', contractVersion: 1 },
      { kind: 'node', id: 'image-gen', contractVersion: 3 }
    ]
  }
}

describe('组合公开边界推导', () => {
  it('文本→AI→生图只得到 1 个文本输入和 1 个图片输出', () => {
    const boundary = deriveCompositeBoundary(manifest())
    expect(boundary.inputs).toHaveLength(1)
    expect(boundary.inputs[0]).toMatchObject({ type: 'text', targets: [{ nodeId: 'n1', portId: 'in-text' }] })
    expect(boundary.outputs).toHaveLength(1)
    expect(boundary.outputs[0]).toMatchObject({
      type: 'image',
      source: { nodeId: 'n3', portId: 'out-image' }
    })
  })

  it('中间 AI 节点的 markdown/json 不作为公开输出', () => {
    const boundary = deriveCompositeBoundary(manifest())
    expect(boundary.outputs.some((output) => output.type === 'markdown' || output.type === 'json')).toBe(false)
  })
})
