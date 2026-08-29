/** 图片修改节点的稳定配置：标注是配置，不是隐藏的数据端口。 */
export type ImageEditAnnotationType = 'arrow' | 'rect' | 'brush' | 'text'
export type ImageEditColor = 'red' | 'yellow' | 'orange'

export interface ImageEditPoint {
  x: number
  y: number
}

export interface ImageEditAnnotation {
  id: string
  type: ImageEditAnnotationType
  color: ImageEditColor
  points: ImageEditPoint[]
  text?: string
  strokeWidth?: number
}

export interface ImageEditConfig {
  version: 1
  modelKey: string
  size: string
  instruction: string
  annotations: ImageEditAnnotation[]
}

export const MAX_IMAGE_EDIT_ANNOTATIONS = 64
export const MAX_IMAGE_EDIT_INSTRUCTION = 4000
export const MAX_IMAGE_EDIT_ANNOTATION_TEXT = 500

export const DEFAULT_IMAGE_EDIT_CONFIG: ImageEditConfig = {
  version: 1,
  modelKey: '',
  size: 'auto',
  instruction: '',
  annotations: []
}

const TYPES = new Set<ImageEditAnnotationType>(['arrow', 'rect', 'brush', 'text'])
const COLORS = new Set<ImageEditColor>(['red', 'yellow', 'orange'])
const clamp = (value: number): number => Math.min(1, Math.max(0, value))

function point(value: unknown): ImageEditPoint {
  const p = value as Record<string, unknown> | null
  return {
    x: clamp(typeof p?.x === 'number' && Number.isFinite(p.x) ? p.x : 0),
    y: clamp(typeof p?.y === 'number' && Number.isFinite(p.y) ? p.y : 0)
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
          color: COLORS.has(value.color as ImageEditColor)
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
  return {
    version: 1,
    modelKey: typeof raw.modelKey === 'string' ? raw.modelKey.trim().slice(0, 200) : '',
    size: typeof raw.size === 'string' && raw.size.trim() ? raw.size.trim().slice(0, 32) : 'auto',
    instruction:
      typeof raw.instruction === 'string'
        ? raw.instruction.slice(0, MAX_IMAGE_EDIT_INSTRUCTION)
        : '',
    annotations
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
  if (!config.instruction.trim() && config.annotations.length === 0)
    return '请填写修改说明或添加至少一个标注'
  return null
}
