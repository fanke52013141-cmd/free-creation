import { describe, expect, it } from 'vitest'
import { apiKeyPreview } from '../src/shared/security/api-key-preview'

describe('API Key 脱敏预览', () => {
  it('长密钥只显示首尾各 5 位，中间隐藏', () => {
    expect(apiKeyPreview('sk-abcdefghijklmnopqrstuvwxyz')).toBe('sk-ab…vwxyz')
    expect(apiKeyPreview('12345678901234567890')).toBe('12345…67890')
  })

  it('长度刚好 11 位时按 5+5 展示', () => {
    expect(apiKeyPreview('abcdefghijk')).toBe('abcde…ghijk')
  })

  it('短密钥降级为首尾各 2 位，避免 5+5 等于完整泄露', () => {
    expect(apiKeyPreview('1234567890')).toBe('12…90')
    expect(apiKeyPreview('abc')).toBe('ab…bc')
  })

  it('空值返回 undefined，前后空白会被忽略', () => {
    expect(apiKeyPreview('')).toBeUndefined()
    expect(apiKeyPreview('   ')).toBeUndefined()
    expect(apiKeyPreview(null)).toBeUndefined()
    expect(apiKeyPreview('  sk-abcdefghijklmnopqrstuvwxyz  ')).toBe('sk-ab…vwxyz')
  })
})
