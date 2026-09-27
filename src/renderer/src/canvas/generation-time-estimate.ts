import type { GenerationTimingFeatures, GenerationTimingSample } from '@shared/contracts'

const MIN_ESTIMATE_MS = 3_000
const MAX_ESTIMATE_MS = 4 * 60 * 60 * 1000

function resolutionFactor(value: string | undefined): number {
  if (!value) return 1
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number <= 0) return 1
  const verticalPixels = value.toLowerCase().endsWith('k') ? number * 1000 : number
  return Math.max(0.7, Math.min(2.5, Math.pow(verticalPixels / 720, 0.65)))
}

/** First-run work estimate; later observations calibrate this shape for each model. */
export function generationWorkScore(
  operation: string,
  features: GenerationTimingFeatures | undefined,
  fallbackMs: number
): number {
  if (!features) return fallbackMs
  const text = Math.max(0, features.textUnits ?? 0)
  const targetSeconds = Math.max(0, features.targetDurationSec ?? 0)
  const sourceSeconds = Math.max(0, features.sourceDurationSec ?? 0)
  const fps = Math.max(1, features.sourceFps ?? 24)
  const resolution = resolutionFactor(features.resolution)
  switch (operation) {
    case 'video':
      return targetSeconds > 0
        ? 20_000 + targetSeconds * 12_000 * resolution + text * 60
        : fallbackMs + text * 60
    case 'video-depth':
    case 'video-clay':
      return sourceSeconds > 0
        ? 15_000 + sourceSeconds * fps * 130 * resolution
        : fallbackMs
    case 'video-clip':
      return sourceSeconds > 0 ? 8_000 + sourceSeconds * 200 * resolution : fallbackMs
    case 'video-audio':
      return sourceSeconds > 0 ? 7_000 + sourceSeconds * 180 : fallbackMs
    case 'video-frame':
      return 12_000 + resolution * 5_000
    case 'speech':
      return text > 0 ? 8_000 + text * 120 : fallbackMs
    case 'tts':
      return sourceSeconds > 0 ? 15_000 + sourceSeconds * 900 : fallbackMs
    case 'voice-design':
      return text > 0 ? 20_000 + text * 140 : fallbackMs
    case 'vocal-separate':
      return sourceSeconds > 0 ? 10_000 + sourceSeconds * 1_800 : fallbackMs
    case 'chat':
    case 'ai-process':
    case 'script':
    case 'storyboard':
    case 'structured':
    case 'text':
      return text > 0 ? 10_000 + text * 25 : fallbackMs
    default:
      return fallbackMs
  }
}

/** Scale real completed runs by input work, then average comparable recent samples. */
export function estimateGenerationDuration(
  operation: string,
  features: GenerationTimingFeatures | undefined,
  providerKey: string,
  modelKey: string,
  samples: readonly GenerationTimingSample[],
  fallbackMs: number
): number {
  const baseline = generationWorkScore(operation, features, fallbackMs)
  const operationSamples = samples.filter((sample) => sample.operation === operation)
  const modelSamples = modelKey
    ? operationSamples.filter((sample) => sample.modelKey === modelKey && sample.providerKey === providerKey)
    : []
  const providerSamples = providerKey
    ? operationSamples.filter((sample) => sample.providerKey === providerKey)
    : []
  let comparable = modelSamples.length ? modelSamples : providerSamples.length ? providerSamples : operationSamples
  if (features?.mode) {
    const sameMode = comparable.filter((sample) => sample.mode === features.mode)
    if (sameMode.length >= 3) comparable = sameMode
  }
  if (features?.resolution) {
    const sameResolution = comparable.filter((sample) => sample.resolution === features.resolution)
    if (sameResolution.length >= 3) comparable = sameResolution
  }
  const predictions = [...comparable]
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .slice(0, 20)
    .filter((sample) => Number.isFinite(sample.durationMs) && sample.durationMs > 0)
    .map((sample) => {
      const sampleScore = generationWorkScore(operation, sample, fallbackMs)
      const ratio = Math.max(0.2, Math.min(8, baseline / Math.max(1, sampleScore)))
      return sample.durationMs * ratio
    })
  const duration = predictions.length
    ? predictions.reduce((sum, value) => sum + value, 0) / predictions.length
    : baseline
  return Math.round(Math.max(MIN_ESTIMATE_MS, Math.min(MAX_ESTIMATE_MS, duration)))
}
