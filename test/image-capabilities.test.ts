import { describe, expect, it } from 'vitest'
import {
  ALL_IMAGE_ASPECT_RATIOS,
  imageCapabilitiesFor,
  imageEditSendsAspectRatio,
  imageEditSendsMask,
  isImageAspectRatio,
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
    expect(normalizeImageGenerationConfig({ size: '1024x1536' }, capabilities)).toMatchObject({
      aspectRatio: '9:16',
      size: 'auto'
    })
    expect(
      normalizeImageGenerationConfig({ aspectRatio: '1:1', size: '1536x1024' }, capabilities)
    ).toMatchObject({ aspectRatio: '1:1', size: '1024x1024' })
  })

  it('ToAPIS：13 种画幅 + 1k/2k/4k + 固定 low 质量 + 上传换 URL 的任务驱动', () => {
    const capabilities = imageCapabilitiesFor('toapis')
    expect(capabilities.ratios).toEqual([
      'auto',
      '1:1',
      '3:2',
      '2:3',
      '4:3',
      '3:4',
      '5:4',
      '4:5',
      '16:9',
      '9:16',
      '2:1',
      '1:2',
      '21:9',
      '9:21'
    ])
    expect(capabilities.resolutions).toEqual(['1k', '2k', '4k'])
    // 官方文档的提交字段是封闭集合，quality 只属于 -vip / -official，普通 gpt-image-2 不发。
    expect(capabilities.supportsQuality).toBe(false)
    expect(capabilities.supportsTransparentBackground).toBe(true)
    expect(capabilities.maxPromptChars).toBe(32000)
    expect(capabilities.maxReferenceImages).toBe(6)
    expect(capabilities.driver).toBe('toapis-task')
    expect(capabilities.referenceMode).toBe('upload-url')
    // ToAPIS 的 size 直接提交比例串
    expect(sizesForImageAspectRatio(capabilities, '16:9')).toEqual([
      { value: '16:9', label: '16:9', ratio: '16:9' }
    ])
  })

  it('OpenAI 官方：固定像素尺寸，无分辨率档，质量固定 low', () => {
    const capabilities = imageCapabilitiesFor('openai')
    expect(capabilities.ratios).toEqual(['auto', '1:1', '3:2', '2:3'])
    expect(capabilities.resolutions).toEqual([])
    expect(capabilities.supportsQuality).toBe(true)
    expect(capabilities.forwardsAspectRatio).toBe(false)
    expect(capabilities.driver).toBe('openai-images')
    expect(sizesForImageAspectRatio(capabilities, '3:2')).toEqual([
      { value: '1536x1024', label: '1536 × 1024', ratio: '3:2' }
    ])
  })

  it('OpenRouter：chat 生图驱动，尺寸类参数在验证前不开放', () => {
    const capabilities = imageCapabilitiesFor('openrouter')
    expect(capabilities.ratios).toEqual(['auto'])
    expect(capabilities.resolutions).toEqual([])
    expect(capabilities.supportsQuality).toBe(false)
    expect(capabilities.driver).toBe('openrouter-chat')
    expect(capabilities.referenceMode).toBe('chat-inline')
  })

  it('ToAPIS 上保留 3:2/2:3 原生比例，非原生供应商沿用旧迁移', () => {
    expect(
      normalizeImageGenerationConfig({ aspectRatio: '3:2' }, imageCapabilitiesFor('toapis'))
    ).toMatchObject({
      aspectRatio: '3:2',
      size: '3:2'
    })
    expect(
      normalizeImageGenerationConfig({ aspectRatio: '3:2' }, imageCapabilitiesFor('relay'))
    ).toMatchObject({
      aspectRatio: '16:9'
    })
  })

  it('ToAPIS 上的旧像素配置迁移为等比比例串', () => {
    expect(
      normalizeImageGenerationConfig(
        { modelKey: 'p::gpt-image-2', size: '1024x1024', aspectRatio: '1:1' },
        imageCapabilitiesFor('toapis')
      )
    ).toMatchObject({ aspectRatio: '1:1', size: '1:1' })
  })

  it('分辨率是跨供应商保留的用户意图；非法值剔除', () => {
    // relay 不支持分辨率，但配置保留，切回 ToAPIS 时仍生效
    expect(
      normalizeImageGenerationConfig({ resolution: '4k' }, imageCapabilitiesFor('relay'))
    ).toMatchObject({
      resolution: '4k'
    })
    expect(
      normalizeImageGenerationConfig({ resolution: '8k' }, imageCapabilitiesFor('toapis'))
    ).not.toHaveProperty('resolution')
  })

  it('providerKey 合法保留、非法剔除', () => {
    expect(
      normalizeImageGenerationConfig({ providerKey: 'abc123' }, imageCapabilitiesFor('relay'))
    ).toMatchObject({ providerKey: 'abc123' })
    const invalid = normalizeImageGenerationConfig(
      { providerKey: 123 as unknown as string },
      imageCapabilitiesFor('relay')
    )
    expect(invalid).not.toHaveProperty('providerKey')
  })

  it('生成数量默认一张，并严格收敛到 1–9 张', () => {
    const capabilities = imageCapabilitiesFor('relay')
    expect(normalizeImageGenerationConfig({}, capabilities).count).toBe(1)
    expect(normalizeImageGenerationConfig({ count: 0 }, capabilities).count).toBe(1)
    expect(normalizeImageGenerationConfig({ count: 3.8 }, capabilities).count).toBe(3)
    expect(normalizeImageGenerationConfig({ count: 99 }, capabilities).count).toBe(9)
  })

  it('中转站配置的 gpt-image-2 自动匹配 ToAPIS 异步任务与分辨率能力', () => {
    const capabilities = imageCapabilitiesFor('relay', 'gpt-image-2')
    expect(capabilities.driver).toBe('toapis-task')
    expect(capabilities.referenceMode).toBe('upload-url')
    expect(capabilities.resolutions).toEqual(['1k', '2k', '4k'])
    expect(capabilities.ratios).toContain('16:9')
    expect(capabilities.ratios).toContain('3:2')
  })
})

// P 图上「遮罩」「画幅」两个控件的可见性来源：网关会不会把该字段写进请求。
describe('P 图能力门禁：控件只在真正会发送的通道上出现', () => {
  it('ToAPIS 异步任务的提交字段是封闭集合：没有 mask，但比例写进 size', () => {
    const capabilities = imageCapabilitiesFor('toapis')
    expect(imageEditSendsMask(capabilities)).toBe(false)
    expect(imageEditSendsAspectRatio(capabilities)).toBe(true)
  })

  it('中转站上的 gpt-image-2 同属任务通道：遮罩一样不发', () => {
    const capabilities = imageCapabilitiesFor('relay', 'gpt-image-2')
    expect(imageEditSendsMask(capabilities)).toBe(false)
    expect(imageEditSendsAspectRatio(capabilities)).toBe(true)
  })

  it('兼容网关声明透传 aspectRatio 时遮罩与画幅都发送', () => {
    const capabilities = imageCapabilitiesFor('relay', 'custom-image-model')
    expect(capabilities.forwardsAspectRatio).toBe(true)
    expect(imageEditSendsMask(capabilities)).toBe(true)
    expect(imageEditSendsAspectRatio(capabilities)).toBe(true)
  })

  it('OpenAI 官方与 OpenRouter 不接收画幅参数，只有遮罩可用', () => {
    for (const specId of ['openai', 'openrouter'] as const) {
      const capabilities = imageCapabilitiesFor(specId)
      expect(imageEditSendsMask(capabilities)).toBe(true)
      expect(imageEditSendsAspectRatio(capabilities)).toBe(false)
    }
  })

  it('P 图可选画幅只有一处来源：直接取能力表 ratios', () => {
    expect(isImageAspectRatio('16:9')).toBe(true)
    expect(isImageAspectRatio('auto')).toBe(true)
    // 像素尺寸不是比例：混进 size 时按旧数据收敛，不能当成画幅。
    expect(isImageAspectRatio('1024x1024')).toBe(false)
    expect(isImageAspectRatio(undefined)).toBe(false)
    expect([...imageCapabilitiesFor('toapis').ratios]).toEqual([...ALL_IMAGE_ASPECT_RATIOS])
  })
})
