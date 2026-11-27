import { describe, expect, it } from 'vitest'
import {
  computeNextPerfTierState,
  policyForPerfState,
  type PerfTierState
} from '../src/renderer/src/canvas/canvas-performance-tier'

describe('canvas-performance-tier hysteresis state machine', () => {
  it('stays in Tier 0 for <= 60 nodes and <= 200 edges with zero UX reduction', () => {
    const start: PerfTierState = { tier: 0, useMediaThumbnails: false }
    const s = computeNextPerfTierState(start, { nodeCount: 60, edgeCount: 200, mediaNodeCount: 15 })
    expect(s.tier).toBe(0)
    expect(s.useMediaThumbnails).toBe(false)
    const policy = policyForPerfState(s)
    expect(policy.virtualizeOffscreenNodes).toBe(false)
    expect(policy.suppressIdlePortPulse).toBe(false)
    expect(policy.activeOnlyEdgeFlow).toBe(false)
    expect(policy.skipEdgeHitDom).toBe(false)
    expect(policy.disableLightCardBlur).toBe(false)
    expect(policy.enableOverviewLod).toBe(false)
  })

  it('transitions Tier 0 -> 1 -> 2 -> 3 and respects hysteresis on downgrade', () => {
    let s: PerfTierState = { tier: 0, useMediaThumbnails: false }
    s = computeNextPerfTierState(s, { nodeCount: 61, edgeCount: 50, mediaNodeCount: 5 })
    expect(s.tier).toBe(1)
    expect(policyForPerfState(s).virtualizeOffscreenNodes).toBe(true)

    // Hysteresis: stays in Tier 1 at 45..60
    s = computeNextPerfTierState(s, { nodeCount: 45, edgeCount: 40, mediaNodeCount: 5 })
    expect(s.tier).toBe(1)
    s = computeNextPerfTierState(s, { nodeCount: 44, edgeCount: 40, mediaNodeCount: 5 })
    expect(s.tier).toBe(0)

    // Jump straight to Tier 2 via edge count
    s = computeNextPerfTierState(s, { nodeCount: 50, edgeCount: 201, mediaNodeCount: 5 })
    expect(s.tier).toBe(2)
    expect(policyForPerfState(s).activeOnlyEdgeFlow).toBe(true)
    expect(policyForPerfState(s).skipEdgeHitDom).toBe(true)

    // Hysteresis: stays in Tier 2 at 160 edges
    s = computeNextPerfTierState(s, { nodeCount: 50, edgeCount: 160, mediaNodeCount: 5 })
    expect(s.tier).toBe(2)
    s = computeNextPerfTierState(s, { nodeCount: 50, edgeCount: 159, mediaNodeCount: 5 })
    expect(s.tier).toBe(0)

    // Tier 3 at >300 nodes or >400 edges
    s = computeNextPerfTierState(s, { nodeCount: 301, edgeCount: 100, mediaNodeCount: 5 })
    expect(s.tier).toBe(3)
    expect(policyForPerfState(s).viewportMarginPx).toBe(500)
    expect(policyForPerfState(s).offscreenLruLimit).toBe(16)
    expect(policyForPerfState(s).cullOffscreenEdges).toBe(true)
  })

  it('tracks media thumbnail threshold independently (>15 enter, <10 exit)', () => {
    let s: PerfTierState = { tier: 0, useMediaThumbnails: false }
    s = computeNextPerfTierState(s, { nodeCount: 16, edgeCount: 10, mediaNodeCount: 16 })
    expect(s.tier).toBe(0)
    expect(s.useMediaThumbnails).toBe(true)

    s = computeNextPerfTierState(s, { nodeCount: 10, edgeCount: 5, mediaNodeCount: 10 })
    expect(s.useMediaThumbnails).toBe(true)

    s = computeNextPerfTierState(s, { nodeCount: 9, edgeCount: 5, mediaNodeCount: 9 })
    expect(s.useMediaThumbnails).toBe(false)
  })
})
