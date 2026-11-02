import { describe, expect, it, vi } from 'vitest'
import { Box, type Editor } from 'tldraw'
import { focusCanvas } from '../src/renderer/src/canvas/focus-canvas'

function makeEditor(boxes: Record<string, Box>): Editor {
  return {
    getCurrentPageShapes: () => [
      ...Object.keys(boxes).map((id) => ({ id, type: 'node-card' })),
      { id: 'arrow', type: 'arrow' }
    ],
    getShapePageBounds: (id: string) => boxes[id],
    getViewportScreenBounds: () => ({ x: 0, w: 1000, h: 800 }),
    getContainer: () => ({ ownerDocument: { querySelector: () => null } }),
    setCamera: vi.fn(),
    centerOnPoint: vi.fn()
  } as unknown as Editor
}

describe('定位画布内容', () => {
  it('将远处的节点整体适配到视口，不依赖当前相机或选区', () => {
    const editor = makeEditor({
      a: new Box(5000, 3000, 200, 100),
      b: new Box(6000, 3500, 200, 100)
    })
    focusCanvas(editor)
    const [camera] = vi.mocked(editor.setCamera).mock.calls[0]
    expect(camera.z).toBeLessThan(1)
    expect((5000 + camera.x) * camera.z).toBeGreaterThan(31.99)
    expect((6200 + camera.x) * camera.z).toBeLessThan(968.01)
    expect((3000 + camera.y) * camera.z).toBeGreaterThan(47.99)
    expect((3600 + camera.y) * camera.z).toBeLessThan(712.01)
  })

  it('单节点不会被过度放大；空画布返回原点', () => {
    const one = makeEditor({ a: new Box(-500, -300, 200, 100) })
    focusCanvas(one)
    expect(vi.mocked(one.setCamera).mock.calls[0][0].z).toBe(1)
    const empty = makeEditor({})
    focusCanvas(empty)
    expect(empty.centerOnPoint).toHaveBeenCalledWith({ x: 0, y: 0 }, expect.anything())
    expect(empty.setCamera).not.toHaveBeenCalled()
  })
})
