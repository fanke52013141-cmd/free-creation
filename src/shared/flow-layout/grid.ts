import type { LayoutNode } from './types'

/**
 * 网格兜底布局：与 CanvasMinimap.organizeCanvas 原算法逐行同口径
 * （按中心 y±80 容差再 x 排序、ceil(sqrt(n)) 列、真实列宽/行高、GAP_X=60/GAP_Y=80、
 * 起点为排序后第一个节点位置）。用于无连线的素材堆画布。
 */
export function gridLayout(nodes: readonly LayoutNode[]): Array<{ id: string; x: number; y: number }> {
  if (nodes.length === 0) return []
  const sorted = [...nodes].sort((a, b) => {
    const ay = a.y + a.h / 2
    const by = b.y + b.h / 2
    if (Math.abs(ay - by) < 80) return a.x - b.x
    return ay - by
  })

  const GAP_X = 60
  const GAP_Y = 80
  const COLS = Math.max(1, Math.ceil(Math.sqrt(sorted.length)))
  const startX = sorted[0]!.x
  const startY = sorted[0]!.y

  const colWidths = Array.from({ length: COLS }, (_, col) =>
    Math.max(...sorted.filter((_, i) => i % COLS === col).map((s) => s.w))
  )
  const rowCount = Math.ceil(sorted.length / COLS)
  const rowHeights = Array.from({ length: rowCount }, (_, row) =>
    Math.max(...sorted.slice(row * COLS, (row + 1) * COLS).map((s) => s.h))
  )
  const colOffsets = colWidths.map((_, col) =>
    colWidths.slice(0, col).reduce((sum, width) => sum + width + GAP_X, 0)
  )
  const rowOffsets = rowHeights.map((_, row) =>
    rowHeights.slice(0, row).reduce((sum, height) => sum + height + GAP_Y, 0)
  )

  return sorted.map((s, index) => {
    const col = index % COLS
    const row = Math.floor(index / COLS)
    return { id: s.id, x: startX + (colOffsets[col] ?? 0), y: startY + (rowOffsets[row] ?? 0) }
  })
}