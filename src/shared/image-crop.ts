/**
 * 图片裁剪节点的可持久化配置。
 *
 * 坐标始终是相对原图宽高的 0~1 值：这样换一张分辨率不同的图片后，裁剪构图仍然
 * 可解释、可复现，也不会把 UI 像素坐标误写入工作流数据。
 */
export type ImageCropMode = 'rect' | 'quad'

/**
 * 矩形裁剪的显示比例。比例是编辑约束而不是输出格式：执行时仍只依赖归一化 rect，
 * 因而不同分辨率的同一张素材也能稳定复现相同构图。
 */
export type ImageCropAspectRatio =
  | 'free'
  | '1:1'
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:4'
  | '3:2'
  | '2:3'
  | '21:9'
  | '9:21'
  | '5:4'
  | '4:5'

export const IMAGE_CROP_ASPECT_RATIOS: Readonly<Record<ImageCropAspectRatio, number | null>> = {
  free: null,
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '21:9': 21 / 9,
  '9:21': 9 / 21,
  '5:4': 5 / 4,
  '4:5': 4 / 5
}

export interface NormalizedPoint {
  x: number
  y: number
}

export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageCropConfig {
  version: 1
  mode: ImageCropMode
  /** `free` 为自由拖动；其他值锁定矩形选区的视觉宽高比例。 */
  aspectRatio: ImageCropAspectRatio
  rect: NormalizedRect
  /** 顺序固定为左上、右上、左下、右下；quad 模式用 FFmpeg 透视滤镜变换。 */
  points: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint]
}

export const DEFAULT_IMAGE_CROP_CONFIG: ImageCropConfig = {
  version: 1,
  mode: 'rect',
  aspectRatio: 'free',
  rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.1, y: 0.9 },
    { x: 0.9, y: 0.9 }
  ]
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(6))
}

function numberAt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback
}

function pointAt(value: unknown, fallback: NormalizedPoint): NormalizedPoint {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    x: numberAt(source.x, fallback.x),
    y: numberAt(source.y, fallback.y)
  }
}

function aspectRatioAt(value: unknown): ImageCropAspectRatio {
  return typeof value === 'string' && value in IMAGE_CROP_ASPECT_RATIOS
    ? (value as ImageCropAspectRatio)
    : 'free'
}

/** 把任意文本安全收敛为当前契约版本的可执行配置。 */
export function parseImageCropConfig(text: string): ImageCropConfig {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const rawRect =
      raw.rect && typeof raw.rect === 'object' ? (raw.rect as Record<string, unknown>) : {}
    const base = DEFAULT_IMAGE_CROP_CONFIG
    const rect = {
      x: numberAt(rawRect.x, base.rect.x),
      y: numberAt(rawRect.y, base.rect.y),
      width: numberAt(rawRect.width, base.rect.width),
      height: numberAt(rawRect.height, base.rect.height)
    }
    // 宽高至少留 1/10000，且绝不越过图像右/下边界。
    rect.width = roundCoordinate(Math.max(0.0001, Math.min(rect.width, 1 - rect.x)))
    rect.height = roundCoordinate(Math.max(0.0001, Math.min(rect.height, 1 - rect.y)))
    const rawPoints = Array.isArray(raw.points) ? raw.points : []
    return {
      version: 1,
      mode: raw.mode === 'quad' ? 'quad' : 'rect',
      aspectRatio: aspectRatioAt(raw.aspectRatio),
      rect,
      points: base.points.map((fallback, index) =>
        pointAt(rawPoints[index], fallback)
      ) as ImageCropConfig['points']
    }
  } catch {
    return structuredClone(DEFAULT_IMAGE_CROP_CONFIG)
  }
}

export function serializeImageCropConfig(config: ImageCropConfig): string {
  return JSON.stringify(parseImageCropConfig(JSON.stringify(config)))
}

/** 四点顺序和面积的最小合法性验证；避免把交叉/退化四边形传进 FFmpeg。 */
export function validateImageCropConfig(config: ImageCropConfig): string | null {
  if (config.mode === 'rect') {
    return config.rect.width > 0 && config.rect.height > 0 ? null : '裁剪区域不能为零'
  }
  const [a, b, c, d] = config.points
  const cross = (p1: NormalizedPoint, p2: NormalizedPoint, p3: NormalizedPoint): number =>
    (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x)
  // 两个三角形的有向面积同号且非零，表示固定顺序的四边形没有自交。
  const first = cross(a, b, d)
  const second = cross(a, d, c)
  if (Math.abs(first) < 0.00001 || Math.abs(second) < 0.00001 || first * second < 0) {
    return '四个角点必须形成非交叉、非退化的区域'
  }
  return null
}
