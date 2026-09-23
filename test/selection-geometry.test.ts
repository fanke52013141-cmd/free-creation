import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SELECTION_FRAME_OUTSET_PX,
  selectionBoundsUnion,
  selectionGeometryFromPageBounds
} from '../src/renderer/src/canvas/selection-geometry'

const groupOutlineSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/GroupOutlineLayer.tsx'),
  'utf8'
)
const surfaceSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/ui-surfaces.css'),
  'utf8'
)
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/assets/app.css'), 'utf8')
const geometrySource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/selection-geometry.ts'),
  'utf8'
)

describe('multi-selection decoration geometry', () => {
  it('merges only selected node bounds and applies a stable 12px screen-space margin', () => {
    expect(SELECTION_FRAME_OUTSET_PX).toBe(12)
    expect(
      selectionBoundsUnion([
        { x: 80, y: 40, maxX: 120, maxY: 90 },
        { x: 10, y: 20, maxX: 60, maxY: 70 }
      ])
    ).toEqual({ x: 10, y: 20, maxX: 120, maxY: 90 })

    const geometry = selectionGeometryFromPageBounds(
      { x: 10, y: 20, maxX: 120, maxY: 90 },
      { left: 5, top: 7 },
      (point) => ({ x: point.x * 2 + 100, y: point.y * 2 + 200 })
    )
    expect(geometry).toEqual({ left: 103, top: 221, width: 244, height: 164 })
    expect(geometrySource).toContain('const topLeft = pageToScreen')
    expect(geometrySource).toContain('const bottomRight = pageToScreen')
    expect(groupOutlineSource).toContain('selectionBoundsForNodes(editor, selectedNodeIds(editor))')
    expect(groupOutlineSource).toContain('selectionBoundsUnion(ids.map((id) => editor.getShapePageBounds(id)))')
    expect(groupOutlineSource).not.toContain('canvas-selection-corner')
  })

  it('rejects empty or malformed bounds instead of retaining an oversized frame', () => {
    expect(selectionBoundsUnion([])).toBeNull()
    expect(
      selectionBoundsUnion([
        null,
        { x: 20, y: 10, maxX: 10, maxY: 30 },
        { x: Number.NaN, y: 0, maxX: 1, maxY: 1 }
      ])
    ).toBeNull()
    expect(
      selectionGeometryFromPageBounds(
        { x: 30, y: 10, maxX: 20, maxY: 40 },
        { left: 0, top: 0 },
        (point) => point
      )
    ).toBeNull()
  })

  it('custom selection frame stays visible without custom resize or rotation points', () => {
    expect(appSource).not.toContain('.canvas-selection-corner')
    expect(surfaceSource).not.toMatch(/\.tl-selection__bg\s*\{[^}]*display:\s*none/)
    expect(appSource).toContain('.tl-selection__bg:not(:has(.canvas-selection-underlay))')
    expect(appSource).toContain('.tl-corner-handle')
    expect(appSource).toContain('display: none !important;')
    expect(surfaceSource).not.toMatch(
      /selection\.resize\.(top-left|top-right|bottom-right|bottom-left)[\s\S]{0,160}transform:/
    )
  })
})
