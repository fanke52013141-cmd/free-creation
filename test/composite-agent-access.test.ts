import { describe, expect, it } from 'vitest'
import { ACCESS_OPERATIONS } from '../src/shared/agent-access/registry'
import { COMPOSITE_OPERATIONS, COMPOSITE_OUTPUTS } from '../src/shared/agent-access/ops/composite'
import { validateCompositeManifest } from '../src/shared/composite/validate'
import type { CompositeManifest } from '../src/shared/composite/manifest'

function manifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId: 'character-design',
    version: '1.0',
    name: '人物设计',
    inputs: [
      {
        id: 'requirements',
        label: '人物要求',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'portrait',
        label: '人物设计图',
        type: 'image',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n3', portId: 'out-image' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'text',
          contractVersion: 1,
          title: '人物要求',
          dx: 0,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            {
              id: 'in-text',
              name: '人物要求',
              dir: 'in',
              type: 'text',
              required: true,
              cardinality: 'one'
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
          id: 'n3',
          nodeType: 'image-gen',
          contractVersion: 1,
          title: '生成人物图',
          dx: 380,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            {
              id: 'in-prompt',
              name: '提示词',
              dir: 'in',
              type: 'text',
              required: true,
              cardinality: 'one'
            },
            {
              id: 'out-image',
              name: '人物设计图',
              dir: 'out',
              type: 'image',
              required: true,
              cardinality: 'one'
            }
          ]
        }
      ],
      edges: [
        {
          from: { nodeId: 'n1', portId: 'out-text' },
          to: { nodeId: 'n3', portId: 'in-prompt' }
        }
      ]
    },
    dependencies: [
      { kind: 'node', id: 'text', contractVersion: 1 },
      { kind: 'node', id: 'image-gen', contractVersion: 1 }
    ]
  }
}

describe('组合能力 Agent 契约（P1 对等）', () => {
  it('composite.* 二十项操作全部进入统一 Registry，输入输出成对', () => {
    expect(Object.keys(COMPOSITE_OPERATIONS)).toHaveLength(20)
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.upgrade.apply')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.references')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.delete')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.execute')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.execute.wait')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.run.submitHuman')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.run.resume')
    for (const id of Object.keys(COMPOSITE_OPERATIONS)) {
      expect(ACCESS_OPERATIONS).toHaveProperty(id)
      expect(COMPOSITE_OUTPUTS).toHaveProperty(id)
    }
  })

  it('校验规则与 GUI 相同：类型不兼容、缺必填来源、单值端口多连线都拒绝', () => {
    expect(validateCompositeManifest(manifest()).ok).toBe(true)
    const badType = manifest()
    badType.inputs[0].type = 'image'
    expect(validateCompositeManifest(badType).issues.map((issue) => issue.code)).toContain(
      'PORT_TYPE_MISMATCH'
    )
    const unbound = manifest()
    unbound.inputs = []
    expect(validateCompositeManifest(unbound).issues.map((issue) => issue.code)).toContain(
      'REQUIRED_INPUT_UNBOUND'
    )
  })
})
