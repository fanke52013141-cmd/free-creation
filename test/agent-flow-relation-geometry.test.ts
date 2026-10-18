import { describe, expect, it } from 'vitest'
import {
  buildControlRelationGeometry,
  type RelationRect
} from '../src/renderer/src/canvas/agent-flow-relation-geometry'

const CARD = { w: 340, h: 260 }

function card(x: number, y: number): RelationRect {
  return { x, y, ...CARD }
}

function numbers(path: string): number[] {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

function samplePath(path: string, steps = 40): { x: number; y: number }[] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = numbers(path)
  const points: { x: number; y: number }[] = []
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps
    const mt = 1 - t
    points.push({
      x: mt ** 3 * x0 + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3,
      y: mt ** 3 * y0 + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3
    })
  }
  return points
}

function onBounds(point: { x: number; y: number }, rect: RelationRect): boolean {
  const eps = 0.5
  return (
    (Math.abs(point.x - rect.x) < eps &&
      point.y >= rect.y - eps &&
      point.y <= rect.y + rect.h + eps) ||
    (Math.abs(point.x - (rect.x + rect.w)) < eps &&
      point.y >= rect.y - eps &&
      point.y <= rect.y + rect.h + eps) ||
    (Math.abs(point.y - rect.y) < eps &&
      point.x >= rect.x - eps &&
      point.x <= rect.x + rect.w + eps) ||
    (Math.abs(point.y - (rect.y + rect.h)) < eps &&
      point.x >= rect.x - eps &&
      point.x <= rect.x + rect.w + eps)
  )
}

function labelBox(geometry: ReturnType<typeof buildControlRelationGeometry>): RelationRect {
  return { x: geometry.labelX - 36, y: geometry.labelY - 11, w: 72, h: 22 }
}

function overlaps(a: RelationRect, b: RelationRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

describe('控制关系连线几何', () => {
  it('横向排列从相对的左右边出入，箭头落在目标左边缘', () => {
    const source = card(100, 100)
    const target = card(760, 100)
    const geometry = buildControlRelationGeometry(source, target)

    expect(geometry.source.side).toBe('right')
    expect(geometry.target.side).toBe('left')
    expect(geometry.source.x).toBe(source.x + source.w)
    expect(geometry.target.x).toBe(target.x)
    expect(geometry.target.y).toBeGreaterThanOrEqual(target.y)
    expect(geometry.target.y).toBeLessThanOrEqual(target.y + target.h)
  })

  it('反向横向排列仍然从相对的左右边出入', () => {
    const source = card(760, 100)
    const target = card(100, 100)
    const geometry = buildControlRelationGeometry(source, target)

    expect(geometry.source.side).toBe('left')
    expect(geometry.target.side).toBe('right')
    expect(geometry.target.x).toBe(target.x + target.w)
  })

  it('纵向排列从上下边出入，箭头落在目标上边缘', () => {
    const source = card(300, 100)
    const target = card(300, 640)
    const geometry = buildControlRelationGeometry(source, target)

    expect(geometry.source.side).toBe('bottom')
    expect(geometry.target.side).toBe('top')
    expect(geometry.target.y).toBe(target.y)
    expect(geometry.target.x).toBeGreaterThanOrEqual(target.x)
    expect(geometry.target.x).toBeLessThanOrEqual(target.x + target.w)
  })

  it('目标在上方时从上方出、下方入', () => {
    const source = card(300, 640)
    const target = card(300, 100)
    const geometry = buildControlRelationGeometry(source, target)

    expect(geometry.source.side).toBe('top')
    expect(geometry.target.side).toBe('bottom')
    expect(geometry.target.y).toBe(target.y + target.h)
  })

  it('斜向布局取较短边，不再默认接顶部', () => {
    const source = card(100, 100)
    const target = card(760, 640)
    const geometry = buildControlRelationGeometry(source, target)

    expect(geometry.source.side).not.toBe('top')
    expect(geometry.target.side).not.toBe('top')
    expect(geometry.target.side === 'left' || geometry.target.side === 'top').toBe(true)
    expect(onBounds({ x: geometry.target.x, y: geometry.target.y }, target)).toBe(true)
  })

  it('45° 斜向布局不因浮点误差退回顶部锚点', () => {
    const source = card(100, 100)
    const target = card(760, 760)
    const geometry = buildControlRelationGeometry(source, target)

    expect(geometry.source.side).toBe('right')
    expect(geometry.target.side).toBe('left')
  })

  it('近邻与重叠布局仍把箭头放在目标外边缘，标签不压卡片', () => {
    const source = card(100, 100)
    const target = card(260, 180)
    const geometry = buildControlRelationGeometry(source, target, [source, target])

    expect(onBounds({ x: geometry.target.x, y: geometry.target.y }, target)).toBe(true)
    expect(overlaps(labelBox(geometry), source)).toBe(false)
    expect(overlaps(labelBox(geometry), target)).toBe(false)
  })

  it('中间有阻挡卡片时选择不穿过卡片的路径', () => {
    const source = card(0, 100)
    const target = card(900, 100)
    const obstacle = { x: 420, y: 0, w: 180, h: 520 }
    const geometry = buildControlRelationGeometry(source, target, [source, obstacle, target])

    const points = samplePath(geometry.path)
    expect(
      points.some(
        (point) =>
          point.x > obstacle.x + 2 &&
          point.x < obstacle.x + obstacle.w - 2 &&
          point.y > obstacle.y + 2 &&
          point.y < obstacle.y + obstacle.h - 2
      )
    ).toBe(false)
    expect(onBounds({ x: geometry.target.x, y: geometry.target.y }, target)).toBe(true)
  })

  it('标签避开阻挡卡片', () => {
    const source = card(0, 100)
    const target = card(900, 100)
    const obstacle = { x: 480, y: 40, w: 120, h: 160 }
    const geometry = buildControlRelationGeometry(source, target, [source, obstacle, target])
    const box = labelBox(geometry)

    expect(overlaps(box, obstacle)).toBe(false)
    expect(overlaps(box, source)).toBe(false)
    expect(overlaps(box, target)).toBe(false)
  })

  it('移动与缩放页面坐标时锚点和标签等比缩放', () => {
    const source = card(100, 100)
    const target = card(760, 640)
    const original = buildControlRelationGeometry(source, target, [source, target])
    const double = (rect: RelationRect): RelationRect => ({
      x: rect.x * 2,
      y: rect.y * 2,
      w: rect.w * 2,
      h: rect.h * 2
    })
    const scaled = buildControlRelationGeometry(double(source), double(target), [
      double(source),
      double(target)
    ])

    expect(scaled.source.x).toBeCloseTo(original.source.x * 2)
    expect(scaled.source.y).toBeCloseTo(original.source.y * 2)
    expect(scaled.target.x).toBeCloseTo(original.target.x * 2)
    expect(scaled.target.y).toBeCloseTo(original.target.y * 2)
    const originalNumbers = numbers(original.path)
    const scaledNumbers = numbers(scaled.path)
    expect(scaledNumbers).toHaveLength(originalNumbers.length)
    for (let index = 0; index < originalNumbers.length; index += 1) {
      expect(scaledNumbers[index]).toBeCloseTo(originalNumbers[index] * 2, 1)
    }
  })

  it('箭头终点位于目标卡片外边缘且不进入卡片内部', () => {
    for (const [dx, dy] of [
      [420, 0],
      [-420, 0],
      [0, 360],
      [0, -360],
      [420, 360],
      [-420, -360]
    ]) {
      const source = card(500, 500)
      const target = card(500 + dx, 500 + dy)
      const geometry = buildControlRelationGeometry(source, target, [source, target])
      expect(onBounds({ x: geometry.target.x, y: geometry.target.y }, target)).toBe(true)
      const [lastX, lastY] = numbers(geometry.path).slice(-2)
      expect(lastX).toBeCloseTo(geometry.target.x)
      expect(lastY).toBeCloseTo(geometry.target.y)
    }
  })
})
