import { describe, expect, it } from 'vitest'
import {
  buildContextManifest,
  contextManifestBlocking,
  ContextManifestSchema
} from '../src/shared/agent-flow/context-manifest'
import { StageInputsSchema, type StageDeliveryFact } from '../src/shared/agent-flow/stage-contracts'

const inputs = (over: Record<string, unknown> = {}) =>
  StageInputsSchema.parse({
    selectors: [{ sourceStageKey: 'organize', path: 'evidence' }],
    ...over
  })

const deliveries = (outputs: StageDeliveryFact['outputs']): StageDeliveryFact[] => [
  { stageKey: 'organize', nodeId: 's1', outputs, humanDecided: false }
]

const jsonDelivery = (data: unknown) => deliveries([{ kind: 'json', data }])

describe('AF-02 ContextManifest 编制器', () => {
  it('按字段路径取内容，去重保序，产出稳定 hash', () => {
    const manifest = buildContextManifest(
      'write',
      inputs(),
      jsonDelivery({ evidence: [{ src: 'a' }], other: 'x' })
    )
    expect(ContextManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0].value).toEqual([{ src: 'a' }])
    expect(manifest.entries[0].kind).toBe('json')
    expect(manifest.missing).toEqual([])
    expect(manifest.budget.exceeded).toBe(false)
    expect(manifest.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    // 同输入重复编制 hash 稳定
    const again = buildContextManifest('write', inputs(), jsonDelivery({ evidence: [{ src: 'a' }], other: 'x' }))
    expect(again.manifestHash).toBe(manifest.manifestHash)
  })

  it('长材料只取声明字段，无关字段不进入 manifest', () => {
    const big = 'x'.repeat(50000)
    const manifest = buildContextManifest(
      'write',
      inputs(),
      jsonDelivery({ evidence: ['必需'], noise: big })
    )
    expect(manifest.entries).toHaveLength(1)
    expect(JSON.stringify(manifest.entries)).not.toContain(big)
    expect(manifest.budget.usedBytes).toBeLessThan(1000)
  })

  it('文本交付根为 { text }，空 path 取整值', () => {
    const manifest = buildContextManifest(
      'write',
      StageInputsSchema.parse({ selectors: [{ sourceStageKey: 'organize', path: 'text' }] }),
      deliveries([{ kind: 'text', text: '成稿正文' }])
    )
    expect(manifest.entries[0].value).toBe('成稿正文')
    expect(manifest.entries[0].kind).toBe('text')
  })

  it('缺交付/缺字段 → 稳定缺项原因；必需缺项阻断', () => {
    const noDelivery = buildContextManifest('write', inputs(), [])
    expect(noDelivery.missing[0].code).toBe('DELIVERY_MISSING')
    expect(contextManifestBlocking(noDelivery)).toBe(true)
    const noField = buildContextManifest('write', inputs(), jsonDelivery({ other: 1 }))
    expect(noField.missing[0].code).toBe('FIELD_MISSING')
    expect(contextManifestBlocking(noField)).toBe(true)
    // 可选缺项不阻断
    const optional = buildContextManifest(
      'write',
      StageInputsSchema.parse({ selectors: [{ sourceStageKey: 'organize', path: 'absent', required: false }] }),
      jsonDelivery({ other: 1 })
    )
    expect(contextManifestBlocking(optional)).toBe(false)
  })

  it('超预算：可选丢弃记 dropped，必需超限标记 exceeded 不静默截断', () => {
    const optionalInputs = StageInputsSchema.parse({
      budgetBytes: 2048,
      selectors: [
        { sourceStageKey: 'organize', path: 'required', required: true },
        { sourceStageKey: 'organize', path: 'optional', required: false }
      ]
    })
    const manifest = buildContextManifest(
      'write',
      optionalInputs,
      jsonDelivery({ required: 'r'.repeat(100), optional: 'o'.repeat(5000) })
    )
    expect(manifest.entries.map((e) => e.path)).toEqual(['required'])
    expect(manifest.dropped).toHaveLength(1)
    expect(manifest.budget.exceeded).toBe(false)
    // 必需内容本身超限 → exceeded
    const overRequired = buildContextManifest(
      'write',
      StageInputsSchema.parse({ budgetBytes: 2048, selectors: [{ sourceStageKey: 'organize', path: 'required' }] }),
      jsonDelivery({ required: 'r'.repeat(5000) })
    )
    expect(overRequired.budget.exceeded).toBe(true)
    expect(contextManifestBlocking(overRequired)).toBe(true)
    expect(overRequired.entries).toHaveLength(1) // 必需内容保留，不截断
  })

  it('模型容量与声明预算取较小值', () => {
    const manifest = buildContextManifest(
      'write',
      StageInputsSchema.parse({ budgetBytes: 100000, selectors: [{ sourceStageKey: 'organize', path: 'v', required: false }] }),
      jsonDelivery({ v: 'x'.repeat(2000) }),
      { modelCapacityBytes: 1024 }
    )
    expect(manifest.budget.limitBytes).toBe(1024)
    expect(manifest.dropped).toHaveLength(1)
  })

  it('去重：不同路径同内容只保留一份；重复选择器在 Schema 层被拒', () => {
    expect(
      StageInputsSchema.safeParse({
        selectors: [
          { sourceStageKey: 'organize', path: 'a' },
          { sourceStageKey: 'organize', path: 'a' }
        ]
      }).success
    ).toBe(false)
    const manifest = buildContextManifest(
      'write',
      StageInputsSchema.parse({
        selectors: [
          { sourceStageKey: 'organize', path: 'a' },
          { sourceStageKey: 'organize', path: 'b' }
        ]
      }),
      jsonDelivery({ a: 1, b: 1 })
    )
    expect(manifest.entries).toHaveLength(1)
  })
})