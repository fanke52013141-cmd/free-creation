import { computed, type Editor, type TLShape, type Computed } from 'tldraw'

interface NodePageIndex {
  signature: string
  sequence: Map<string, number>
  arrows: Map<string, TLShape[]>
  artifacts: Map<string, TLShape[]>
}

const indexes = new WeakMap<Editor, Computed<NodePageIndex>>()

/** One tracked page scan per editor revision, shared by every node card. */
export function nodePageIndex(editor: Editor): NodePageIndex {
  let index = indexes.get(editor)
  if (!index) {
    index = computed(
      'node page relation index',
      () => {
        const sequence = new Map<string, number>()
        const arrows = new Map<string, TLShape[]>()
        const artifacts = new Map<string, TLShape[]>()
        const shapes = editor.getCurrentPageShapes()
        const append = (map: Map<string, TLShape[]>, id: string, shape: TLShape): void => {
          const list = map.get(id) ?? []
          list.push(shape)
          map.set(id, list)
        }
        shapes
          .filter((shape) => shape.type === 'node-card')
          .sort((a, b) => a.index.localeCompare(b.index))
          .forEach((shape, index) => sequence.set(shape.id, index + 1))
        for (const shape of shapes) {
          if (shape.type === 'arrow') {
            const endpoints = new Set(
              editor.getBindingsFromShape(shape.id, 'arrow').map((binding) => binding.toId)
            )
            for (const id of endpoints) append(arrows, id, shape)
          } else if (
            shape.type === 'node-card' &&
            typeof shape.meta.artifactProducerId === 'string'
          ) {
            append(artifacts, shape.meta.artifactProducerId, shape)
          }
        }
        const signature = JSON.stringify([
          [...sequence],
          [...arrows].map(([id, items]) => [
            id,
            items.map((item) => [item.id, item.meta.fromPort, item.meta.toPort])
          ]),
          [...artifacts].map(([id, items]) => [
            id,
            items.map((item) => [item.id, item.meta.artifactProducerPortId])
          ])
        ])
        return { sequence, arrows, artifacts, signature }
      },
      { isEqual: (a: NodePageIndex, b: NodePageIndex) => a.signature === b.signature }
    )
    indexes.set(editor, index)
  }
  return index.get()
}
