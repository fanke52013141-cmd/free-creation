import type { ProviderSpecId } from './types'

/** 图片生成的稳定配置；比例是用户意图，尺寸是当前模型的实际落点。 */
export type ImageAspectRatio = 'auto' | '1:1' | '3:2' | '2:3'

export interface ImageSizeOption {
  value: string
  label: string
  ratio: ImageAspectRatio
}

export interface ImageCapabilities {
  ratios: ImageAspectRatio[]
  sizeOptions: ImageSizeOption[]
  supportsSeed: boolean
  supportsReferenceImages: boolean
  maxReferenceImages: number
  /** 供应商是否已确认接受独立 aspectRatio 参数；否则仅按已知尺寸映射。 */
  forwardsAspectRatio: boolean
}

export interface ImageGenerationConfig {
  prompt: string
  modelKey: string
  size: string
  aspectRatio: ImageAspectRatio
  seed?: number
}

const SAFE_OPENAI_COMPAT_CAPABILITIES: ImageCapabilities = {
  ratios: ['auto', '1:1', '3:2', '2:3'],
  sizeOptions: [
    { value: 'auto', label: '默认尺寸', ratio: 'auto' },
    { value: '1024x1024', label: '1024 × 1024', ratio: '1:1' },
    { value: '1536x1024', label: '1536 × 1024', ratio: '3:2' },
    { value: '1024x1536', label: '1024 × 1536', ratio: '2:3' }
  ],
  supportsSeed: true,
  supportsReferenceImages: true,
  maxReferenceImages: 4,
  // OpenAI-compatible endpoints 对 aspectRatio 的字段名没有统一保证；先只传已知 size。
  forwardsAspectRatio: false
}

/**
 * 图片模型能力的单一入口。当前仅暴露已由应用请求格式稳定支持的尺寸，未知模型不会
 * 假装支持 16:9/9:16 或供应商私有参数；后续确认某个模型后只需在这里增加精确条目。
 */
export function imageCapabilitiesFor(_specId: ProviderSpecId, modelId = ''): ImageCapabilities {
  // 保留模型 ID 作为能力表的稳定扩展键；未知模型当前一律使用保守集合。
  void modelId
  return SAFE_OPENAI_COMPAT_CAPABILITIES
}

export function sizesForImageAspectRatio(
  capabilities: ImageCapabilities,
  ratio: ImageAspectRatio
): ImageSizeOption[] {
  return capabilities.sizeOptions.filter((item) => item.ratio === ratio)
}

export function imageAspectRatioForSize(
  capabilities: ImageCapabilities,
  size: string
): ImageAspectRatio {
  return capabilities.sizeOptions.find((item) => item.value === size)?.ratio ?? 'auto'
}

/** 将旧 size-only 配置和模型切换后的无效值收敛为能力表中的合法组合。 */
export function normalizeImageGenerationConfig(
  input: Partial<ImageGenerationConfig>,
  capabilities: ImageCapabilities
): ImageGenerationConfig {
  const legacyRatio = imageAspectRatioForSize(capabilities, input.size ?? '')
  const requestedRatio = capabilities.ratios.includes(input.aspectRatio ?? legacyRatio)
    ? (input.aspectRatio ?? legacyRatio)
    : legacyRatio
  const sizeOptions = sizesForImageAspectRatio(capabilities, requestedRatio)
  const requestedSize = sizeOptions.some((item) => item.value === input.size)
    ? input.size!
    : (sizeOptions[0]?.value ?? capabilities.sizeOptions[0]?.value ?? 'auto')
  return {
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    modelKey: typeof input.modelKey === 'string' ? input.modelKey : '',
    size: requestedSize,
    aspectRatio: requestedRatio,
    ...(typeof input.seed === 'number' && Number.isFinite(input.seed) ? { seed: input.seed } : {})
  }
}
