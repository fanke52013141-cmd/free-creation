import { describe, expect, it } from 'vitest'
import { planCompositeUpgrade } from '../src/shared/composite/upgrade'
import type { CompositeManifest } from '../src/shared/composite/manifest'

function manifest(patch: Partial<CompositeManifest> = {}): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId: 'character-design',
    version: '1.0',
    name: '人物设计',
    inputs: [
      { id: 'requirements', label: '人物要求', type: 'text', required: true, cardinality: 'one', targets: [{ nodeId: 'n1', portId: 'in-text' }] }
    ],
    outputs: [
      { id: 'portrait', label: '人物设计图', type: 'image', required: true, cardinality: 'one', source: { nodeId: 'n2', portId: 'out-image' } }
    ],
    graph: {
      nodes: [
        { id: 'n1', nodeType: 'text', contractVersion: 1, title: '文本', dx: 0, dy: 0, w: 340, h: 260 },
        { id: 'n2', nodeType: 'image-gen', contractVersion: 1, title: '生图', dx: 380, dy: 0, w: 340, h: 260 }
      ],
      edges: []
    },
    ...patch
  }
}

describe('组合实例版本升级（P4）', () => {
  it('新增可选输入/描述变化是兼容升级', () => {
    const next = manifest({
      version: '2.0',
      inputs: [
        ...manifest().inputs,
        { id: 'style', label: '风格', type: 'text', required: false, cardinality: 'one', targets: [{ nodeId: 'n1', portId: 'in-text' }] }
      ]
    })
    const plan = planCompositeUpgrade(manifest(), next, [])
    expect(plan.ok).toBe(true)
    expect(plan.impact.addedInputs).toEqual(['in-style'])
  })

  it('删除已连接输出会阻断升级', () => {
    const next = manifest({ version: '2.0', outputs: [] as never })
    const plan = planCompositeUpgrade(manifest(), next, [
      { dir: 'out', portId: 'out-portrait', type: 'image', cardinality: 'one' }
    ])
    expect(plan.ok).toBe(false)
    expect(plan.impact.breaking[0].portId).toBe('out-portrait')
  })

  it('已连接端口类型变化阻断；未连接端口类型变化只记录影响', () => {
    const next = manifest({ version: '2.0' })
    next.outputs[0].type = 'video'
    const unconnected = planCompositeUpgrade(manifest(), next, [])
    expect(unconnected.ok).toBe(true)
    expect(unconnected.impact.typeChanged[0]).toMatchObject({ portId: 'out-portrait', from: 'image', to: 'video' })

    const connected = planCompositeUpgrade(manifest(), next, [
      { dir: 'out', portId: 'out-portrait', type: 'image', cardinality: 'one' }
    ])
    expect(connected.ok).toBe(false)
  })
})
