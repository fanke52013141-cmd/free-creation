// @vitest-environment jsdom
import { atom, type Editor, type TLShape } from 'tldraw'
import { expect, it } from 'vitest'
import { nodePageIndex } from '@renderer/canvas/node-page-index'
it('ignores unrelated text edits but invalidates on binding, order and port changes', () => {
  const shapes = atom('index test shapes', [
    { id: 'shape:a', type: 'node-card', index: 'a1', props: { text: 'a' }, meta: {} },
    { id: 'shape:b', type: 'node-card', index: 'a2', props: { text: 'b' }, meta: {} },
    {
      id: 'shape:edge',
      type: 'arrow',
      index: 'a3',
      meta: { fromPort: 'out-text', toPort: 'in-value' }
    }
  ] as unknown as TLShape[])
  const endpoint = atom('index test endpoint', 'shape:b')
  const editor = {
    getCurrentPageShapes: () => shapes.get(),
    getBindingsFromShape: () => [{ toId: 'shape:a' }, { toId: endpoint.get() }]
  } as unknown as Editor
  const first = nodePageIndex(editor)
  shapes.set(
    shapes
      .get()
      .map((shape) =>
        shape.id === 'shape:a'
          ? ({ ...shape, props: { ...shape.props, text: 'changed' } } as TLShape)
          : shape
      )
  )
  expect(nodePageIndex(editor)).toBe(first)
  endpoint.set('shape:c')
  expect(nodePageIndex(editor).arrows.has('shape:b')).toBe(false)
  expect(nodePageIndex(editor).arrows.has('shape:c')).toBe(true)
  shapes.set(
    shapes
      .get()
      .map((shape) => (shape.id === 'shape:a' ? ({ ...shape, index: 'a4' } as TLShape) : shape))
  )
  expect(nodePageIndex(editor).sequence.get('shape:a')).toBe(2)
})
