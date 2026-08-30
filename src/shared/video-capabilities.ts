import type { ProviderSpecId, VideoGenParams } from './types'

/**
 * 视频模型的可呈现能力，而不是“猜模型能做什么”的执行逻辑。
 *
 * UI 用它只展示当前供应商已知可配置的参数；主进程仍会把真实媒体按端口转交给
 * 对应适配器，并把供应商返回的拒绝原样呈现。这样不会把尚未确认的能力伪装为可用。
 */
export interface VideoCapabilities {
  ratios: string[]
  durations: number[]
  resolutions: string[]
  supportsFirstLastFrames: boolean
  supportsReferenceImages: boolean
  supportsReferenceVideo: boolean
  supportsReferenceAudio: boolean
  supportsGeneratedAudio: boolean
  maxReferenceImages: number
  maxReferenceVideos: number
  maxReferenceAudios: number
}

export interface VideoCapabilityRequest {
  params?: VideoGenParams
  hasFirstFrame?: boolean
  hasLastFrame?: boolean
  referenceImageCount?: number
  referenceVideoCount?: number
  referenceAudioCount?: number
}

const H3_CAPABILITIES: VideoCapabilities = {
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  durations: Array.from({ length: 12 }, (_, index) => index + 4),
  resolutions: ['768P', '2K'],
  supportsFirstLastFrames: true,
  supportsReferenceImages: true,
  supportsReferenceVideo: true,
  supportsReferenceAudio: true,
  // 参考音频不等于模型会生成原生音轨；当前 H3 适配不展示这个开关。
  supportsGeneratedAudio: false,
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3
}

const SEEDANCE_2_CAPABILITIES: VideoCapabilities = {
  ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
  durations: Array.from({ length: 12 }, (_, index) => index + 4),
  resolutions: ['480p', '720p', '1080p'],
  // Seedance 的 content 协议只有“参考素材”角色，不把它伪装成首尾帧硬约束。
  supportsFirstLastFrames: false,
  supportsReferenceImages: true,
  supportsReferenceVideo: true,
  supportsReferenceAudio: true,
  supportsGeneratedAudio: true,
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3
}

const FALLBACK_CAPABILITIES: VideoCapabilities = {
  ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  durations: [4, 5, 6, 8, 10, 12, 15],
  resolutions: ['720p'],
  supportsFirstLastFrames: false,
  supportsReferenceImages: false,
  supportsReferenceVideo: true,
  supportsReferenceAudio: false,
  supportsGeneratedAudio: false,
  maxReferenceImages: 0,
  maxReferenceVideos: 1,
  maxReferenceAudios: 0
}

export function videoCapabilitiesFor(specId: ProviderSpecId, modelId = ''): VideoCapabilities {
  if (specId === 'minimax' && modelId.trim().toLowerCase() === 'minimax-h3') {
    return H3_CAPABILITIES
  }
  if (specId === 'seedance') return SEEDANCE_2_CAPABILITIES
  return FALLBACK_CAPABILITIES
}

/** H3 的首帧/尾帧模式由图片决定比例；文本模式必须显式给出比例。 */
export function videoRatioIsDerivedByFrames(
  specId: ProviderSpecId,
  modelId: string,
  hasFirstOrLastFrame: boolean
): boolean {
  return (
    specId === 'minimax' && modelId.trim().toLowerCase() === 'minimax-h3' && hasFirstOrLastFrame
  )
}

/** 返回可在提交前解释给用户的能力冲突；主进程仍会在提交时再次校验。 */
export function videoCapabilityIssues(
  capabilities: VideoCapabilities,
  request: VideoCapabilityRequest
): string[] {
  const params = request.params ?? {}
  const issues: string[] = []
  if (params.ratio && !capabilities.ratios.includes(params.ratio)) {
    issues.push(`当前模型不支持画幅 ${params.ratio}`)
  }
  if (typeof params.duration === 'number' && !capabilities.durations.includes(params.duration)) {
    issues.push(`当前模型不支持时长 ${params.duration}s`)
  }
  if (params.resolution && !capabilities.resolutions.includes(params.resolution)) {
    issues.push(`当前模型不支持清晰度 ${params.resolution}`)
  }
  if (request.hasLastFrame && !capabilities.supportsFirstLastFrames) {
    issues.push('当前模型不支持尾帧硬约束')
  }
  if ((request.referenceImageCount ?? 0) > capabilities.maxReferenceImages) {
    issues.push(`当前模型最多支持 ${capabilities.maxReferenceImages} 张参考图`)
  }
  if ((request.referenceVideoCount ?? 0) > capabilities.maxReferenceVideos) {
    issues.push(`当前模型最多支持 ${capabilities.maxReferenceVideos} 段参考视频`)
  }
  if ((request.referenceAudioCount ?? 0) > capabilities.maxReferenceAudios) {
    issues.push(`当前模型最多支持 ${capabilities.maxReferenceAudios} 段参考音频`)
  }
  if (params.generateAudio && !capabilities.supportsGeneratedAudio) {
    issues.push('当前模型不支持生成同步音频')
  }
  return issues
}
