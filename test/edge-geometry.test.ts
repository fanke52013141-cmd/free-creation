import { describe, expect, it } from 'vitest'
import { buildDataEdgePath, isBackwardEdge } from '../src/renderer/src/canvas/edge-geometry'

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

describe('L3 反向边外弧路由', () => {
  it('不传 backward 时前向/反向公式与旧行为逐字节一致', () => {
    expect(buildDataEdgePath({ x: 100, y: 50 }, { x: 400, y: 170 })).toBe(
      buildDataEdgePath({ x: 100, y: 50 }, { x: 400, y: 170 }, { backward: false })
    )
    expect(buildDataEdgePath({ x: 620, y: 180 }, { x: 420, y: 260 })).toBe(
      buildDataEdgePath({ x: 620, y: 180 }, { x: 420, y: 260 }, {})
    )
  })

  it('backward 外弧：控制点在两端点上方，弧线不穿过中间区域', () => {
    const start = { x: 1200, y: 400 }
    const end = { x: 300, y: 400 }
    const path = buildDataEdgePath(start, end, { backward: true })
    const [, , c1x, c1y, c2x, c2y] = values(path)
    // 控制柄垂直：x 与端点对齐，y 在端点上方。
    expect(c1x).toBe(start.x)
    expect(c2x).toBe(end.x)
    expect(c1y).toBeLessThan(Math.min(start.y, end.y))
    expect(c2y).toBeLessThan(Math.min(start.y, end.y))
    expect(c1y).toBe(c2y)
  })

  it('backward 弧顶与跨度成比例（等比约定，与前向边一致）', () => {
    const near = values(buildDataEdgePath({ x: 500, y: 300 }, { x: 300, y: 300 }, { backward: true }))
    const far = values(buildDataEdgePath({ x: 900, y: 300 }, { x: 300, y: 300 }, { backward: true }))
    expect(300 - near[3]).toBeCloseTo(200 * 0.25)
    expect(300 - far[3]).toBeCloseTo(600 * 0.25)
  })

  it('backward 路径等比缩放保持形状', () => {
    const original = values(buildDataEdgePath({ x: 600, y: 200 }, { x: 200, y: 260 }, { backward: true }))
    const doubled = values(buildDataEdgePath({ x: 1200, y: 400 }, { x: 400, y: 520 }, { backward: true }))
    for (let index = 0; index < original.length; index += 1)
      expect(doubled[index]).toBeCloseTo(original[index] * 2)
  })

  it('isBackwardEdge：源中心在目标右侧或重合为反向', () => {
    expect(isBackwardEdge(500, 300)).toBe(true)
    expect(isBackwardEdge(300, 300)).toBe(true)
    expect(isBackwardEdge(300, 500)).toBe(false)
  })
})
