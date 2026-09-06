export interface EdgePoint {
  x: number
  y: number
}

/**
 * 连线端口不再压在卡片边框上。端口圆心位于卡片边缘外 16px，既让拖拽更容易命中，
 * 也给卡片正文留出完整的点击/选中区域。视觉连线和端口渲染必须共享该距离。
 */
export const NODE_PORT_OUTSET = 16
export const NODE_PORT_SIZE = 18

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
