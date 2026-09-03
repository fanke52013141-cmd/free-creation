import { describe, expect, it } from 'vitest'
import {
  canonicalVideoModelId,
  isSeedanceGatewayProxy,
  normalizeVideoGenParams,
  videoCapabilitiesFor,
  videoCapabilityIssues,
  videoInputHints,
  videoRatioIsDerivedByFrames
} from '@shared/video-capabilities'

describe('视频供应商能力描述', () => {
  it('统一模型标识并在模型切换后回退到已声明的安全配置', () => {
    expect(canonicalVideoModelId(' MiniMax_H3 ')).toBe('minimax-h3')
    const params = normalizeVideoGenParams(videoCapabilitiesFor('minimax', 'MiniMax_H3'), {
      ratio: '9:21',
      duration: 3,
      resolution: '1080p',
      generateAudio: true
    })
    expect(params).toEqual({ ratio: '21:9', duration: 5, resolution: '2K' })
  })

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

  it('结构化声明种子能力：Seedance 直连可配，H3 与回退能力不暴露', () => {
    expect(videoCapabilitiesFor('seedance', 'seedance-2.0').supportsSeed).toBe(true)
    expect(videoCapabilitiesFor('minimax', 'minimax-h3').supportsSeed).toBe(false)
    expect(videoCapabilitiesFor('openai', 'gpt-x').supportsSeed).toBe(false)
    expect(
      normalizeVideoGenParams(videoCapabilitiesFor('seedance', 'seedance-2.0'), { seed: 42 }).seed
    ).toBe(42)
    expect(
      normalizeVideoGenParams(videoCapabilitiesFor('minimax', 'minimax-h3'), { seed: 42 }).seed
    ).toBeUndefined()
    expect(
      videoCapabilityIssues(videoCapabilitiesFor('minimax', 'minimax-h3'), { params: { seed: 7 } })
    ).toContain('当前模型不支持种子参数')
  })

  it('兼容网关代理收窄能力：隐藏音频与种子，基础参数保持不变', () => {
    const direct = videoCapabilitiesFor('seedance', 'seedance-2.0-fast')
    const proxy = videoCapabilitiesFor('seedance', 'seedance-2.0-fast', { gatewayProxy: true })
    expect(direct.supportsGeneratedAudio).toBe(true)
    expect(direct.supportsSeed).toBe(true)
    expect(proxy.supportsGeneratedAudio).toBe(false)
    expect(proxy.supportsSeed).toBe(false)
    expect(proxy.ratios).toEqual(direct.ratios)
    expect(proxy.durations).toEqual(direct.durations)
    expect(proxy.resolutions).toEqual(direct.resolutions)
    // 网关代理不属于 minimax，能力不受上下文影响
    expect(
      videoCapabilitiesFor('minimax', 'minimax-h3', { gatewayProxy: true }).supportsFirstLastFrames
    ).toBe(true)
    const normalized = normalizeVideoGenParams(proxy, { seed: 42, generateAudio: true })
    expect(normalized.seed).toBeUndefined()
    expect(normalized.generateAudio).toBeUndefined()
  })

  it('isSeedanceGatewayProxy 识别 Ark 兼容网关地址', () => {
    expect(isSeedanceGatewayProxy('seedance', 'https://gw.example.com/gateway/ark/v3')).toBe(true)
    expect(isSeedanceGatewayProxy('seedance', 'https://ark.cn-beijing.volces.com/api/v3')).toBe(
      false
    )
    expect(isSeedanceGatewayProxy('minimax', 'https://gw.example.com/gateway/ark/')).toBe(false)
  })

  it('videoInputHints 按能力生成提示行，不向不支持的模型暴露首尾帧提示', () => {
    const h3 = videoCapabilitiesFor('minimax', 'minimax-h3')
    expect(videoInputHints(h3, {})).toEqual(['可连接首帧', '可连接尾帧', '可 @ 引用参考图'])
    expect(videoInputHints(h3, { hasFirstFrame: true, referenceImageCount: 2 })).toEqual([
      '首帧已连接',
      '可连接尾帧',
      '参考图 2 张'
    ])
    const seedance = videoCapabilitiesFor('seedance', 'seedance-2.0')
    expect(videoInputHints(seedance, {})).toEqual(['图片作参考素材', '可 @ 引用参考图'])
    expect(videoInputHints(seedance, { referenceImageCount: 3 })).toEqual([
      '图片作参考素材',
      '参考图 3 张'
    ])
    expect(videoInputHints(videoCapabilitiesFor('openai', 'gpt-x'), {})).toEqual([])
  })
})
