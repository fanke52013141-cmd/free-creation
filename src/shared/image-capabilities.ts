import type { ProviderSpecId } from './types'

/** 图片生成的稳定配置；比例是用户意图，尺寸是当前模型的实际落点。 */
export type ImageAspectRatio = 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '21:9'

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
  /** 旧项目配置兼容字段；生图 UI 不再暴露，也不会发送给供应商。 */
  seed?: number
}

const SAFE_OPENAI_COMPAT_CAPABILITIES: ImageCapabilities = {
  // 画幅是用户意图；尺寸仍允许交给供应商默认值，避免伪造某个模型的像素能力。
  ratios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '21:9'],
  sizeOptions: [
    { value: 'auto', label: '默认尺寸', ratio: 'auto' },
    { value: '1024x1024', label: '1024 × 1024', ratio: '1:1' },
    { value: 'auto', label: '自动尺寸（16:9）', ratio: '16:9' },
    { value: 'auto', label: '自动尺寸（9:16）', ratio: '9:16' },
    { value: 'auto', label: '自动尺寸（4:3）', ratio: '4:3' },
    { value: 'auto', label: '自动尺寸（3:4）', ratio: '3:4' },
    { value: 'auto', label: '自动尺寸（21:9）', ratio: '21:9' }
  ],
  supportsSeed: false,
  supportsReferenceImages: true,
  maxReferenceImages: 4,
  // 由兼容网关透传用户选择；不支持该字段的供应商会回退到默认尺寸。
  forwardsAspectRatio: true
}

/**
 * 图片模型能力的单一入口。画幅选项是稳定的用户意图，实际像素由供应商能力决定。
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
  // 旧版本使用 3:2/2:3 和固定像素尺寸；将它们平滑迁移到当前常用画幅意图。
  const legacySizeRatio: Record<string, ImageAspectRatio> = {
    '1536x1024': '16:9',
    '1024x1536': '9:16'
  }
  const rawInputRatio = input.aspectRatio as string | undefined
  const legacyInputRatio =
    rawInputRatio === '3:2' ? '16:9' : rawInputRatio === '2:3' ? '9:16' : input.aspectRatio
  const legacyRatio =
    legacySizeRatio[input.size ?? ''] ?? imageAspectRatioForSize(capabilities, input.size ?? '')
  const requestedRatio = capabilities.ratios.includes(legacyInputRatio ?? legacyRatio)
    ? (legacyInputRatio ?? legacyRatio)
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
