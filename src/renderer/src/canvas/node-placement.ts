export interface NodePlacementBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface ContinuationPlacementOptions {
  source: NodePlacementBounds
  existing: NodePlacementBounds[]
  targetW: number
  targetH: number
  gapX?: number
  gapY?: number
}

const HEADER_OVERHANG = 34
const CARD_GAP = 8

function intersects(a: NodePlacementBounds, b: NodePlacementBounds): boolean {
  const aTop = a.y - HEADER_OVERHANG
  const aBottom = a.y + a.h + CARD_GAP
  const bTop = b.y - HEADER_OVERHANG
  const bBottom = b.y + b.h + CARD_GAP
  return a.x < b.x + b.w && a.x + a.w > b.x && aTop < bBottom && aBottom > bTop
}

/** Places a continuation aligned to its source, scanning down one row at a time if blocked. */
export function findNodeContinuationPlacement({
  source,
  existing,
  targetW,
  targetH,
  gapX = 96,
  gapY = 24
}: ContinuationPlacementOptions): { x: number; y: number } {
  const x = source.x + source.w + gapX
  const rowStep = targetH + gapY + HEADER_OVERHANG + CARD_GAP
  const columnNodes = existing.filter(
    (shape) => x < shape.x + shape.w && x + targetW > shape.x
  )
  const maxOccupiedBottom = columnNodes.reduce(
    (bottom, shape) => Math.max(bottom, shape.y + shape.h + CARD_GAP),
    Number.NEGATIVE_INFINITY
  )
  // A single exceptionally tall card may block many rows. Bound the scan by the
  // deepest node that horizontally overlaps the destination column, not node count.
  const lastPotentialRow = Number.isFinite(maxOccupiedBottom)
    ? Math.max(0, Math.floor((maxOccupiedBottom + HEADER_OVERHANG - source.y) / rowStep) + 1)
    : 0

  for (let row = 0; row <= lastPotentialRow; row += 1) {
    const candidate = { x, y: source.y + row * rowStep, w: targetW, h: targetH }
    if (!existing.some((shape) => intersects(candidate, shape))) {
      return { x: candidate.x, y: candidate.y }
    }
  }

  // Past the deepest possible overlap, this slot is guaranteed to be free.
  return { x, y: source.y + (lastPotentialRow + 1) * rowStep }
}
