// 即梦（Dreamina）能力表与可用模型白名单测试。
//
// 两条不变量：
//   1. 分辨率必须可选，且默认停在最便宜档（成本由用户主动加档才增加）；
//   2. 白名单外的型号（3.x/4.x 图片、1.x/2.0/2.0fast 视频）必须能力全空 + 执行期被拒，
//      不能因为老配置里还留着就"看起来能跑"。
import { describe, expect, it } from 'vitest'
import { PROVIDER_SPECS } from '@shared/types'
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
import {
  dreaminaUnsupportedModelMessage,
  isDreaminaImageModel,
  isDreaminaModelSupported,
  isDreaminaVideoModel
} from '@shared/dreamina-models'

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

  it('归一化会给即梦补上默认分辨率（CLI 该参数必填）', () => {
    expect(normalizeImageGenerationConfig({}, imageCapabilitiesFor('dreamina', '5.0')).resolution).toBe(
      '2k'
    )
    expect(
      normalizeImageGenerationConfig({}, imageCapabilitiesFor('dreamina', '5.0Pro')).resolution
    ).toBe('1.5k')
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

  it('已下线的 3.x / 4.x 返回空能力集，不提供任何可提交组合', () => {
    for (const model of ['3.0', '3.1', '4.0', '4.5', '4.7']) {
      const caps = imageCapabilitiesFor('dreamina', model)
      expect(caps.resolutions).toEqual([])
      expect(caps.ratios).toEqual([])
      expect(caps.maxReferenceImages).toBe(0)
      expect(caps.defaultResolution).toBeUndefined()
    }
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

  it('2.0fast_vip 与 2.0mini 只开放 720p，但四种模式都在', () => {
    for (const model of ['seedance2.0fast_vip', 'seedance2.0mini']) {
      const caps = videoCapabilitiesFor('dreamina', model)
      expect(caps.resolutions).toEqual(['720p'])
      expect(caps.defaultResolution).toBe('720p')
      expect(caps.modes).toEqual(['text', 'first-frame', 'first-last-frame', 'reference'])
    }
  })

  it('2.5 在首帧/首尾帧下不发送 ratio，其他型号仍然发送', () => {
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
    const caps20 = videoCapabilitiesFor('dreamina', 'seedance2.0_vip')
    const issues20 = videoCapabilityIssues(caps20, {
      ...audioOnly,
      params: normalizeVideoGenParams(caps20)
    })
    expect(issues20.join()).toContain('至少需要 1 张图片或 1 段视频')

    const caps25 = videoCapabilitiesFor('dreamina', 'seedance2.5')
    const issues25 = videoCapabilityIssues(caps25, {
      ...audioOnly,
      params: normalizeVideoGenParams(caps25)
    })
    expect(issues25.join()).not.toContain('至少需要 1 张图片或 1 段视频')
  })

  it('时长与清晰度默认值永远取最便宜的一档', () => {
    const caps = videoCapabilitiesFor('dreamina', 'seedance2.0_vip')
    const params = normalizeVideoGenParams(caps, {})
    expect(params.resolution).toBe('720p')
    expect(params.duration).toBe(4)
    expect(params.ratio).toBe('16:9')
  })

  it('已禁用的视频型号不提供任何生成模式', () => {
    for (const model of ['seedance2.0', 'seedance2.0fast', 'seedance1.5pro', 'seedance1.0fast']) {
      const caps = videoCapabilitiesFor('dreamina', model)
      expect(caps.modes).toEqual([])
      expect(caps.maxReferenceImages).toBe(0)
      expect(isDreaminaVideoModel(model)).toBe(false)
    }
  })
})

describe('可用模型白名单', () => {
  it('图片只认 5.0 与 5.0Pro', () => {
    expect(isDreaminaImageModel('5.0')).toBe(true)
    expect(isDreaminaImageModel('5.0Pro')).toBe(true)
    expect(isDreaminaImageModel('5.0pro')).toBe(true)
    expect(isDreaminaImageModel('4.7')).toBe(false)
    expect(isDreaminaImageModel('3.0')).toBe(false)
  })

  it('视频只认 2.5 / 2.0_vip / 2.0fast_vip / 2.0mini', () => {
    for (const model of ['seedance2.5', 'seedance2.0_vip', 'seedance2.0fast_vip', 'seedance2.0mini'])
      expect(isDreaminaVideoModel(model)).toBe(true)
    for (const model of ['seedance2.0', 'seedance2.0fast', 'seedance1.5pro'])
      expect(isDreaminaVideoModel(model)).toBe(false)
  })

  it('禁用型号的错误文案要给出可用清单', () => {
    const message = dreaminaUnsupportedModelMessage('seedance2.0fast')
    expect(message).toContain('已禁用')
    expect(message).toContain('seedance2.5')
    expect(message).toContain('5.0Pro')
  })

  it('isDreaminaModelSupported 对两类都放行、对禁用项拒绝', () => {
    expect(isDreaminaModelSupported('5.0')).toBe(true)
    expect(isDreaminaModelSupported('seedance2.0mini')).toBe(true)
    expect(isDreaminaModelSupported('seedance2.0fast')).toBe(false)
    expect(isDreaminaModelSupported('')).toBe(false)
  })
})

describe('新建即梦实例时预置的模型清单', () => {
  const suggestions = PROVIDER_SPECS.find((spec) => spec.id === 'dreamina')?.suggestions ?? []

  it('图片只预置 5.0 与 5.0Pro', () => {
    const imageModels = suggestions.filter((id) => !/^seedance/i.test(id))
    expect(imageModels).toEqual(['5.0', '5.0Pro'])
  })

  it('视频只预置四个可用型号，且默认项是 2.5', () => {
    const videoModels = suggestions.filter((id) => /^seedance/i.test(id))
    expect(videoModels).toEqual([
      'seedance2.5',
      'seedance2.0_vip',
      'seedance2.0fast_vip',
      'seedance2.0mini'
    ])
    // 视频节点在未显式选模型时取第一个视频模型，所以顺序即默认值。
    expect(videoModels[0]).toBe('seedance2.5')
  })

  it('排队极慢的 2.0fast / 2.0 基础款不得出现在任何预置位置', () => {
    expect(suggestions).not.toContain('seedance2.0fast')
    expect(suggestions).not.toContain('seedance2.0')
  })
})
