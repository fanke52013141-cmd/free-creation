import { describe, expect, it } from 'vitest'
import {
  imageCapabilitiesFor,
  normalizeImageGenerationConfig,
  sizesForImageAspectRatio
} from '@shared/image-capabilities'

describe('图片模型能力描述', () => {
  it('公开稳定的比例与尺寸映射，不把未知服务端参数伪装为可用', () => {
    const capabilities = imageCapabilitiesFor('relay', 'custom-image-model')
    expect(capabilities.ratios).toEqual(['auto', '1:1', '3:2', '2:3'])
    expect(sizesForImageAspectRatio(capabilities, '3:2')).toEqual([
      { value: '1536x1024', label: '1536 × 1024', ratio: '3:2' }
    ])
    expect(capabilities.forwardsAspectRatio).toBe(false)
  })

  it('旧 size-only 配置和模型切换后的无效值都归一为合法比例/尺寸组合', () => {
    const capabilities = imageCapabilitiesFor('relay')
    expect(
      normalizeImageGenerationConfig({ prompt: '海边', size: '1024x1536' }, capabilities)
    ).toMatchObject({
      aspectRatio: '2:3',
      size: '1024x1536'
    })
    expect(
      normalizeImageGenerationConfig({ aspectRatio: '1:1', size: '1536x1024' }, capabilities)
    ).toMatchObject({ aspectRatio: '1:1', size: '1024x1024' })
  })
})
