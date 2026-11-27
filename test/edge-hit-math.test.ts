import { describe, expect, it } from 'vitest'
import { buildDataEdgePath } from '../src/renderer/src/canvas/edge-geometry'
import {
  buildDataEdgeCurve,
  distancePointToCubicBezier
} from '../src/renderer/src/canvas/edge-hit-math'

describe('edge-hit-math', () => {
  it('buildDataEdgeCurve produces the exact same SVG path as buildDataEdgePath', () => {
    const start = { x: 100, y: 200 }
    const end = { x: 420, y: 360 }
    expect(buildDataEdgeCurve(start, end).path).toBe(buildDataEdgePath(start, end))
    expect(buildDataEdgeCurve(end, start, { backward: true }).path).toBe(
      buildDataEdgePath(end, start, { backward: true })
    )
  })

  it('computes near-zero distance for points on the curve and large distance far away', () => {
    const { curve } = buildDataEdgeCurve({ x: 0, y: 0 }, { x: 200, y: 0 })
    expect(distancePointToCubicBezier(100, 0, curve, 20)).toBeLessThan(0.5)
    expect(distancePointToCubicBezier(100, 10, curve, 20)).toBeCloseTo(10, 0)
    expect(distancePointToCubicBezier(100, 100, curve, 20)).toBeGreaterThan(20)
  })
})
