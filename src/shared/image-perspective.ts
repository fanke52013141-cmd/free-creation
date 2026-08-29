import type { NormalizedPoint } from './image-crop'

/** 求解 destination -> source 的 8 参数单应矩阵，最后一个参数固定为 1。 */
export function solveHomography(
  from: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint],
  to: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint]
): number[] {
  const augmented: number[][] = []
  for (let index = 0; index < 4; index += 1) {
    const { x: u, y: v } = from[index]
    const { x, y } = to[index]
    augmented.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x])
    augmented.push([0, 0, 0, u, v, 1, -u * y, -v * y, y])
  }
  for (let column = 0; column < 8; column += 1) {
    let pivot = column
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) throw new Error('四角区域无法计算透视变换')
    ;[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]
    const divisor = augmented[column][column]
    for (let current = column; current <= 8; current += 1) augmented[column][current] /= divisor
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue
      const factor = augmented[row][column]
      for (let current = column; current <= 8; current += 1) {
        augmented[row][current] -= factor * augmented[column][current]
      }
    }
  }
  return augmented.map((row) => row[8])
}

export function transformPoint(matrix: readonly number[], x: number, y: number): NormalizedPoint {
  const denominator = matrix[6] * x + matrix[7] * y + 1
  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator
  }
}

export function sampleBilinear(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  target: Uint8ClampedArray,
  targetOffset: number
): void {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const offsets = [
    (y0 * width + x0) * 4,
    (y0 * width + x1) * 4,
    (y1 * width + x0) * 4,
    (y1 * width + x1) * 4
  ]
  for (let channel = 0; channel < 4; channel += 1) {
    const top = source[offsets[0] + channel] * (1 - tx) + source[offsets[1] + channel] * tx
    const bottom = source[offsets[2] + channel] * (1 - tx) + source[offsets[3] + channel] * tx
    target[targetOffset + channel] = Math.round(top * (1 - ty) + bottom * ty)
  }
}
