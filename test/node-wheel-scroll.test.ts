import { describe, expect, it } from 'vitest'
import { canConsumeWheel } from '../src/renderer/src/canvas/node-wheel-scroll'

describe('node wheel ownership', () => {
  it('lets overflowing node content consume wheel movement away from its edges', () => {
    const metrics = { position: 40, extent: 300, viewport: 100 }
    expect(canConsumeWheel(metrics, 1)).toBe(true)
    expect(canConsumeWheel(metrics, -1)).toBe(true)
  })

  it('hands wheel movement to the canvas when content cannot move in that direction', () => {
    const metrics = { position: 0, extent: 300, viewport: 100 }
    expect(canConsumeWheel(metrics, -1)).toBe(false)
    expect(canConsumeWheel({ ...metrics, position: 200 }, 1)).toBe(false)
  })

  it('does not claim wheel input for a non-overflowing or zero-delta surface', () => {
    expect(canConsumeWheel({ position: 0, extent: 100, viewport: 100 }, 1)).toBe(false)
    expect(canConsumeWheel({ position: 20, extent: 300, viewport: 100 }, 0)).toBe(false)
  })
})
