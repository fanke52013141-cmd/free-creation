import { describe, expect, it } from 'vitest'
import { findNodeContinuationPlacement } from '../src/renderer/src/canvas/node-placement'

const source = { x: 0, y: 100, w: 340, h: 260 }

describe('continuation node placement', () => {
  it('places the first continuation to the right, aligned to the source', () => {
    expect(
      findNodeContinuationPlacement({ source, existing: [], targetW: 340, targetH: 260 })
    ).toEqual({ x: 436, y: 100 })
  })

  it('moves down one full row when the aligned slot is occupied', () => {
    expect(
      findNodeContinuationPlacement({
        source,
        existing: [{ x: 436, y: 100, w: 340, h: 260 }],
        targetW: 340,
        targetH: 260
      })
    ).toEqual({ x: 436, y: 426 })
  })

  it('scans past multiple rows occupied by one tall node', () => {
    expect(
      findNodeContinuationPlacement({
        source,
        existing: [{ x: 436, y: 100, w: 340, h: 2000 }],
        targetW: 340,
        targetH: 260
      })
    ).toEqual({ x: 436, y: 2382 })
  })

  it('uses the nearest open row instead of jumping below every node in the column', () => {
    expect(
      findNodeContinuationPlacement({
        source,
        existing: [
          { x: 436, y: 100, w: 340, h: 260 },
          { x: 436, y: 752, w: 340, h: 260 }
        ],
        targetW: 340,
        targetH: 260
      })
    ).toEqual({ x: 436, y: 426 })
  })

  it('ignores shapes outside the target column', () => {
    expect(
      findNodeContinuationPlacement({
        source,
        existing: [{ x: 900, y: 100, w: 340, h: 260 }],
        targetW: 340,
        targetH: 260
      })
    ).toEqual({ x: 436, y: 100 })
  })
})
