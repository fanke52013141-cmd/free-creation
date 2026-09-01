/**
 * 图片宫格拆分的可持久化配置与纯计算函数。
 *
 * `scalePercent` 表示每格输出面积相对原格面积的百分比，而不是边长百分比：
 * 例如 90% 面积的线性缩放系数为 sqrt(0.9)。所有分格以各自单元格中心为锚点。
 */
export interface ImageSplitConfig {
  version: 1
  rows: number
  columns: number
  scalePercent: number
}

export interface ImageSplitTile {
  index: number
  row: number
  column: number
  rect: { x: number; y: number; width: number; height: number }
}

export const MAX_IMAGE_SPLIT_TILES = 64

export const DEFAULT_IMAGE_SPLIT_CONFIG: ImageSplitConfig = {
  version: 1,
  rows: 3,
  columns: 3,
  scalePercent: 100
}

function integerInRange(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_IMAGE_SPLIT_TILES, Math.max(1, Math.round(value)))
    : fallback
}

function percentageInRange(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(1, Number(value.toFixed(2))))
    : fallback
}

/** 收敛外部 JSON；若行列乘积超上限，优先保持行数并下调列数。 */
export function parseImageSplitConfig(text: string): ImageSplitConfig {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const rows = integerInRange(raw.rows, DEFAULT_IMAGE_SPLIT_CONFIG.rows)
    const requestedColumns = integerInRange(raw.columns, DEFAULT_IMAGE_SPLIT_CONFIG.columns)
    return {
      version: 1,
      rows,
      columns: Math.max(1, Math.min(requestedColumns, Math.floor(MAX_IMAGE_SPLIT_TILES / rows))),
      scalePercent: percentageInRange(raw.scalePercent, DEFAULT_IMAGE_SPLIT_CONFIG.scalePercent)
    }
  } catch {
    return structuredClone(DEFAULT_IMAGE_SPLIT_CONFIG)
  }
}

export function serializeImageSplitConfig(config: ImageSplitConfig): string {
  return JSON.stringify(parseImageSplitConfig(JSON.stringify(config)))
}

export function imageSplitCount(config: ImageSplitConfig): number {
  const safe = parseImageSplitConfig(JSON.stringify(config))
  return safe.rows * safe.columns
}

/** 产生从左到右、从上到下稳定排序的归一化裁剪区域。 */
export function buildImageSplitTiles(config: ImageSplitConfig): ImageSplitTile[] {
  const safe = parseImageSplitConfig(JSON.stringify(config))
  const cellWidth = 1 / safe.columns
  const cellHeight = 1 / safe.rows
  // scalePercent 是面积比例，故边长比例需要开平方。
  const linearScale = Math.sqrt(safe.scalePercent / 100)
  const width = cellWidth * linearScale
  const height = cellHeight * linearScale
  const offsetX = (cellWidth - width) / 2
  const offsetY = (cellHeight - height) / 2
  return Array.from({ length: safe.rows * safe.columns }, (_, index) => {
    const rowIndex = Math.floor(index / safe.columns)
    const columnIndex = index % safe.columns
    return {
      index,
      row: rowIndex + 1,
      column: columnIndex + 1,
      rect: {
        x: columnIndex * cellWidth + offsetX,
        y: rowIndex * cellHeight + offsetY,
        width,
        height
      }
    }
  })
}
