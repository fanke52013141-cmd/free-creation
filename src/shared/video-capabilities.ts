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
  supportsSeed: boolean
  maxReferenceImages: number
  maxReferenceVideos: number
  maxReferenceAudios: number
}

/** 能力查询上下文：兼容网关代理只提交已验证参数，UI 与执行器据此收窄可选开关。 */
export interface VideoCapabilityContext {
  gatewayProxy?: boolean
}

export interface VideoCapabilityRequest {
  params?: VideoGenParams
  hasFirstFrame?: boolean
  hasLastFrame?: boolean
  referenceImageCount?: number
  referenceVideoCount?: number
  referenceAudioCount?: number
}

export interface NormalizeVideoParamsOptions {
  /** H3 首尾帧模式由图片决定画幅，不能再提交独立 ratio。 */
  framesDetermineRatio?: boolean
}

/** 只接受明确登记的模型标识；大小写和分隔符差异不会导致能力误判。 */
export function canonicalVideoModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
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
  supportsSeed: false,
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
  supportsSeed: true,
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
  supportsSeed: false,
  maxReferenceImages: 0,
  maxReferenceVideos: 1,
  maxReferenceAudios: 0
}

/** 官方方舟之外的 Ark 兼容网关：沿用已验证的任务路径，仅提交基础参数。 */
export function isSeedanceGatewayProxy(specId: ProviderSpecId, baseURL: string): boolean {
  return specId === 'seedance' && baseURL.includes('/gateway/ark/')
}

export function videoCapabilitiesFor(
  specId: ProviderSpecId,
  modelId = '',
  context: VideoCapabilityContext = {}
): VideoCapabilities {
  if (specId === 'minimax' && canonicalVideoModelId(modelId) === 'minimax-h3') {
    return H3_CAPABILITIES
  }
  if (specId === 'seedance') {
    // 兼容网关未验证音频/种子参数的转发，结构化地收窄能力而不是在 UI 里硬编码供应商判断。
    return context.gatewayProxy
      ? { ...SEEDANCE_2_CAPABILITIES, supportsGeneratedAudio: false, supportsSeed: false }
      : SEEDANCE_2_CAPABILITIES
  }
  return FALLBACK_CAPABILITIES
}

/** H3 的首帧/尾帧模式由图片决定比例；文本模式必须显式给出比例。 */
export function videoRatioIsDerivedByFrames(
  specId: ProviderSpecId,
  modelId: string,
  hasFirstOrLastFrame: boolean
): boolean {
  return (
    specId === 'minimax' && canonicalVideoModelId(modelId) === 'minimax-h3' && hasFirstOrLastFrame
  )
}

/**
 * 模型切换与旧配置恢复时使用的保守回退：只保留当前能力表可提交的参数。
 * 主进程仍会再次执行 videoCapabilityIssues，避免 renderer 绕过校验。
 */
export function normalizeVideoGenParams(
  capabilities: VideoCapabilities,
  params: VideoGenParams = {},
  options: NormalizeVideoParamsOptions = {}
): VideoGenParams {
  const defaultDuration = capabilities.durations.includes(5)
    ? 5
    : (capabilities.durations[0] ?? undefined)
  const ratio = options.framesDetermineRatio
    ? undefined
    : capabilities.ratios.includes(params.ratio ?? '')
      ? params.ratio
      : capabilities.ratios[0]
  return {
    ...(ratio ? { ratio } : {}),
    ...(capabilities.durations.includes(params.duration ?? Number.NaN)
      ? { duration: params.duration }
      : defaultDuration !== undefined
        ? { duration: defaultDuration }
        : {}),
    ...(capabilities.resolutions.includes(params.resolution ?? '')
      ? { resolution: params.resolution }
      : capabilities.resolutions[0]
        ? { resolution: capabilities.resolutions.at(-1) }
        : {}),
    ...(capabilities.supportsGeneratedAudio ? { generateAudio: params.generateAudio ?? true } : {}),
    ...(capabilities.supportsSeed && typeof params.seed === 'number' && Number.isFinite(params.seed)
      ? { seed: params.seed }
      : {}),
    ...(typeof params.watermark === 'boolean' ? { watermark: params.watermark } : {})
  }
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
  if (typeof params.seed === 'number' && !capabilities.supportsSeed) {
    issues.push('当前模型不支持种子参数')
  }
  return issues
}

export interface VideoInputState {
  hasFirstFrame?: boolean
  hasLastFrame?: boolean
  referenceImageCount?: number
}

/**
 * 配置面板顶部的能力提示行：只列出当前模型真实支持的图片输入方式。
 * 首尾帧硬约束仅 H3 支持；Seedance 连到 in-image 的图片会作为参考素材传递。
 * 参考视频/音频的连接状态由面板中的素材条展示，这里不重复。
 */
export function videoInputHints(capabilities: VideoCapabilities, state: VideoInputState): string[] {
  const hints: string[] = []
  if (capabilities.supportsFirstLastFrames) {
    hints.push(state.hasFirstFrame ? '首帧已连接' : '可连接首帧')
    hints.push(state.hasLastFrame ? '尾帧已连接' : '可连接尾帧')
  } else if (capabilities.supportsReferenceImages) {
    hints.push('图片作参考素材')
  }
  if (capabilities.supportsReferenceImages) {
    hints.push(
      state.referenceImageCount ? `参考图 ${state.referenceImageCount} 张` : '可 @ 引用参考图'
    )
  }
  return hints
}
