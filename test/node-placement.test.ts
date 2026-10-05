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

  it('preferredX overrides the derived column so new siblings align to the existing column', () => {
    // 来源节点后来被移动过：已有下游在 x=396，新节点必须对齐同一条纵线，而不是按
    // source 重推出 x=436 造成阶梯错位（用户 2026-10-05）。
    expect(
      findNodeContinuationPlacement({
        source: { x: 40, y: 100, w: 340, h: 260 },
        existing: [{ x: 396, y: 100, w: 340, h: 260 }],
        targetW: 340,
        targetH: 260,
        preferredX: 396
      })
    ).toEqual({ x: 396, y: 426 })
  })
})
