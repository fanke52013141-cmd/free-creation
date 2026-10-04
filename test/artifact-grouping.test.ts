// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest'
import type { Editor, TLShape } from 'tldraw'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { deriveGraph } from '@renderer/canvas/graph'
import { artifactShapeHidden, showArtifactGroups } from '@renderer/canvas/artifact-grouping'
beforeAll(registerAllNodeTypes)
it('visibility metadata does not affect graph inputs or topology and can be undone as one edit', () => {
  const shapes = ['a', 'b'].map((run, index) => ({
    id: `shape:${run}`,
    type: 'node-card',
    index: `a${index + 1}`,
    x: index * 420,
    y: 0,
    props: {
      nodeType: 'text',
      title: run,
      w: 340,
      h: 260,
      text: run,
      config: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: { runGroupId: run }
  })) as unknown as TLShape[]
  let backup: TLShape[] = []
  const editor = {
    getCurrentPageShapes: () => shapes,
    getShape: (id: string) => shapes.find((s) => s.id === id),
    markHistoryStoppingPoint: () => {
      backup = structuredClone(shapes)
    },
    run: (fn: () => void) => fn(),
    updateShape: (change: TLShape) => {
      const shape = shapes.find((s) => s.id === change.id)!
      shape.meta = { ...shape.meta, ...change.meta }
    }
  } as unknown as Editor
  const topology = (): unknown => {
    const g = deriveGraph(editor)
    return { nodes: g.nodes.map(({ meta, ...n }) => n), edges: g.edges }
  }
  const before = topology()
  showArtifactGroups(editor, 'a')
  expect(artifactShapeHidden(shapes[0])).toBe(false)
  expect(artifactShapeHidden(shapes[1])).toBe(true)
  expect(topology()).toEqual(before)
  shapes.splice(0, shapes.length, ...backup)
  expect(shapes.some(artifactShapeHidden)).toBe(false)
})
