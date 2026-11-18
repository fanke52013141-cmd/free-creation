// 结果折叠功能已移除（2026-10-05 用户要求）：本轮产物始终全部可见。
// 门禁保证：旧快照遗留的 resultGroupCollapsed 标记不再隐藏任何节点，且不影响图拓扑。
// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest'
import type { Editor, TLShape } from 'tldraw'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { deriveGraph } from '@renderer/canvas/graph'
import {
  artifactShapeHidden,
  artifactShapeVisibility,
  showArtifactGroups
} from '@renderer/canvas/artifact-grouping'
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

// 循环体模板「展开失灵」回归门禁（2026-11-19）：折叠态成员卡收拢在紧凑卡上方，
// 必须对 tldraw 命中测试返回 hidden，否则画布点击命中的是隐藏成员，「展开」按钮永远点不到。
it('折叠态循环体成员对命中测试隐身；展开态与普通节点不受影响', () => {
  const loopId = 'shape:loop1'
  const templateCardId = 'shape:tpl1'
  const templateCard = {
    id: templateCardId,
    type: 'node-card',
    props: { nodeType: 'text' },
    meta: { iterationTemplateCard: loopId, iterationTemplateExpanded: false }
  }
  const collapsedMember = {
    id: 'shape:member1',
    type: 'node-card',
    props: { nodeType: 'ai-process' },
    meta: { iterationTemplateMember: true, iterationTemplateLoopId: loopId }
  }
  const expandedMember = {
    ...collapsedMember,
    id: 'shape:member2'
  }
  const plainNode = { id: 'shape:plain', type: 'node-card', props: { nodeType: 'text' }, meta: {} }
  const shapes = [templateCard, collapsedMember, expandedMember, plainNode]
  const editor = {
    getCurrentPageShapes: () => shapes,
    getShape: (id: string) => shapes.find((s) => s.id === id)
  } as unknown as Editor
  // 折叠态：成员隐身（不参与 getShapeAtPoint 命中），框卡与普通节点不受影响
  expect(artifactShapeVisibility(collapsedMember as unknown as TLShape, editor)).toBe('hidden')
  expect(artifactShapeVisibility(templateCard as unknown as TLShape, editor)).toBe('inherit')
  expect(artifactShapeVisibility(plainNode as unknown as TLShape, editor)).toBe('inherit')
  // 展开态：成员恢复可见可命中
  templateCard.meta.iterationTemplateExpanded = true
  expect(artifactShapeVisibility(collapsedMember as unknown as TLShape, editor)).toBe('inherit')
  // 非节点形状、无主孤儿成员不受影响
  const orphan = {
    ...collapsedMember,
    id: 'shape:member3',
    meta: { iterationTemplateMember: true, iterationTemplateLoopId: 'shape:ghost' }
  }
  shapes.push(orphan)
  expect(artifactShapeVisibility(orphan as unknown as TLShape, editor)).toBe('inherit')
  expect(artifactShapeVisibility({ id: 'shape:arrow', type: 'arrow' } as unknown as TLShape, editor)).toBe(
    'inherit'
  )
})
