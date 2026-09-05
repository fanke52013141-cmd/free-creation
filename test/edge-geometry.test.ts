import { describe, expect, it } from 'vitest'
import { buildDataEdgePath } from '../src/renderer/src/canvas/edge-geometry'

function values(path: string): number[] {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

describe('数据连线几何', () => {
  it('反向连线的控制点始终位于两个端点之间，不会形成横向外翻', () => {
    const path = buildDataEdgePath({ x: 620, y: 180 }, { x: 420, y: 260 })
    const [, , control1X, , control2X] = values(path)

    expect(control1X).toBeGreaterThan(420)
    expect(control1X).toBeLessThan(620)
    expect(control2X).toBeGreaterThan(420)
    expect(control2X).toBeLessThan(620)
  })

  it('等比例缩放页面坐标时，曲线控制点同样等比例缩放', () => {
    const original = values(buildDataEdgePath({ x: 100, y: 50 }, { x: 400, y: 170 }))
    const doubled = values(buildDataEdgePath({ x: 200, y: 100 }, { x: 800, y: 340 }))

    expect(doubled).toHaveLength(original.length)
    for (let index = 0; index < original.length; index += 1) {
      expect(doubled[index]).toBeCloseTo(original[index] * 2)
    }
  })
})
