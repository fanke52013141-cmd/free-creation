// 即梦（Dreamina）能力表测试：分辨率必须可选、默认必须是最便宜档，
// 且模型差异（3.x 只能文生图、2.5 拒绝 ratio、2.0 家族禁止纯音频）都要落进能力表，
// 不能只靠 UI 隐藏。
import { describe, expect, it } from 'vitest'
import {
  cheapestImageResolution,
  imageCapabilitiesFor,
  normalizeImageGenerationConfig
} from '@shared/image-capabilities'
import {
  normalizeVideoGenParams,
  videoCapabilitiesFor,
  videoCapabilityIssues,
  videoRatioIsDerivedByFrames
} from '@shared/video-capabilities'

describe('即梦图片能力表', () => {
  it('5.0 只提供 2k/4k，并默认停在最便宜的 2k', () => {
    const caps = imageCapabilitiesFor('dreamina', '5.0')
    expect(caps.driver).toBe('dreamina-cli')
    expect(caps.referenceMode).toBe('local-path')
    expect(caps.resolutions).toEqual(['2k', '4k'])
    expect(caps.defaultResolution).toBe('2k')
    expect(caps.maxReferenceImages).toBe(10)
    expect(caps.ratios).not.toContain('auto')
    expect(caps.ratios).toHaveLength(8)
  })

  it('5.0Pro 多了 1.5k 档，并默认停在 1.5k', () => {
    const caps = imageCapabilitiesFor('dreamina', '5.0Pro')
    expect(caps.resolutions).toEqual(['1.5k', '2k', '4k'])
    expect(caps.defaultResolution).toBe('1.5k')
  })

  it('3.0 / 3.1 不支持图生图，参考图上限必须是 0', () => {
    for (const model of ['3.0', '3.1']) {
      const caps = imageCapabilitiesFor('dreamina', model)
      expect(caps.maxReferenceImages).toBe(0)
      expect(caps.supportsReferenceImages).toBe(false)
      expect(caps.resolutions).toEqual(['1k', '2k'])
      expect(caps.defaultResolution).toBe('1k')
    }
  })

  it('未知模型回退到 5.0 的保守能力集', () => {
    const caps = imageCapabilitiesFor('dreamina', 'not-a-model')
    expect(caps.resolutions).toEqual(['2k', '4k'])
  })

  it('归一化会给即梦补上默认分辨率（CLI 该参数必填）', () => {
    const config = normalizeImageGenerationConfig({}, imageCapabilitiesFor('dreamina', '3.1'))
    expect(config.resolution).toBe('1k')
  })

  it('不改变既有供应商行为：ToAPIS 未选分辨率时仍然不发送', () => {
    const config = normalizeImageGenerationConfig({}, imageCapabilitiesFor('toapis'))
    expect(config.resolution).toBeUndefined()
  })

  it('最便宜档按成本顺序取，不依赖数组书写顺序', () => {
    expect(cheapestImageResolution(['4k', '2k', '1k'])).toBe('1k')
    expect(cheapestImageResolution(['4k', '2k'])).toBe('2k')
    expect(cheapestImageResolution(['1.5k', '4k'])).toBe('1.5k')
  })
})

describe('即梦视频能力表', () => {
  it('seedance2.5：480p 起、4–30 秒、允许纯音频参考', () => {
    const caps = videoCapabilitiesFor('dreamina', 'seedance2.5')
    expect(caps.resolutions).toEqual(['480p', '720p', '1080p'])
    expect(caps.defaultResolution).toBe('480p')
    expect(Math.min(...caps.durations)).toBe(4)
    expect(Math.max(...caps.durations)).toBe(30)
    expect(caps.defaultDuration).toBe(4)
    expect(caps.requiresVisualReference).toBe(false)
  })

  it('seedance2.0_vip 有 4k，但默认停在最便宜的 720p', () => {
    const caps = videoCapabilitiesFor('dreamina', 'seedance2.0_vip')
    expect(caps.resolutions).toEqual(['720p', '1080p', '4k'])
    expect(caps.defaultResolution).toBe('720p')
  })

  it('其余 2.0 型号只开放 720p（想省也省不了，属于供应商限制）', () => {
    for (const model of ['seedance2.0', 'seedance2.0fast', 'seedance2.0mini']) {
      const caps = videoCapabilitiesFor('dreamina', model)
      expect(caps.resolutions).toEqual(['720p'])
      expect(caps.defaultResolution).toBe('720p')
    }
  })

  it('1.5pro 允许多图模式但没有参考端口；1.0fast 只能首帧', () => {
    const pro = videoCapabilitiesFor('dreamina', 'seedance1.5pro')
    expect(pro.modes).toEqual(['text', 'first-frame', 'first-last-frame'])
    expect(pro.maxReferenceImages).toBe(0)
    expect(pro.durations[0]).toBe(5)

    const fast = videoCapabilitiesFor('dreamina', 'seedance1.0fast')
    expect(fast.modes).toEqual(['first-frame'])
    expect(fast.durations).toEqual([5, 6, 7, 8, 9, 10])
  })

  it('2.5 在首帧/首尾帧下不发送 ratio，2.0 仍然发送', () => {
    expect(videoRatioIsDerivedByFrames('dreamina', 'seedance2.5', true)).toBe(true)
    expect(videoRatioIsDerivedByFrames('dreamina', 'seedance2.0_vip', true)).toBe(false)
    expect(videoRatioIsDerivedByFrames('dreamina', 'seedance2.5', false)).toBe(false)
  })

  it('2.0 家族参考模式禁止纯音频，2.5 允许', () => {
    const audioOnly = {
      mode: 'reference' as const,
      imageCount: 0,
      referenceImageCount: 0,
      referenceVideoCount: 0,
      referenceAudioCount: 1
    }
    const issues20 = videoCapabilityIssues(videoCapabilitiesFor('dreamina', 'seedance2.0'), {
      ...audioOnly,
      params: normalizeVideoGenParams(videoCapabilitiesFor('dreamina', 'seedance2.0'))
    })
    expect(issues20.join()).toContain('至少需要 1 张图片或 1 段视频')

    const issues25 = videoCapabilityIssues(videoCapabilitiesFor('dreamina', 'seedance2.5'), {
      ...audioOnly,
      params: normalizeVideoGenParams(videoCapabilitiesFor('dreamina', 'seedance2.5'))
    })
    expect(issues25.join()).not.toContain('至少需要 1 张图片或 1 段视频')
  })

  it('时长与清晰度默认值永远取最便宜的一档', () => {
    const caps = videoCapabilitiesFor('dreamina', 'seedance2.0fast')
    const params = normalizeVideoGenParams(caps, {})
    expect(params.resolution).toBe('720p')
    expect(params.duration).toBe(4)
    expect(params.ratio).toBe('16:9')
  })
})
