/**
 * 连线层共用的纯几何工具（与 React / tldraw 解耦，便于单测）。
 */

export interface EdgePageRect {
  x: number
  y: number
  width: number
  height: number
}

/** 连线只在节点之间，因此节点边界的并集再外扩一点即可覆盖全部几何与光晕。 */
const MASK_PADDING = 200

/**
 * mask 的覆盖范围（页面坐标）。
 *
 * mask 只负责把节点卡片"挖空"，其边界必须覆盖所有连线绘制像素，否则路径会被裁掉。
 * 该范围只随文档变化，不随缩放变化。
 */
export function edgeMaskExtents(rects: readonly EdgePageRect[]): {
  x: number
  y: number
  width: number
  height: number
} {
  if (rects.length === 0) {
    return {
      x: -MASK_PADDING,
      y: -MASK_PADDING,
      width: MASK_PADDING * 2,
      height: MASK_PADDING * 2
    }
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }
  return {
    x: minX - MASK_PADDING,
    y: minY - MASK_PADDING,
    width: maxX - minX + MASK_PADDING * 2,
    height: maxY - minY + MASK_PADDING * 2
  }
}
