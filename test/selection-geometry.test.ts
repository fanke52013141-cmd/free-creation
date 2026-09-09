import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const groupOutlineSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/GroupOutlineLayer.tsx'),
  'utf8'
)
const surfaceSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/ui-surfaces.css'),
  'utf8'
)

describe('multi-selection decoration geometry', () => {
  it('uses one page-to-screen conversion for the dashed frame and every visual corner', () => {
    expect(groupOutlineSource).toContain('function selectionGeometryFromPageBounds')
    expect(groupOutlineSource).toContain('const topLeft = pageToScreen')
    expect(groupOutlineSource).toContain('const bottomRight = pageToScreen')
    expect(groupOutlineSource).toContain('topLeft: { x: left - SELECTION_CORNER_OUTSET_PX')
    expect(groupOutlineSource).toContain('bottomRight: {')
    expect(groupOutlineSource).toContain('x: left + width + SELECTION_CORNER_OUTSET_PX')
    expect(groupOutlineSource).toContain('className="canvas-selection-corner"')
  })

  it('does not offset tldraw handles and keeps their native resize target intact', () => {
    expect(surfaceSource).toContain('.tl-corner-handle')
    expect(surfaceSource).toContain('opacity: 0 !important;')
    expect(surfaceSource).not.toMatch(
      /selection\.resize\.(top-left|top-right|bottom-right|bottom-left)[\s\S]{0,160}transform:/
    )
    expect(surfaceSource).toContain('.canvas-selection-corner')
    expect(surfaceSource).toContain('pointer-events: none;')
  })
})
