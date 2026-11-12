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
 *
 * L3：反向边（源在目标右侧，如审核回连/返工）不再翻折 S 型穿过中间卡片，
 * 改走卡片上方外弧：控制柄沿垂直方向，弧顶高度与跨度成比例（与前向边同一
 * 等比约定，页面坐标缩放时形状保持不变）。前向路径公式逐字节保持不变（零回归）。
 */
export function buildDataEdgePath(
  start: EdgePoint,
  end: EdgePoint,
  opts?: { backward?: boolean }
): string {
  if (opts?.backward) {
    const lift = Math.abs(end.x - start.x) * 0.25
    const topY = Math.min(start.y, end.y) - lift
    return `M ${start.x} ${start.y} C ${start.x} ${topY}, ${end.x} ${topY}, ${end.x} ${end.y}`
  }
  const dx = end.x - start.x
  const handle = Math.abs(dx) * 0.46
  const direction = dx >= 0 ? 1 : -1

  return `M ${start.x} ${start.y} C ${start.x + direction * handle} ${start.y}, ${end.x - direction * handle} ${end.y}, ${end.x} ${end.y}`
}

/** 源节点中心在目标节点中心右侧（含重合）即为反向边，调用方共享同一判定。 */
export function isBackwardEdge(
  sourceCenterX: number,
  targetCenterX: number
): boolean {
  return sourceCenterX >= targetCenterX
}
