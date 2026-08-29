import { describe, expect, it } from 'vitest'
import { sampleBilinear, solveHomography, transformPoint } from '@shared/image-perspective'

describe('四角透视变换', () => {
  const corners = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 50 },
    { x: 100, y: 50 }
  ] as const

  it('将目标矩形的四个角准确映射到指定源四边形', () => {
    const target = [
      { x: 10, y: 20 },
      { x: 90, y: 10 },
      { x: 15, y: 80 },
      { x: 85, y: 90 }
    ] as const
    const matrix = solveHomography([...corners], [...target])
    for (let index = 0; index < corners.length; index += 1) {
      const actual = transformPoint(matrix, corners[index].x, corners[index].y)
      expect(actual.x).toBeCloseTo(target[index].x, 6)
      expect(actual.y).toBeCloseTo(target[index].y, 6)
    }
  })

  it('以双线性方式采样四个源像素', () => {
    const source = new Uint8ClampedArray([
      0, 0, 0, 255, 100, 0, 0, 255, 0, 100, 0, 255, 100, 100, 0, 255
    ])
    const result = new Uint8ClampedArray(4)
    sampleBilinear(source, 2, 2, 0.5, 0.5, result, 0)
    expect([...result]).toEqual([50, 50, 0, 255])
  })
})
