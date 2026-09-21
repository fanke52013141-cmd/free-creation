import type { ProviderSpecId } from './types'

/** 图片生成的稳定配置；比例是用户意图，尺寸是当前模型的实际落点。 */
export type ImageResolution = '1k' | '2k' | '4k'

export const ALL_IMAGE_ASPECT_RATIOS = [
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
] as const

export type ImageAspectRatio = (typeof ALL_IMAGE_ASPECT_RATIOS)[number]

/** 读回存量配置时的取值域判定：P 图的比例不再有第二份清单，所以只能按这份全集校验。 */
export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return (ALL_IMAGE_ASPECT_RATIOS as readonly string[]).includes(String(value))
}

/** 网关提交驱动：OpenAI Images 兼容 / TOAPIS 异步任务 / OpenRouter chat 生图。 */
export type ImageGatewayDriver = 'openai-images' | 'toapis-task' | 'openrouter-chat'

/** 参考图提交方式：二进制内联 / 先上传供应商换 URL / chat 消息内联 data URL。 */
export type ImageReferenceMode = 'binary' | 'upload-url' | 'chat-inline'

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
  /** 分辨率档位；空数组表示供应商不支持：UI 隐藏且请求不携带。 */
  resolutions: ImageResolution[]
  /** true 时请求固定携带 quality: 'low'；质量不暴露 UI、不进节点配置。 */
  supportsQuality: boolean
  /** 供应商是否接受 background: 'transparent'；关闭时 UI 隐藏且请求不携带该字段。 */
  supportsTransparentBackground: boolean
  /** 文档化的提示词字符上限；未文档化时留空，不做臆测性拦截。 */
  maxPromptChars?: number
  driver: ImageGatewayDriver
  referenceMode: ImageReferenceMode
}

export interface ImageGenerationConfig {
  featureKey?: string
  modelKey: string
  /** 选中的供应商实例 id；缺省时由 modelKey 反推，再回退默认供应商（ToAPIS 优先）。 */
  providerKey?: string
  size: string
  aspectRatio: ImageAspectRatio
  /** 分辨率是用户意图；当前供应商不支持时仅不发送，配置保留以便切回。 */
  resolution?: ImageResolution
  /** 透明背景开关；供应商不支持时仅在网关不发送，配置保留以便切回。 */
  background?: 'transparent'
  /** 旧项目配置兼容字段；生图 UI 不再暴露，也不会发送给供应商。 */
  seed?: number
}

const IMAGE_RESOLUTIONS: ImageResolution[] = ['1k', '2k', '4k']

/** TOAPIS gpt-image-2 官方支持的 13 种画幅比例（size 直接提交比例串）。 */
const TOAPIS_RATIOS: ImageAspectRatio[] = [
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
]

const AUTO_SIZE_OPTION: ImageSizeOption = { value: 'auto', label: '默认尺寸', ratio: 'auto' }

/**
 * ToAPIS：OpenAI 形态的异步任务端点；size 为比例串，参考图必须先上传换 URL。
 * 提交字段以官方 gpt-image-2 文档为准且是封闭集合：model / prompt(≤32000) / size(比例串) /
 * resolution(1k|2k|4k) / background / n / response_format / reference_images(≤6, 仅 URL)。
 * quality 只存在于 gpt-image-2-vip 与 gpt-image-2-official 两个模型，普通 gpt-image-2 不发送。
 */
const TOAPIS_CAPABILITIES: ImageCapabilities = {
  ratios: ['auto', ...TOAPIS_RATIOS],
  sizeOptions: [
    AUTO_SIZE_OPTION,
    ...TOAPIS_RATIOS.map((ratio) => ({ value: ratio, label: ratio, ratio }))
  ],
  supportsSeed: false,
  supportsReferenceImages: true,
  maxReferenceImages: 6,
  forwardsAspectRatio: false,
  resolutions: IMAGE_RESOLUTIONS,
  supportsQuality: false,
  supportsTransparentBackground: true,
  maxPromptChars: 32000,
  driver: 'toapis-task',
  referenceMode: 'upload-url'
}

/** ChatGPT/OpenAI 官方 images 端点：固定像素尺寸，无 1k/2k/4k 档，质量固定 low。 */
const OPENAI_IMAGE_CAPABILITIES: ImageCapabilities = {
  ratios: ['auto', '1:1', '3:2', '2:3'],
  sizeOptions: [
    AUTO_SIZE_OPTION,
    { value: '1024x1024', label: '1024 × 1024', ratio: '1:1' },
    { value: '1536x1024', label: '1536 × 1024', ratio: '3:2' },
    { value: '1024x1536', label: '1024 × 1536', ratio: '2:3' }
  ],
  supportsSeed: false,
  supportsReferenceImages: true,
  maxReferenceImages: 4,
  forwardsAspectRatio: false,
  resolutions: [],
  supportsQuality: true,
  supportsTransparentBackground: false,
  driver: 'openai-images',
  referenceMode: 'binary'
}

/** OpenRouter 生图走 chat-completions；尺寸类参数待上游验证后再开放（能力表驱动）。 */
const OPENROUTER_IMAGE_CAPABILITIES: ImageCapabilities = {
  ratios: ['auto'],
  sizeOptions: [AUTO_SIZE_OPTION],
  supportsSeed: false,
  supportsReferenceImages: true,
  maxReferenceImages: 4,
  forwardsAspectRatio: false,
  resolutions: [],
  supportsQuality: false,
  supportsTransparentBackground: false,
  driver: 'openrouter-chat',
  referenceMode: 'chat-inline'
}

const SAFE_OPENAI_COMPAT_CAPABILITIES: ImageCapabilities = {
  // 画幅是用户意图；尺寸仍允许交给供应商默认值，避免伪造某个模型的像素能力。
  ratios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '21:9'],
  sizeOptions: [
    AUTO_SIZE_OPTION,
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
  forwardsAspectRatio: true,
  resolutions: [],
  supportsQuality: false,
  supportsTransparentBackground: false,
  driver: 'openai-images',
  referenceMode: 'binary'
}

/**
 * 图片模型能力的单一入口。画幅选项是稳定的用户意图，实际像素由供应商能力决定。
 * 选中哪个供应商就按哪张能力表提交参数、呈现 UI；未知模型一律使用保守集合。
 */
export function imageCapabilitiesFor(specId: ProviderSpecId, modelId = ''): ImageCapabilities {
  switch (specId) {
    case 'toapis':
      return TOAPIS_CAPABILITIES
    case 'openai':
      return OPENAI_IMAGE_CAPABILITIES
    case 'openrouter':
      return OPENROUTER_IMAGE_CAPABILITIES
    default: {
      const normalized = (modelId || '').toLowerCase().trim()
      if (
        normalized === 'gpt-image-2' ||
        normalized.includes('gpt-image-2') ||
        normalized.includes('image-2') ||
        normalized.includes('toapis')
      ) {
        return TOAPIS_CAPABILITIES
      }
      return SAFE_OPENAI_COMPAT_CAPABILITIES
    }
  }
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

/**
 * P 图遮罩是否随请求发送。TOAPIS 的 /images/generations 提交字段是封闭集合，里面没有
 * mask，因此那条通道上遮罩既不发、也不许在界面上出现（NODE_UI_SPEC §16.15）。
 */
export function imageEditSendsMask(capabilities: ImageCapabilities): boolean {
  return capabilities.driver !== 'toapis-task'
}

/** P 图画幅的落点：TOAPIS 把比例串写进 size，兼容网关写进 aspectRatio，其余驱动不接收。 */
export function imageEditSendsAspectRatio(capabilities: ImageCapabilities): boolean {
  return capabilities.driver === 'toapis-task' || capabilities.forwardsAspectRatio
}

/** 将旧 size-only 配置和模型切换后的无效值收敛为能力表中的合法组合。 */
export function normalizeImageGenerationConfig(
  input: Partial<ImageGenerationConfig>,
  capabilities: ImageCapabilities
): ImageGenerationConfig {
  // 旧版本使用固定像素尺寸；将它们平滑迁移到等比画幅意图。
  const legacySizeRatio: Record<string, ImageAspectRatio> = {
    '1536x1024': '16:9',
    '1024x1536': '9:16'
  }
  const rawInputRatio = input.aspectRatio as string | undefined
  // 3:2/2:3 曾被收敛为 16:9/9:16；目标供应商原生支持时保留原值（如 ToAPIS）。
  const legacyInputRatio =
    rawInputRatio === '3:2' && !capabilities.ratios.includes('3:2')
      ? '16:9'
      : rawInputRatio === '2:3' && !capabilities.ratios.includes('2:3')
        ? '9:16'
        : input.aspectRatio
  const legacyRatio =
    legacySizeRatio[input.size ?? ''] ?? imageAspectRatioForSize(capabilities, input.size ?? '')
  const requestedRatio = capabilities.ratios.includes(legacyInputRatio ?? legacyRatio)
    ? (legacyInputRatio ?? legacyRatio)
    : legacyRatio
  const sizeOptions = sizesForImageAspectRatio(capabilities, requestedRatio)
  const requestedSize = sizeOptions.some((item) => item.value === input.size)
    ? input.size!
    : (sizeOptions[0]?.value ?? capabilities.sizeOptions[0]?.value ?? 'auto')
  // 分辨率与供应商无关，跨供应商保留用户意图；发送与否由能力表决定。
  const resolution = IMAGE_RESOLUTIONS.find((item) => item === input.resolution)
  return {
    modelKey: typeof input.modelKey === 'string' ? input.modelKey : '',
    ...(typeof input.providerKey === 'string' && input.providerKey
      ? { providerKey: input.providerKey }
      : {}),
    size: requestedSize,
    aspectRatio: requestedRatio,
    ...(resolution ? { resolution } : {}),
    // 与分辨率同理：配置层保留用户意图，发送与否由能力表在网关决定（parseImageGen 用保守表归一化）。
    ...(input.background === 'transparent' ? { background: 'transparent' as const } : {}),
    ...(typeof input.seed === 'number' && Number.isFinite(input.seed) ? { seed: input.seed } : {})
  }
}
