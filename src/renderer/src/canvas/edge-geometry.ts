export interface EdgePoint {
  x: number
  y: number
}

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
