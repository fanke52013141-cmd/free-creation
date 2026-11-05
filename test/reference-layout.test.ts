import { describe, expect, it } from 'vitest'
import { referenceLayout } from '../src/renderer/src/canvas/reference-layout'

describe('single-row references', () => {
  it('keeps a single source marker compact and media proportional', () => {
    expect(referenceLayout([false], 316)).toEqual({ widths: [56], hidden: 0 })
    expect(referenceLayout([true], 316)).toEqual({ widths: [48], hidden: 0 })
  })
  it('reserves the overflow counter before selecting complete media', () => {
    expect(referenceLayout(Array(10).fill(true), 316)).toEqual({
      widths: Array(5).fill(48),
      hidden: 5
    })
    expect(referenceLayout(Array(6).fill(true), 318)).toEqual({
      widths: Array(6).fill(48),
      hidden: 0
    })
  })
  it('fits mixed references and preserves the leading input order', () => {
    const result = referenceLayout([false, true, false, true], 316)
    expect(result.hidden).toBe(0)
    expect(result.widths).toEqual([56, 48, 56, 48])
    expect(referenceLayout([false, true, false], 100)).toEqual({ widths: [56], hidden: 2 })
  })
})
