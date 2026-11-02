import { Box, type Editor } from 'tldraw'

/** Fit the current page's nodes into the unobscured viewport without moving them. */
export function focusCanvas(editor: Editor): void {
  const bounds = editor.getCurrentPageShapes().flatMap((shape) => {
    if (shape.type !== 'node-card') return []
    const box = editor.getShapePageBounds(shape.id)
    return box ? [box] : []
  })
  if (!bounds.length) {
    editor.centerOnPoint({ x: 0, y: 0 }, { animation: { duration: 300 } })
    return
  }

  const viewport = editor.getViewportScreenBounds()
  const palette = editor.getContainer().ownerDocument.querySelector('.node-palette')
  const paletteWidth = palette ? palette.getBoundingClientRect().right - viewport.x : 0
  const box = Box.Common(bounds)
  const left = Math.max(32, paletteWidth + 32)
  const top = 48
  const width = Math.max(1, viewport.w - left - 32)
  const height = Math.max(1, viewport.h - top - 88)
  const zoom = Math.min(1, width / Math.max(1, box.w), height / Math.max(1, box.h))
  editor.setCamera(
    {
      x: (left + width / 2) / zoom - box.center.x,
      y: (top + height / 2) / zoom - box.center.y,
      z: zoom
    },
    { animation: { duration: 300 } }
  )
}
