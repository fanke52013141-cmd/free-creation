import { describe, expect, it } from 'vitest'
import { estimateGenerationDuration } from '../src/renderer/src/canvas/generation-time-estimate'

const samples = [
  { sampleId: '1', operation: 'video', providerKey: 'a', modelKey: 'shared', durationMs: 40_000, recordedAt: 1 },
  { sampleId: '2', operation: 'video', providerKey: 'a', modelKey: 'shared', durationMs: 60_000, recordedAt: 2 },
  { sampleId: '3', operation: 'video', providerKey: 'b', modelKey: 'shared', durationMs: 120_000, recordedAt: 3 }
]

describe('generation duration by channel', () => {
  it('averages successful timings for the selected channel and model', () => {
    expect(estimateGenerationDuration('video', undefined, 'a', 'shared', samples, 90_000)).toBe(50_000)
    expect(estimateGenerationDuration('video', undefined, 'b', 'shared', samples, 90_000)).toBe(120_000)
  })

  it('uses the first-run estimate for a channel with no history', () => {
    expect(estimateGenerationDuration('video', undefined, 'new', 'shared', samples, 90_000)).toBe(90_000)
  })
})
