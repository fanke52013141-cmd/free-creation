import { describe, expect, it } from 'vitest'
import {
  imageCapabilitiesFor,
  normalizeImageGenerationConfig,
  sizesForImageAspectRatio
} from '@shared/image-capabilities'

describe('图片模型能力描述', () => {
  it('公开稳定的常用画幅意图，并保留自动尺寸回退', () => {
    const capabilities = imageCapabilitiesFor('relay', 'custom-image-model')
    expect(capabilities.ratios).toEqual(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '21:9'])
    expect(sizesForImageAspectRatio(capabilities, '16:9')).toEqual([
      { value: 'auto', label: '自动尺寸（16:9）', ratio: '16:9' }
    ])
    expect(capabilities.forwardsAspectRatio).toBe(true)
  })

  it('旧 size-only 配置和模型切换后的无效值都归一为合法比例/尺寸组合', () => {
    const capabilities = imageCapabilitiesFor('relay')
    expect(
      normalizeImageGenerationConfig({ prompt: '海边', size: '1024x1536' }, capabilities)
    ).toMatchObject({
      aspectRatio: '9:16',
      size: 'auto'
    })
    expect(
      normalizeImageGenerationConfig({ aspectRatio: '1:1', size: '1536x1024' }, capabilities)
    ).toMatchObject({ aspectRatio: '1:1', size: '1024x1024' })
  })
})
