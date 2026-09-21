/** 图片修改节点的稳定配置：标注是配置，不是隐藏的数据端口。 */
import { type ImageAspectRatio, isImageAspectRatio } from './image-capabilities'

export type ImageEditAnnotationType = 'arrow' | 'rect' | 'brush' | 'text'
/** orange 仅用于兼容旧项目；读取时会迁移为蓝色标注。 */
export type ImageEditColor = 'red' | 'yellow' | 'blue' | 'orange'

export interface ImageEditPoint {
  x: number
  y: number
}

export interface ImageEditMask {
  enabled: boolean
  /** 归一化画笔轨迹；遮罩区域在发送给模型时会被转为透明区域。 */
  strokes: ImageEditPoint[][]
  brushSize: number
  invert: boolean
}

export interface ImageEditAnnotation {
  id: string
  type: ImageEditAnnotationType
  color: ImageEditColor
  points: ImageEditPoint[]
  text?: string
  strokeWidth?: number
}

/**
 * P 图的画幅取值域与生图共用同一份图片比例全集；节点上的可选项由所选模型的
 * `capabilities.ratios` 决定（NODE_UI_SPEC §16.15），这里只保留「是不是一个合法比例」的判定。
 */
export type ImageEditAspectRatio = ImageAspectRatio

export const IMAGE_EDIT_RESOLUTIONS = ['1k', '2k', '4k'] as const
export type ImageEditResolution = (typeof IMAGE_EDIT_RESOLUTIONS)[number]

export const IMAGE_EDIT_SIZES = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '1024x1024',
  '1536x1024',
  '1024x1536'
] as const
export type ImageEditSize = (typeof IMAGE_EDIT_SIZES)[number]

export interface ImageEditConfig {
  featureKey?: string
  version: 1
  modelKey: string
  size: string
  aspectRatio?: ImageEditAspectRatio
  resolution?: ImageEditResolution
  instruction: string
  annotations: ImageEditAnnotation[]
  mask?: ImageEditMask
}

export const MAX_IMAGE_EDIT_ANNOTATIONS = 64
export const MAX_IMAGE_EDIT_INSTRUCTION = 4000
export const MAX_IMAGE_EDIT_ANNOTATION_TEXT = 500
export const MAX_IMAGE_EDIT_MASK_STROKES = 64
export const MAX_IMAGE_EDIT_MASK_POINTS = 512

export const DEFAULT_IMAGE_EDIT_CONFIG: ImageEditConfig = {
  version: 1,
  modelKey: '',
  size: 'auto',
  aspectRatio: 'auto',
  instruction: '',
  annotations: [],
  mask: { enabled: false, strokes: [], brushSize: 0.08, invert: false }
}

const TYPES = new Set<ImageEditAnnotationType>(['arrow', 'rect', 'brush', 'text'])
const COLORS = new Set<ImageEditColor>(['red', 'yellow', 'blue', 'orange'])
const clamp = (value: number): number => Math.min(1, Math.max(0, value))

function point(value: unknown): ImageEditPoint {
  const p = value as Record<string, unknown> | null
  return {
    x: clamp(typeof p?.x === 'number' && Number.isFinite(p.x) ? p.x : 0),
    y: clamp(typeof p?.y === 'number' && Number.isFinite(p.y) ? p.y : 0)
  }
}

function mask(value: unknown): ImageEditMask | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const strokes = Array.isArray(raw.strokes)
    ? raw.strokes
        .filter((stroke): stroke is unknown[] => Array.isArray(stroke))
        .slice(0, MAX_IMAGE_EDIT_MASK_STROKES)
        .map((stroke) => stroke.slice(0, MAX_IMAGE_EDIT_MASK_POINTS).map(point).filter(Boolean))
        .filter((stroke) => stroke.length >= 2)
    : []
  const rawSize =
    typeof raw.brushSize === 'number' && Number.isFinite(raw.brushSize) ? raw.brushSize : 0.08
  return {
    enabled: raw.enabled === true,
    strokes,
    brushSize: Math.min(0.5, Math.max(0.01, rawSize)),
    invert: raw.invert === true
  }
}

export function parseImageEditConfig(text: string): ImageEditConfig {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(text || '{}') as unknown
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch {
    // 配置损坏时回到安全默认值。
  }
  const annotations = Array.isArray(raw.annotations)
    ? raw.annotations.slice(0, MAX_IMAGE_EDIT_ANNOTATIONS).map((item, index) => {
        const value = (item ?? {}) as Record<string, unknown>
        const type = TYPES.has(value.type as ImageEditAnnotationType)
          ? (value.type as ImageEditAnnotationType)
          : 'arrow'
        const points = Array.isArray(value.points) ? value.points.slice(0, 64).map(point) : []
        const text =
          typeof value.text === 'string'
            ? value.text.trim().slice(0, MAX_IMAGE_EDIT_ANNOTATION_TEXT)
            : undefined
        const strokeWidth =
          typeof value.strokeWidth === 'number' && Number.isFinite(value.strokeWidth)
            ? Math.min(12, Math.max(1, value.strokeWidth))
            : 3
        return {
          id:
            typeof value.id === 'string' && value.id.trim()
              ? value.id.trim().slice(0, 80)
              : `annotation-${index + 1}`,
          type,
          color:
            value.color === 'orange'
              ? 'blue'
              : COLORS.has(value.color as ImageEditColor)
                ? (value.color as ImageEditColor)
                : 'red',
          points,
          ...(text ? { text } : {}),
          strokeWidth
        }
      })
    : []
  const ids = new Set<string>()
  for (const annotation of annotations) {
    if (ids.has(annotation.id)) annotation.id = `${annotation.id}-${ids.size + 1}`
    ids.add(annotation.id)
  }
  const parsedMask = mask(raw.mask) ??
    DEFAULT_IMAGE_EDIT_CONFIG.mask ?? {
      enabled: false,
      strokes: [],
      brushSize: 0.08,
      invert: false
    }
  return {
    version: 1,
    featureKey: typeof raw.featureKey === 'string' ? raw.featureKey.trim().slice(0, 200) : undefined,
    modelKey: typeof raw.modelKey === 'string' ? raw.modelKey.trim().slice(0, 200) : '',
    // 旧版本把比例镜像进 size；现在比例只有 aspectRatio 一个来源，读回时把比例串从 size 收敛掉。
    size:
      isImageAspectRatio(typeof raw.size === 'string' ? raw.size : '') ||
      !IMAGE_EDIT_SIZES.includes((raw.size ?? '') as ImageEditSize)
        ? 'auto'
        : (raw.size as string),
    aspectRatio: isImageAspectRatio(raw.aspectRatio)
      ? raw.aspectRatio
      : isImageAspectRatio(raw.size)
        ? raw.size
        : 'auto',
    resolution:
      typeof raw.resolution === 'string' &&
      IMAGE_EDIT_RESOLUTIONS.includes(raw.resolution as ImageEditResolution)
        ? (raw.resolution as ImageEditResolution)
        : undefined,
    instruction:
      typeof raw.instruction === 'string'
        ? raw.instruction.slice(0, MAX_IMAGE_EDIT_INSTRUCTION)
        : '',
    annotations,
    ...(parsedMask ? { mask: parsedMask } : {})
  }
}

export function serializeImageEditConfig(config: ImageEditConfig): string {
  return JSON.stringify(parseImageEditConfig(JSON.stringify(config)))
}

export function validateImageEditConfig(config: ImageEditConfig): string | null {
  if (config.annotations.length > MAX_IMAGE_EDIT_ANNOTATIONS) return '标注数量超过上限'
  if (config.instruction.length > MAX_IMAGE_EDIT_INSTRUCTION) return '修改说明超过 4000 字'
  for (const [index, annotation] of config.annotations.entries()) {
    if (!TYPES.has(annotation.type)) return `第 ${index + 1} 个标注类型无效`
    if (!COLORS.has(annotation.color)) return `第 ${index + 1} 个标注颜色无效`
    if (annotation.type === 'text' && (!annotation.text || annotation.points.length !== 1)) {
      return `第 ${index + 1} 个文字标注不完整`
    }
    if (annotation.type === 'rect' && annotation.points.length !== 2)
      return `第 ${index + 1} 个矩形标注不完整`
    if (
      (annotation.type === 'arrow' || annotation.type === 'brush') &&
      annotation.points.length < 2
    ) {
      return `第 ${index + 1} 个绘制标注不完整`
    }
  }
  if (
    !config.instruction.trim() &&
    config.annotations.length === 0 &&
    !(config.mask?.enabled && config.mask.strokes.length > 0)
  )
    return '请填写修改说明或添加至少一个标注'
  if (config.mask?.enabled && config.mask.strokes.length === 0)
    return '已启用遮罩，请至少绘制一个遮罩区域'
  if ((config.mask?.strokes.length ?? 0) > MAX_IMAGE_EDIT_MASK_STROKES)
    return '遮罩笔画数量超过上限'
  if (config.mask?.strokes.some((stroke) => stroke.length > MAX_IMAGE_EDIT_MASK_POINTS))
    return '遮罩笔画点数超过上限'
  return null
}
