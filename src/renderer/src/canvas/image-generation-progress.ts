import type { ImageGenerationTimingSample } from '@shared/contracts'

/** A deliberately conservative first-run estimate until this provider has local samples. */
export const DEFAULT_IMAGE_GENERATION_ESTIMATE_MS = 60_000

export const IMAGE_GENERATION_MIN_ESTIMATE_MS = 3_000
export const IMAGE_GENERATION_MAX_ESTIMATE_MS = 10 * 60_000

/** Clamp estimates so a malformed or stale local sample cannot make progress unusable. */
export function normalizeImageGenerationEstimate(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value === null || value === undefined || value <= 0) {
    return DEFAULT_IMAGE_GENERATION_ESTIMATE_MS
  }
  return Math.min(IMAGE_GENERATION_MAX_ESTIMATE_MS, Math.max(IMAGE_GENERATION_MIN_ESTIMATE_MS, value))
}

/** Prefer the selected model's recent samples, then use the provider's aggregate. */
export function estimateImageGenerationDuration(
  samples: readonly ImageGenerationTimingSample[],
  providerKey: string,
  modelKey: string,
  count = 1
): number {
  const providerSamples = samples
    .filter((sample) => sample.providerKey === providerKey && sample.durationMs > 0)
    .slice()
    .sort((left, right) => right.recordedAt - left.recordedAt)
  const modelSamples = providerSamples.filter((sample) => sample.modelKey === modelKey).slice(0, 10)
  const selectedSamples = modelSamples.length ? modelSamples : providerSamples.slice(0, 20)
  const average = selectedSamples.length
    ? selectedSamples.reduce((total, sample) => total + sample.durationMs, 0) /
      selectedSamples.length
    : DEFAULT_IMAGE_GENERATION_ESTIMATE_MS
  const safeCount = Number.isFinite(count)
    ? Math.max(1, Math.min(9, Math.floor(count)))
    : 1
  return Math.round(normalizeImageGenerationEstimate(average) * safeCount)
}

/**
 * Estimated visual progress only; it is not a provider-reported task percentage.
 * A completed image replaces the overlay immediately; while still running the bar stops at 99%.
 */
export function imageGenerationProgressPercent(elapsedMs: number, estimateMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  const safeEstimate = Number.isFinite(estimateMs)
    ? Math.min(
        IMAGE_GENERATION_MAX_ESTIMATE_MS * 9,
        Math.max(IMAGE_GENERATION_MIN_ESTIMATE_MS, estimateMs)
      )
    : DEFAULT_IMAGE_GENERATION_ESTIMATE_MS
  return Math.max(1, Math.min(99, Math.floor((elapsedMs / safeEstimate) * 100)))
}
