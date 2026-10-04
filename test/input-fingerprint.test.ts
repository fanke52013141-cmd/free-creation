// T09（F08）：输入新鲜度指纹。固化：字段变化会改指纹、顺序变化会改指纹、
// 无关字段（标题/坐标）不影响。
import { describe, expect, it } from 'vitest'
import { computeInputFingerprint } from '@shared/engine/input-fingerprint'

const fp = (overrides?: Partial<Parameters<typeof computeInputFingerprint>[0]>): string =>
  computeInputFingerprint({
    contractVersion: 3,
    config: '{"count":1}',
    text: '蓝色立方体',
    sources: [{ portId: 'in-text', nodeId: 'shape:a' }],
    ...overrides
  })

describe('computeInputFingerprint', () => {
  it('相同输入产生相同指纹', () => {
    expect(fp()).toBe(fp())
  })

  it('正文变化改变指纹', () => {
    expect(fp()).not.toBe(fp({ text: '红色球体' }))
  })

  it('配置变化改变指纹', () => {
    expect(fp()).not.toBe(fp({ config: '{"count":2}' }))
  })

  it('上游连线顺序变化改变指纹', () => {
    expect(fp()).not.toBe(fp({ sources: [{ portId: 'in-text', nodeId: 'shape:b' }] }))
  })

  it('标题/坐标等无关字段不影响指纹（不传入即可）', () => {
    expect(fp()).toBe(fp({ config: '{"count":1}' }))
  })

  it('契约版本变化改变指纹', () => {
    expect(fp()).not.toBe(fp({ contractVersion: 4 }))
  })
  it('配置格式与键顺序变化不代表输入变化', () => {
    expect(fp({ config: '{"a":1,"b":2}' })).toBe(fp({ config: '{ "b":2, "a":1 }' }))
  })
  it('多值输入的顺序变化必须使结果过期', () => {
    const a = { portId: 'in-text', nodeId: 'shape:a' }
    const b = { portId: 'in-text', nodeId: 'shape:b' }
    expect(fp({ sources: [a, b] })).not.toBe(fp({ sources: [b, a] }))
  })
})
