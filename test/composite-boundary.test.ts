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
          id: 'n1',
          nodeType: 'text',
          contractVersion: 3,
          title: '文本',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          ports: [
            {
              id: 'in-text',
              name: '文本',
              dir: 'in',
              type: 'text',
              required: false,
              cardinality: 'many'
            },
            {
              id: 'out-text',
              name: '文本',
              dir: 'out',
              type: 'text',
              required: true,
              cardinality: 'one'
            }
          ]
        },
        {
          id: 'n2',
          nodeType: 'ai-process',
          contractVersion: 1,
          title: 'AI 处理',
          dx: 400,
          dy: 0,
          w: 340,
          h: 300,
          ports: [
            {
              id: 'in-text',
              name: '文本',
              dir: 'in',
              type: 'text',
              required: false,
              cardinality: 'many'
            },
            {
              id: 'out-text',
              name: '文本',
              dir: 'out',
              type: 'text',
              required: true,
              cardinality: 'one'
            },
            {
              id: 'out-markdown',
              name: 'Markdown',
              dir: 'out',
              type: 'markdown',
              required: false,
              cardinality: 'one'
            },
            {
              id: 'out-json',
              name: 'JSON',
              dir: 'out',
              type: 'json',
              required: false,
              cardinality: 'one'
            }
          ]
        },
        {
          id: 'n3',
          nodeType: 'image-gen',
          contractVersion: 3,
          title: '生图',
          dx: 800,
          dy: 0,
          w: 340,
          h: 300,
          ports: [
            {
              id: 'in-text',
              name: '提示词',
              dir: 'in',
              type: 'text',
              required: false,
              cardinality: 'many'
            },
            {
              id: 'out-image',
              name: '图片',
              dir: 'out',
              type: 'image',
              required: true,
              cardinality: 'one'
            }
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
    expect(boundary.inputs[0]).toMatchObject({
      type: 'text',
      targets: [{ nodeId: 'n1', portId: 'in-text' }]
    })
    expect(boundary.outputs).toHaveLength(1)
    expect(boundary.outputs[0]).toMatchObject({
      type: 'image',
      source: { nodeId: 'n3', portId: 'out-image' }
    })
  })

  it('中间 AI 节点的 markdown/json 不作为公开输出', () => {
    const boundary = deriveCompositeBoundary(manifest())
    expect(
      boundary.outputs.some((output) => output.type === 'markdown' || output.type === 'json')
    ).toBe(false)
  })
})

/** AI 处理作首节点（源节点）→ 生图（汇节点）：真实契约下 ai-process 输入皆可选。 */
function aiFirstManifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId: 'ai-to-image',
    version: '1.0',
    name: 'AI 处理生图',
    inputs: [],
    outputs: [],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'ai-process',
          contractVersion: 1,
          title: 'AI 处理',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          ports: [
            {
              id: 'in-text',
              name: '文本',
              dir: 'in',
              type: 'text',
              required: false,
              cardinality: 'many'
            },
            {
              id: 'in-json',
              name: 'JSON',
              dir: 'in',
              type: 'json',
              required: false,
              cardinality: 'one'
            },
            {
              id: 'out-text',
              name: '文本',
              dir: 'out',
              type: 'text',
              required: false,
              cardinality: 'one'
            }
          ]
        },
        {
          id: 'n2',
          nodeType: 'image-gen',
          contractVersion: 3,
          title: '生图',
          dx: 400,
          dy: 0,
          w: 340,
          h: 300,
          ports: [
            {
              id: 'in-text',
              name: '提示词',
              dir: 'in',
              type: 'text',
              required: false,
              cardinality: 'many'
            },
            {
              id: 'out-image',
              name: '图片',
              dir: 'out',
              type: 'image',
              required: true,
              cardinality: 'one'
            }
          ]
        }
      ],
      edges: [
        { from: { nodeId: 'n1', portId: 'out-text' }, to: { nodeId: 'n2', portId: 'in-text' } }
      ]
    },
    dependencies: [
      { kind: 'node', id: 'ai-process', contractVersion: 1 },
      { kind: 'node', id: 'image-gen', contractVersion: 3 }
    ]
  }
}

describe('组合公开边界推导：单主输入黑盒（2026-11-13 裁决）', () => {
  it('AI 处理作首节点时只公开一个主输入（文本），辅助 in-json 不自动公开', () => {
    const boundary = deriveCompositeBoundary(aiFirstManifest())
    expect(boundary.inputs).toHaveLength(1)
    expect(boundary.inputs[0]).toMatchObject({
      type: 'text',
      required: true,
      targets: [{ nodeId: 'n1', portId: 'in-text' }]
    })
    // 辅助可选端口（JSON 上下文）不再自动公开，避免默认出现 2 输入。
    expect(boundary.inputs.some((input) => input.targets[0]?.portId === 'in-json')).toBe(false)
  })

  it('主输入标必填以触发补输入弹窗，保留源端口 cardinality', () => {
    const boundary = deriveCompositeBoundary(aiFirstManifest())
    const textInput = boundary.inputs[0]
    expect(textInput.required).toBe(true)
    expect(textInput.cardinality).toBe('many')
  })

  it('输出仍取末节点（生图）的主输出图片', () => {
    const boundary = deriveCompositeBoundary(aiFirstManifest())
    expect(boundary.outputs).toHaveLength(1)
    expect(boundary.outputs[0]).toMatchObject({
      type: 'image',
      source: { nodeId: 'n2', portId: 'out-image' }
    })
  })

  it('多个源节点（多种输入进来）才分裂成多个公开输入', () => {
    const base = aiFirstManifest()
    // 增加第二个源 AI 处理节点 n0，其输出也喂入生图 n2 的 many 文本输入。
    const secondSource = {
      ...base.graph.nodes[0],
      id: 'n0',
      title: 'AI 处理 2',
      dx: -400
    }
    const manifest: CompositeManifest = {
      ...base,
      graph: {
        nodes: [secondSource, ...base.graph.nodes],
        edges: [
          ...base.graph.edges,
          { from: { nodeId: 'n0', portId: 'out-text' }, to: { nodeId: 'n2', portId: 'in-text' } }
        ]
      }
    }
    const boundary = deriveCompositeBoundary(manifest)
    expect(boundary.inputs).toHaveLength(2)
    expect(boundary.inputs.map((input) => input.targets[0]?.nodeId).sort()).toEqual(['n0', 'n1'])
    expect(boundary.inputs.every((input) => input.required)).toBe(true)
    expect(boundary.outputs).toHaveLength(1)
  })
})
