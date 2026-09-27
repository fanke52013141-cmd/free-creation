export const DEFAULT_NODE_EXECUTION_ESTIMATES_MS: Readonly<Record<string, number>> = {
  audio: 20_000,
  code: 15_000,
  director: 30_000,
  file: 5_000,
  image: 10_000,
  'image-gen': 60_000,
  'image-edit': 45_000,
  json: 10_000,
  processor: 30_000,
  video: 120_000,
  'video-asset': 15_000,
  'video-audio': 20_000,
  'video-clip': 20_000,
  'video-depth': 120_000,
  'video-clay': 120_000,
  'video-frame': 20_000,
  speech: 45_000,
  tts: 45_000,
  'voice-design': 60_000,
  'vocal-separate': 60_000,
  chat: 30_000,
  'ai-process': 30_000,
  script: 30_000,
  storyboard: 30_000,
  structured: 30_000,
  text: 30_000,
  iterate: 60_000
}

export const DEFAULT_NODE_EXECUTION_ESTIMATE_MS = 15_000
export const MIN_NODE_EXECUTION_ESTIMATE_MS = 1_000
export const MAX_NODE_EXECUTION_ESTIMATE_MS = 4 * 60 * 60_000

/** Average recent successful runs; invalid or absent samples use the operation fallback. */
export function averageNodeExecutionDuration(
  durations: readonly number[],
  fallbackMs: number
): number {
  const recent = durations
    .filter((duration) => Number.isFinite(duration) && duration > 0)
    .slice(0, 20)
  const average = recent.length
    ? recent.reduce((total, duration) => total + duration, 0) / recent.length
    : fallbackMs
  return Math.round(
    Math.min(MAX_NODE_EXECUTION_ESTIMATE_MS, Math.max(MIN_NODE_EXECUTION_ESTIMATE_MS, average))
  )
}

/** Linear visual estimate; while the operation is still active it never reports completion. */
export function nodeExecutionProgressPercent(elapsedMs: number, estimateMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  const safeEstimate = Number.isFinite(estimateMs)
    ? Math.min(MAX_NODE_EXECUTION_ESTIMATE_MS, Math.max(MIN_NODE_EXECUTION_ESTIMATE_MS, estimateMs))
    : DEFAULT_NODE_EXECUTION_ESTIMATE_MS
  return Math.max(1, Math.min(99, Math.floor((elapsedMs / safeEstimate) * 100)))
}
