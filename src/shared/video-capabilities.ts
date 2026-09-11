import type { ProviderSpecId, VideoGenParams, VideoGenerationMode } from './types'

/** Shared model profiles used by the UI and both video adapters. */
export interface VideoCapabilities {
  /** Whether visible controls become structured request fields or verified gateway compatibility syntax. */
  parameterTransport: 'structured' | 'gateway-compatibility'
  ratios: string[]
  durations: number[]
  resolutions: string[]
  /** Product defaults are explicit. Array order must never decide cost or quality. */
  defaultRatio: string
  defaultDuration: number
  defaultResolution: string
  modes: VideoGenerationMode[]
  supportsFirstLastFrames: boolean
  supportsReferenceImages: boolean
  supportsReferenceVideo: boolean
  supportsReferenceAudio: boolean
  supportsGeneratedAudio: boolean
  supportsSeed: boolean
  supportsWatermark: boolean
  maxReferenceImages: number
  maxReferenceVideos: number
  maxReferenceAudios: number
  /** Undefined means the provider has not supplied a verified prompt ceiling. */
  maxPromptChars?: number
}

export interface VideoCapabilityContext {
  gatewayProxy?: boolean
}

export interface VideoCapabilityRequest {
  prompt?: string
  params?: VideoGenParams
  mode?: VideoGenerationMode
  hasFirstFrame?: boolean
  hasLastFrame?: boolean
  imageCount?: number
  referenceImageCount?: number
  referenceVideoCount?: number
  referenceAudioCount?: number
}

export interface NormalizeVideoParamsOptions {
  framesDetermineRatio?: boolean
}

export function canonicalVideoModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index)

const H3: VideoCapabilities = {
  parameterTransport: 'structured',
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  durations: range(4, 15),
  resolutions: ['768P', '2K'],
  defaultRatio: '16:9',
  defaultDuration: 5,
  defaultResolution: '768P',
  modes: ['text', 'first-frame', 'first-last-frame', 'reference'],
  supportsFirstLastFrames: true,
  supportsReferenceImages: true,
  supportsReferenceVideo: true,
  supportsReferenceAudio: true,
  supportsGeneratedAudio: false,
  supportsSeed: false,
  supportsWatermark: true,
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
  maxPromptChars: 7000
}

const H3_MAX: VideoCapabilities = {
  ...H3,
  durations: range(5, 15),
  resolutions: ['480P', '768P'],
  defaultResolution: '768P',
  modes: ['text', 'first-frame', 'first-last-frame'],
  supportsReferenceImages: false,
  supportsReferenceVideo: false,
  supportsReferenceAudio: false,
  maxReferenceImages: 0,
  maxReferenceVideos: 0,
  maxReferenceAudios: 0,
  maxPromptChars: undefined
}

const seedance = (
  resolutions: string[],
  durations: number[],
  overrides: Partial<VideoCapabilities> = {}
): VideoCapabilities => ({
  parameterTransport: overrides.parameterTransport ?? 'structured',
  ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
  durations,
  resolutions,
  defaultRatio: '16:9',
  defaultDuration: durations.includes(5) ? 5 : (durations[0] ?? 5),
  defaultResolution: resolutions.includes('720p') ? '720p' : (resolutions[0] ?? '720p'),
  modes: ['text', 'first-frame', 'first-last-frame', 'reference'],
  supportsFirstLastFrames: true,
  supportsReferenceImages: true,
  supportsReferenceVideo: true,
  supportsReferenceAudio: true,
  supportsGeneratedAudio: true,
  supportsSeed: false,
  supportsWatermark: true,
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
  ...overrides
})

const SEEDANCE_25 = seedance(['480p', '720p', '1080p'], range(4, 30), {
  maxReferenceImages: 30,
  maxReferenceVideos: 10,
  maxReferenceAudios: 10
})
const SEEDANCE_20 = seedance(['480p', '720p', '1080p', '4k'], range(4, 15))
const SEEDANCE_20_FAST = seedance(['480p', '720p'], range(4, 15))
const SEEDANCE_20_MINI = seedance(['480p', '720p'], range(4, 15))

const FALLBACK: VideoCapabilities = {
  parameterTransport: 'structured',
  ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  durations: [4, 5, 6, 8, 10, 12, 15],
  resolutions: ['720p'],
  defaultRatio: '16:9',
  defaultDuration: 5,
  defaultResolution: '720p',
  modes: ['text'],
  supportsFirstLastFrames: false,
  supportsReferenceImages: false,
  supportsReferenceVideo: false,
  supportsReferenceAudio: false,
  supportsGeneratedAudio: false,
  supportsSeed: false,
  supportsWatermark: false,
  maxReferenceImages: 0,
  maxReferenceVideos: 0,
  maxReferenceAudios: 0
}

export function isSeedanceGatewayProxy(specId: ProviderSpecId, baseURL: string): boolean {
  return specId === 'seedance' && baseURL.includes('/gateway/ark/')
}

function profileFor(specId: ProviderSpecId, modelId: string): VideoCapabilities {
  const model = canonicalVideoModelId(modelId)
  if (specId === 'minimax') {
    if (model === 'minimax-h3-max') return H3_MAX
    if (model === 'minimax-h3') return H3
  }
  if (specId === 'seedance') {
    if (model.includes('seedance-2-5') || model.includes('seedance-2.5')) return SEEDANCE_25
    if (model.includes('seedance-2-0-mini') || model.includes('seedance-2.0-mini'))
      return SEEDANCE_20_MINI
    if (model.includes('seedance-2-0-fast') || model.includes('seedance-2.0-fast'))
      return SEEDANCE_20_FAST
    if (model.includes('seedance-2-0') || model.includes('seedance-2.0')) return SEEDANCE_20
  }
  return FALLBACK
}

export function videoCapabilitiesFor(
  specId: ProviderSpecId,
  modelId = '',
  context: VideoCapabilityContext = {}
): VideoCapabilities {
  const capabilities = profileFor(specId, modelId)
  return context.gatewayProxy && specId === 'seedance'
    ? {
        ...capabilities,
        parameterTransport: 'gateway-compatibility',
        supportsGeneratedAudio: false,
        supportsSeed: false,
        supportsWatermark: false
      }
    : capabilities
}

export function videoRatioIsDerivedByFrames(
  specId: ProviderSpecId,
  modelId: string,
  hasFirstOrLastFrame: boolean
): boolean {
  if (!hasFirstOrLastFrame) return false
  return (
    specId === 'minimax' ||
    (specId === 'seedance' && canonicalVideoModelId(modelId).includes('seedance-2-5'))
  )
}

export function normalizeVideoGenParams(
  capabilities: VideoCapabilities,
  params: VideoGenParams = {},
  options: NormalizeVideoParamsOptions = {}
): VideoGenParams {
  const ratio = options.framesDetermineRatio
    ? undefined
    : capabilities.ratios.includes(params.ratio ?? '')
      ? params.ratio
      : capabilities.defaultRatio
  const defaultDuration = capabilities.defaultDuration
  return {
    ...(ratio ? { ratio } : {}),
    ...(capabilities.durations.includes(params.duration ?? Number.NaN)
      ? { duration: params.duration }
      : defaultDuration !== undefined
        ? { duration: defaultDuration }
        : {}),
    ...(capabilities.resolutions.includes(params.resolution ?? '')
      ? { resolution: params.resolution }
      : capabilities.resolutions.includes(capabilities.defaultResolution)
        ? { resolution: capabilities.defaultResolution }
        : {}),
    ...(capabilities.supportsGeneratedAudio ? { generateAudio: params.generateAudio ?? true } : {}),
    ...(capabilities.supportsSeed && typeof params.seed === 'number' ? { seed: params.seed } : {}),
    ...(capabilities.supportsWatermark && typeof params.watermark === 'boolean'
      ? { watermark: params.watermark }
      : {})
  }
}

export function videoCapabilityIssues(
  capabilities: VideoCapabilities,
  request: VideoCapabilityRequest
): string[] {
  const params = request.params ?? {}
  const mode = request.mode ?? 'text'
  const imageCount = request.imageCount ?? 0
  const referenceImageCount = request.referenceImageCount ?? 0
  const videoCount = request.referenceVideoCount ?? 0
  const audioCount = request.referenceAudioCount ?? 0
  const issues: string[] = []
  if (
    capabilities.maxPromptChars &&
    (request.prompt?.trim().length ?? 0) > capabilities.maxPromptChars
  )
    issues.push(`当前模型的提示词不能超过 ${capabilities.maxPromptChars} 个字符`)
  if (!capabilities.modes.includes(mode)) issues.push('当前模型不支持此视频生成模式')
  if (params.ratio && !capabilities.ratios.includes(params.ratio))
    issues.push(`当前模型不支持画幅 ${params.ratio}`)
  if (typeof params.duration === 'number' && !capabilities.durations.includes(params.duration))
    issues.push(`当前模型不支持时长 ${params.duration}s`)
  if (params.resolution && !capabilities.resolutions.includes(params.resolution))
    issues.push(`当前模型不支持清晰度 ${params.resolution}`)
  if (mode === 'first-frame' && (!request.hasFirstFrame || imageCount !== 1))
    issues.push('首帧模式需要连接 1 张图片')
  if (
    mode === 'first-last-frame' &&
    (!request.hasFirstFrame || !request.hasLastFrame || imageCount !== 2)
  )
    issues.push('首尾帧模式需要按顺序连接 2 张图片')
  if (mode === 'text' && imageCount > 0)
    issues.push('文生视频模式不能连接图片，请改用首帧、首尾帧或参考模式')
  if (mode !== 'reference' && referenceImageCount > 0) issues.push('首尾帧模式与多模态参考不能混用')
  if (mode !== 'reference' && (videoCount > 0 || audioCount > 0))
    issues.push('首尾帧模式与多模态参考不能混用')
  if (mode === 'reference' && (request.hasFirstFrame || request.hasLastFrame))
    issues.push('参考模式不能混用首帧或尾帧')
  if (mode === 'reference' && referenceImageCount > capabilities.maxReferenceImages)
    issues.push(`当前模型最多支持 ${capabilities.maxReferenceImages} 张参考图`)
  if (videoCount > capabilities.maxReferenceVideos)
    issues.push(`当前模型最多支持 ${capabilities.maxReferenceVideos} 段参考视频`)
  if (audioCount > capabilities.maxReferenceAudios)
    issues.push(`当前模型最多支持 ${capabilities.maxReferenceAudios} 段参考音频`)
  if (params.generateAudio && !capabilities.supportsGeneratedAudio)
    issues.push('当前模型不支持生成同步音频')
  if (typeof params.seed === 'number' && !capabilities.supportsSeed)
    issues.push('当前模型不支持种子参数')
  if (typeof params.watermark === 'boolean' && !capabilities.supportsWatermark)
    issues.push('当前模型不支持水印参数')
  return issues
}

export interface VideoInputState {
  mode?: VideoGenerationMode
  imageCount?: number
  referenceVideoCount?: number
  referenceAudioCount?: number
}

export interface VideoModeResolution {
  /** Undefined means the selected model cannot consume the current connected media. */
  mode?: VideoGenerationMode
  availableModes: VideoGenerationMode[]
}

/**
 * The current connected ports determine which generation modes are valid.
 * This is intentionally shared by the node body and executor so an option cannot
 * look selectable in the UI but become invalid only at submit time.
 */
export function videoModesForInputs(
  capabilities: VideoCapabilities,
  state: Pick<VideoInputState, 'imageCount' | 'referenceVideoCount' | 'referenceAudioCount'>
): VideoGenerationMode[] {
  const imageCount = state.imageCount ?? 0
  const referenceVideoCount = state.referenceVideoCount ?? 0
  const referenceAudioCount = state.referenceAudioCount ?? 0
  const hasMotionReferences = referenceVideoCount > 0 || referenceAudioCount > 0

  if (hasMotionReferences) {
    if (
      !capabilities.modes.includes('reference') ||
      (imageCount > 0 && !capabilities.supportsReferenceImages) ||
      (referenceVideoCount > 0 && !capabilities.supportsReferenceVideo) ||
      (referenceAudioCount > 0 && !capabilities.supportsReferenceAudio)
    ) {
      return []
    }
    return ['reference']
  }

  if (imageCount > 0) {
    const modes: VideoGenerationMode[] = []
    // Reference is deliberately first: for supported models it is the product default
    // after the user connects an image, while first/last-frame remain explicit options.
    if (capabilities.modes.includes('reference') && capabilities.supportsReferenceImages) {
      modes.push('reference')
    }
    if (imageCount === 1 && capabilities.modes.includes('first-frame')) {
      modes.push('first-frame')
    }
    if (imageCount === 2 && capabilities.modes.includes('first-last-frame')) {
      modes.push('first-last-frame')
    }
    return modes
  }

  return capabilities.modes.includes('text') ? ['text'] : []
}

export function resolveVideoMode(
  capabilities: VideoCapabilities,
  state: VideoInputState
): VideoModeResolution {
  const availableModes = videoModesForInputs(capabilities, state)
  return {
    availableModes,
    mode: state.mode && availableModes.includes(state.mode) ? state.mode : availableModes[0]
  }
}

export function videoInputHints(capabilities: VideoCapabilities, state: VideoInputState): string[] {
  const mode = resolveVideoMode(capabilities, state).mode ?? state.mode ?? 'text'
  if (mode === 'first-frame') return ['首帧模式：第 1 张图片作为首帧']
  if (mode === 'first-last-frame') return ['首尾帧模式：第 1 张为首帧，第 2 张为尾帧']
  if (mode === 'reference' && capabilities.supportsReferenceImages) {
    return [state.imageCount ? `已连接 ${state.imageCount} 张参考图` : '可 @ 引用参考图']
  }
  return []
}
