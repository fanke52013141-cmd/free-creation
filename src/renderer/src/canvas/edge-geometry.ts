export interface EdgePoint {
  x: number
  y: number
}

/**
 * 8px可见圆点距卡边净距20px，圆心位于卡片边缘外24px，
 * 也给卡片正文留出完整的点击/选中区域。视觉连线和端口渲染必须共享该距离。
 */
export const NODE_PORT_OUTSET = 24
// 可见核心8px，命中盒24px；两者都独立于卡片，不绘制连接底板。
export const NODE_PORT_SIZE = 24

/**
 * Build the visible data-edge curve in screen coordinates.
 *
 * The handle is intentionally derived only from the horizontal distance between
 * the two anchors.  Fixed minimum / maximum handles look acceptable at one zoom
 * level, but change their proportion to the node layout as the camera zooms.
 * Keeping it proportional makes the same page geometry render as a scaled copy
 * at every zoom level.
 */
export function buildDataEdgePath(start: EdgePoint, end: EdgePoint): string {
  const dx = end.x - start.x
  const handle = Math.abs(dx) * 0.46
  const direction = dx >= 0 ? 1 : -1

  return `M ${start.x} ${start.y} C ${start.x + direction * handle} ${start.y}, ${end.x - direction * handle} ${end.y}, ${end.x} ${end.y}`
}
