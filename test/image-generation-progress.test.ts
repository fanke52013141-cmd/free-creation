import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_GENERATION_ESTIMATE_MS,
  estimateImageGenerationDuration,
  imageGenerationProgressPercent,
  normalizeImageGenerationEstimate
} from '../src/renderer/src/canvas/image-generation-progress'

const sample = (
  runId: string,
  providerKey: string,
  modelKey: string,
  durationMs: number,
  recordedAt: number
) => ({ runId, providerKey, modelKey, durationMs, recordedAt })

describe('image generation estimated progress', () => {
  it('uses a conservative estimate until local timing samples exist', () => {
    expect(normalizeImageGenerationEstimate(undefined)).toBe(DEFAULT_IMAGE_GENERATION_ESTIMATE_MS)
    expect(normalizeImageGenerationEstimate(Number.NaN)).toBe(DEFAULT_IMAGE_GENERATION_ESTIMATE_MS)
  })

  it('grows from elapsed time and plateaus at 99 percent', () => {
    expect(imageGenerationProgressPercent(0, 60_000)).toBe(0)
    expect(imageGenerationProgressPercent(15_000, 60_000)).toBe(25)
    expect(imageGenerationProgressPercent(60_000, 60_000)).toBe(99)
    expect(imageGenerationProgressPercent(100_000, 60_000)).toBe(99)
  })

  it('bounds unusually small or large provider samples', () => {
    expect(normalizeImageGenerationEstimate(100)).toBe(3_000)
    expect(normalizeImageGenerationEstimate(60 * 60_000)).toBe(10 * 60_000)
  })

  it('prefers recent selected-model samples and falls back to the provider average', () => {
    const samples = [
      sample('new-model', 'provider-a', 'provider-a::model-a', 20_000, 30),
      sample('old-model', 'provider-a', 'provider-a::model-a', 40_000, 20),
      sample('other-model', 'provider-a', 'provider-a::model-b', 100_000, 10),
      sample('wrong-provider', 'provider-b', 'provider-b::model-a', 500_000, 40)
    ]
    expect(estimateImageGenerationDuration(samples, 'provider-a', 'provider-a::model-a')).toBe(
      30_000
    )
    expect(estimateImageGenerationDuration(samples, 'provider-a', 'unknown')).toBe(53_333 * 1)
    expect(estimateImageGenerationDuration(samples, 'missing', 'unknown', 3)).toBe(180_000)
  })
})
