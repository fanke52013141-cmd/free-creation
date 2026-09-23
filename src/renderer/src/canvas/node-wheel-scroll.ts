export interface ScrollMetrics {
  position: number
  extent: number
  viewport: number
}

/** Returns whether the local scroll surface can consume this wheel direction. */
export function canConsumeWheel(metrics: ScrollMetrics, delta: number): boolean {
  const max = metrics.extent - metrics.viewport
  if (max <= 1 || delta === 0) return false
  return delta < 0 ? metrics.position > 1 : metrics.position < max - 1
}
