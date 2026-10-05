// 结果折叠功能已移除（2026-10-05 用户要求）：本轮产物始终全部可见。
// 门禁保证：旧快照遗留的 resultGroupCollapsed 标记不再隐藏任何节点，且不影响图拓扑。
// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest'
import type { Editor, TLShape } from 'tldraw'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { deriveGraph } from '@renderer/canvas/graph'
import { artifactShapeHidden, showArtifactGroups } from '@renderer/canvas/artifact-grouping'
beforeAll(registerAllNodeTypes)
it('旧折叠标记不再隐藏节点；清理后图拓扑不变，可整体撤销', () => {
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
    meta: { runGroupId: run, resultGroupCollapsed: true }
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
  // 历史折叠标记必须被无视：结果永远可见
  expect(artifactShapeHidden(shapes[0])).toBe(false)
  expect(artifactShapeHidden(shapes[1])).toBe(false)
  expect(topology()).toEqual(before)
  showArtifactGroups(editor)
  expect(shapes.every((shape) => shape.meta.resultGroupCollapsed !== true)).toBe(true)
  shapes.splice(0, shapes.length, ...backup)
  expect(shapes.every((shape) => shape.meta.resultGroupCollapsed === true)).toBe(true)
})
