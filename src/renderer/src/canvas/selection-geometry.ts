export interface PageBoundsLike {
  x: number
  y: number
  maxX: number
  maxY: number
}

interface ScreenPoint {
  x: number
  y: number
}

export interface SelectionGeometry {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 选择框只给节点几何留出一圈很小的屏幕空间，不承担缩放或旋转操作。
 * 它必须是屏幕像素而不是 page 单位，才能在缩放时保持稳定的视觉留白。
 */
export const SELECTION_FRAME_OUTSET_PX = 12

function isUsablePageBounds(bounds: PageBoundsLike | null | undefined): bounds is PageBoundsLike {
  return Boolean(
    bounds &&
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y) &&
      Number.isFinite(bounds.maxX) &&
      Number.isFinite(bounds.maxY) &&
      bounds.maxX >= bounds.x &&
      bounds.maxY >= bounds.y
  )
}

/**
 * 仅合并明确传入的节点 bounds。调用方不能把连接箭头或 tldraw 的整体选择 bounds
 * 传进来；这样选框不会包住边，也不会把相邻未选节点卷进来。
 */
export function selectionBoundsUnion(
  bounds: Iterable<PageBoundsLike | null | undefined>
): PageBoundsLike | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let count = 0

  for (const bound of bounds) {
    if (!isUsablePageBounds(bound)) continue
    minX = Math.min(minX, bound.x)
    minY = Math.min(minY, bound.y)
    maxX = Math.max(maxX, bound.maxX)
    maxY = Math.max(maxY, bound.maxY)
    count += 1
  }

  return count > 0 ? { x: minX, y: minY, maxX, maxY } : null
}

/**
 * Convert page bounds to one screen-space rectangle for the selection frame and decorations.
 * Keeping the outset here ensures markers cannot drift from the visible dashed frame.
 */
export function selectionGeometryFromPageBounds(
  bounds: PageBoundsLike | null | undefined,
  hostBounds: Pick<DOMRect, 'left' | 'top'>,
  pageToScreen: (point: ScreenPoint) => ScreenPoint
): SelectionGeometry | null {
  if (!isUsablePageBounds(bounds)) return null
  const topLeft = pageToScreen({ x: bounds.x, y: bounds.y })
  const bottomRight = pageToScreen({ x: bounds.maxX, y: bounds.maxY })
  if (
    !Number.isFinite(topLeft.x) ||
    !Number.isFinite(topLeft.y) ||
    !Number.isFinite(bottomRight.x) ||
    !Number.isFinite(bottomRight.y)
  ) {
    return null
  }
  const left = topLeft.x - hostBounds.left - SELECTION_FRAME_OUTSET_PX
  const top = topLeft.y - hostBounds.top - SELECTION_FRAME_OUTSET_PX
  const width = bottomRight.x - topLeft.x + SELECTION_FRAME_OUTSET_PX * 2
  const height = bottomRight.y - topLeft.y + SELECTION_FRAME_OUTSET_PX * 2

  return { left, top, width, height }
}
