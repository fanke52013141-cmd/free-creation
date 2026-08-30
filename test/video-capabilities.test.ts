import { describe, expect, it } from 'vitest'
import {
  videoCapabilitiesFor,
  videoCapabilityIssues,
  videoRatioIsDerivedByFrames
} from '@shared/video-capabilities'

describe('视频供应商能力描述', () => {
  it('MiniMax H3 按协议暴露 4–15 秒、2K 和完整多模态参考能力', () => {
    const caps = videoCapabilitiesFor('minimax', 'minimax-h3')
    expect(caps.durations).toEqual(Array.from({ length: 12 }, (_, index) => index + 4))
    expect(caps.resolutions).toEqual(['768P', '2K'])
    expect(caps.supportsFirstLastFrames).toBe(true)
    expect(caps.maxReferenceImages).toBe(9)
    expect(caps.maxReferenceVideos).toBe(3)
    expect(caps.maxReferenceAudios).toBe(3)
    expect(videoRatioIsDerivedByFrames('minimax', 'minimax-h3', true)).toBe(true)
    expect(videoRatioIsDerivedByFrames('minimax', 'minimax-h3', false)).toBe(false)
  })

  it('Seedance 2.0 使用自适应默认比例并暴露多模态参考和同步音频', () => {
    const caps = videoCapabilitiesFor('seedance', 'seedance-2.0-fast')
    expect(caps.ratios[0]).toBe('adaptive')
    expect(caps.durations).toContain(15)
    expect(caps.supportsReferenceImages).toBe(true)
    expect(caps.supportsReferenceVideo).toBe(true)
    expect(caps.supportsReferenceAudio).toBe(true)
    expect(caps.supportsGeneratedAudio).toBe(true)
  })

  it('提交前返回明确的模型参数和素材冲突', () => {
    const caps = videoCapabilitiesFor('minimax', 'minimax-h3')
    expect(
      videoCapabilityIssues(caps, {
        params: { ratio: '9:21', duration: 3, resolution: '1080p' },
        hasLastFrame: true,
        referenceImageCount: 10
      })
    ).toEqual([
      '当前模型不支持画幅 9:21',
      '当前模型不支持时长 3s',
      '当前模型不支持清晰度 1080p',
      '当前模型最多支持 9 张参考图'
    ])
  })
})
