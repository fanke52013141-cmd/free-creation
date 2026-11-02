import { describe, expect, it } from 'vitest'
import { edgeMaskExtents } from '../src/renderer/src/canvas/edge-visual-extents'

describe('连线遮罩范围', () => {
  it('覆盖所有节点边界并留出描边/光晕余量，避免路径被裁掉', () => {
    const extents = edgeMaskExtents([
      { x: 80, y: 120, width: 340, height: 260 },
      { x: 700, y: 180, width: 340, height: 320 }
    ])

    expect(extents.x).toBeLessThan(80)
    expect(extents.y).toBeLessThan(120)
    expect(extents.x + extents.width).toBeGreaterThan(700 + 340)
    expect(extents.y + extents.height).toBeGreaterThan(180 + 320)
  })

  it('节点完全落在遮罩内，且范围不随缩放变化（页面坐标常量）', () => {
    const single = edgeMaskExtents([{ x: 0, y: 0, width: 100, height: 100 }])
    expect(single.x).toBeLessThan(0)
    expect(single.y).toBeLessThan(0)
    expect(single.width).toBeGreaterThan(100)
    expect(single.height).toBeGreaterThan(100)
    // 同一份页面矩形重复计算结果稳定，才允许缩放期间完全不重算 mask。
    expect(edgeMaskExtents([{ x: 0, y: 0, width: 100, height: 100 }])).toEqual(single)
  })

  it('空画布返回有限的兜底范围，不产生 NaN 或 Infinite 的 SVG 属性', () => {
    const empty = edgeMaskExtents([])
    for (const value of Object.values(empty)) {
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(empty.width).toBeGreaterThan(0)
    expect(empty.height).toBeGreaterThan(0)
  })
})
