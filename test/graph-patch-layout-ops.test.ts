// F2 画布编辑 op 的规划器测试：node.duplicate / layout.align / group.create / group.delete。
//
// 断言重点：
// 1) 复制只带结构（配置/正文/素材引用/尺寸），**不带运行结果与运行状态**（meta 清空、exec=idle）；
// 2) 对齐/均分与 GUI 多选工具栏同一算法（左/右/水平居中/垂直居中/水平均分/垂直均分）；
// 3) 组合/解组走 tldraw 原生 groupShapes/ungroupShapes，且对非 group 解组要提前拒绝；
// 4) 全部 op 在规划阶段就完成引用与存在性校验（不留半应用）。
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import type { Editor, TLShapeId } from 'tldraw'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { planGraphPatch } from '@renderer/canvas/graph-patch'

beforeAll(() => {
  registerAllNodeTypes()
})

interface MockShape {
  id: string
  type: string
  x: number
  y: number
  index: string
  meta?: Record<string, unknown>
  props: Record<string, unknown>
}

function card(id: string, x = 0, y = 0, extra: Record<string, unknown> = {}): MockShape {
  return {
    id: `shape:${id}`,
    type: 'node-card',
    x,
    y,
    index: 'a1',
    meta: { nodeRun: { status: 'success' }, nodeResult: '{"stale":true}' },
    props: {
      w: 340,
      h: 260,
      nodeType: 'text',
      title: `节点${id}`,
      config: '{"k":1}',
      text: `正文${id}`,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'success',
      ...extra
    }
  }
}

function groupShape(id: string, childIds: string[]): MockShape {
  return {
    id: `shape:${id}`,
    type: 'group',
    x: 0,
    y: 0,
    index: 'a1',
    props: { w: 100, h: 100 },
    meta: { childIds }
  }
}

function mockEditor(shapes: MockShape[]) {
  const created: any[] = []
  const updated: any[] = []
  const grouped: string[][] = []
  const ungrouped: string[][] = []
  let groupSeq = 0
  const editor = {
    getCurrentPageShapes: () => shapes,
    getBindingsFromShape: () => [],
    getShape: (shapeId: TLShapeId) => shapes.find((s) => s.id === String(shapeId)),
    createShape: (input: any) => {
      created.push(input)
      shapes.push(input as MockShape)
    },
    updateShape: (input: any) => {
      updated.push(input)
      const target = shapes.find((s) => s.id === String(input.id))
      if (target && typeof input.x === 'number') target.x = input.x
      if (target && typeof input.y === 'number') target.y = input.y
    },
    deleteShapes: () => undefined,
    bringToFront: () => undefined,
    sendToBack: () => undefined,
    markHistoryStoppingPoint: () => undefined,
    groupShapes: (ids: TLShapeId[]) => {
      grouped.push(ids.map(String))
      groupSeq += 1
      const group = groupShape(`group${groupSeq}`, ids.map(String))
      shapes.push(group)
      return [group]
    },
    ungroupShapes: (ids: TLShapeId[]) => {
      ungrouped.push(ids.map(String))
    },
    run: (fn: () => void) => fn()
  }
  return { editor: editor as unknown as Editor, created, updated, grouped, ungrouped }
}

const bounds = (updated: any[], id: string) => updated.filter((entry) => String(entry.id) === `shape:${id}`)

describe('node.duplicate', () => {
  it('复制结构与位置偏移，但不带运行结果与运行状态', () => {
    const { editor, created } = mockEditor([card('a', 100, 200)])
    const planned = planGraphPatch(
      editor,
      [{ action: 'node.duplicate', nodeId: 'shape:a', ref: 'copy' }],
      []
    )
    expect(planned.ok, planned.ok ? '' : JSON.stringify(planned.issue)).toBe(true)
    if (!planned.ok) return
    planned.plan.apply(editor)
    expect(created).toHaveLength(1)
    const made = created[0]
    expect(made.props.nodeType).toBe('text')
    expect(made.props.config).toBe('{"k":1}')
    expect(made.props.text).toBe('正文a')
    // 默认偏移
    expect(made.x).toBe(140)
    expect(made.y).toBe(240)
    // 关键：复制体不允许"看起来已经跑过"
    expect(made.props.exec).toBe('idle')
    expect(made.meta).toEqual({})
    // ref 映射到新节点
    expect(planned.plan.created).toHaveLength(1)
    expect(planned.plan.created[0].ref).toBe('copy')
    expect(planned.plan.created[0].nodeId).toBe(made.id)
  })

  it('自定义偏移与标题；源节点不存在时整批拒绝', () => {
    const { editor, created } = mockEditor([card('a', 0, 0)])
    const planned = planGraphPatch(
      editor,
      [{ action: 'node.duplicate', nodeId: 'shape:a', dx: 500, dy: -100, title: '副本' }],
      []
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    planned.plan.apply(editor)
    expect(created[0].x).toBe(500)
    expect(created[0].y).toBe(-100)
    expect(created[0].props.title).toBe('副本')

    const ghost = planGraphPatch(editor, [{ action: 'node.duplicate', nodeId: 'shape:ghost' }], [])
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.issue.code).toBe('NODE_NOT_FOUND')
  })
})

describe('layout.align', () => {
  const seed = () => [card('a', 0, 0), card('b', 200, 100, { w: 100, h: 50 })]

  it('left / right：按包围盒对齐 x', () => {
    const left = mockEditor(seed())
    const l = planGraphPatch(
      left.editor,
      [{ action: 'layout.align', mode: 'left', nodeIds: ['shape:a', 'shape:b'] }],
      []
    )
    expect(l.ok).toBe(true)
    if (!l.ok) return
    l.plan.apply(left.editor)
    expect(bounds(left.updated, 'a')[0].x).toBe(0)
    expect(bounds(left.updated, 'b')[0].x).toBe(0)

    const right = mockEditor(seed())
    const r = planGraphPatch(
      right.editor,
      [{ action: 'layout.align', mode: 'right', nodeIds: ['shape:a', 'shape:b'] }],
      []
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    r.plan.apply(right.editor)
    // 右边界 = max(x+w) = 340（a 宽 340）；b 宽 100 → x = 240
    expect(bounds(right.updated, 'a')[0].x).toBe(0)
    expect(bounds(right.updated, 'b')[0].x).toBe(240)
  })

  it('center-h / center-v：按包围盒中心对齐', () => {
    const editorState = mockEditor(seed())
    const planned = planGraphPatch(
      editorState.editor,
      [
        { action: 'layout.align', mode: 'center-h', nodeIds: ['shape:a', 'shape:b'] },
        { action: 'layout.align', mode: 'center-v', nodeIds: ['shape:a', 'shape:b'] }
      ],
      []
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    planned.plan.apply(editorState.editor)
    // 同一节点可能收到多条 update（先水平后垂直），按"最后一次"取最终值。
    const finalOf = (id: string) => {
      const entries = bounds(editorState.updated, id)
      return { x: entries.filter((e) => typeof e.x === 'number').at(-1)?.x, y: entries.filter((e) => typeof e.y === 'number').at(-1)?.y }
    }
    // 中心 x = (0 + max(340, 300)) / 2 = 170；b 宽 100 → x = 120
    expect(finalOf('b').x).toBe(120)
    // 中心 y = (0 + max(260, 150)) / 2 = 130；b 高 50 → y = 105
    expect(finalOf('b').y).toBe(105)
  })

  it('distribute-h：按 x 排序等间距', () => {
    const editorState = mockEditor([
      card('a', 0, 0, { w: 100 }),
      card('b', 500, 0, { w: 100 }),
      card('c', 900, 0, { w: 100 })
    ])
    const planned = planGraphPatch(
      editorState.editor,
      [{ action: 'layout.align', mode: 'distribute-h', nodeIds: ['shape:a', 'shape:b', 'shape:c'] }],
      []
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    planned.plan.apply(editorState.editor)
    // 包围盒 0..1000，总宽 300 → gap = (1000-300)/2 = 350
    expect(bounds(editorState.updated, 'a')[0].x).toBe(0)
    expect(bounds(editorState.updated, 'b')[0].x).toBe(450)
    expect(bounds(editorState.updated, 'c')[0].x).toBe(900)
  })

  it('少于两个节点被 Schema 拒绝；重复 ID 在规划阶段拒绝', () => {
    const editorState = mockEditor(seed())
    const one = planGraphPatch(
      editorState.editor,
      [{ action: 'layout.align', mode: 'left', nodeIds: ['shape:a'] }],
      []
    )
    expect(one.ok).toBe(false)

    const duplicated = planGraphPatch(
      editorState.editor,
      [{ action: 'layout.align', mode: 'left', nodeIds: ['shape:a', 'shape:a'] }],
      []
    )
    expect(duplicated.ok).toBe(false)
    if (!duplicated.ok) expect(duplicated.issue.code).toBe('DUPLICATE_NODE')
  })
})

describe('node.select-result 结果版本切换', () => {
  const collection = JSON.stringify({
    kind: 'media-source',
    version: 1,
    at: 1,
    selectedMediaId: 'media-a',
    results: [
      { mediaId: 'media-a', mediaPath: 'projects/p/media/a.png', mime: 'image/png', createdAt: 1 },
      { mediaId: 'media-b', mediaPath: 'projects/p/media/b.png', mime: 'image/png', createdAt: 2 }
    ]
  })

  function imageCard(): MockShape {
    return {
      ...card('img', 0, 0),
      props: {
        w: 340,
        h: 260,
        nodeType: 'image',
        title: '图片节点',
        config: '{}',
        text: '',
        mediaId: 'media-a',
        mediaPath: 'projects/p/media/a.png',
        mediaMime: 'image/png',
        exec: 'success'
      },
      meta: { nodeResult: collection }
    }
  }

  it('切到集合内的另一条结果：同时更新 props 与 nodeResult.selectedMediaId', () => {
    const { editor, updated } = mockEditor([imageCard()])
    const planned = planGraphPatch(
      editor,
      [{ action: 'node.select-result', nodeId: 'shape:img', mediaId: 'media-b' }],
      []
    )
    expect(planned.ok, planned.ok ? '' : JSON.stringify(planned.issue)).toBe(true)
    if (!planned.ok) return
    planned.plan.apply(editor)
    expect(updated).toHaveLength(1)
    expect(updated[0].props.mediaId).toBe('media-b')
    expect(updated[0].props.mediaPath).toBe('projects/p/media/b.png')
    const meta = JSON.parse(updated[0].meta.nodeResult) as { selectedMediaId: string }
    expect(meta.selectedMediaId).toBe('media-b')
  })

  it('集合外的 mediaId 被拒（不能把产物来源换成任意素材）', () => {
    const { editor } = mockEditor([imageCard()])
    const planned = planGraphPatch(
      editor,
      [{ action: 'node.select-result', nodeId: 'shape:img', mediaId: 'media-elsewhere' }],
      []
    )
    expect(planned.ok).toBe(false)
    if (!planned.ok) expect(planned.issue.code).toBe('RESULT_NOT_FOUND')
  })

  it('没有结果集合的节点被拒；节点不存在被拒', () => {
    const plain = mockEditor([card('text-node')])
    const noCollection = planGraphPatch(
      plain.editor,
      [{ action: 'node.select-result', nodeId: 'shape:text-node', mediaId: 'media-a' }],
      []
    )
    expect(noCollection.ok).toBe(false)
    if (!noCollection.ok) expect(noCollection.issue.code).toBe('RESULT_NOT_FOUND')

    const ghost = planGraphPatch(
      editorOf(imageCard()),
      [{ action: 'node.select-result', nodeId: 'shape:ghost', mediaId: 'media-a' }],
      []
    )
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.issue.code).toBe('NODE_NOT_FOUND')
  })

  function editorOf(shape: MockShape) {
    return mockEditor([shape]).editor
  }
})

describe('group.create / group.delete', () => {
  it('组合调用 groupShapes 并把 ref 映射到新 group', () => {
    const editorState = mockEditor([card('a'), card('b')])
    const planned = planGraphPatch(
      editorState.editor,
      [{ action: 'group.create', nodeIds: ['shape:a', 'shape:b'], ref: 'g1' }],
      []
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    planned.plan.apply(editorState.editor)
    expect(editorState.grouped).toHaveLength(1)
    expect(editorState.grouped[0].sort()).toEqual(['shape:a', 'shape:b'])

    // 用 ref 解组：同一批内 group.create 之后能引用 g1
    const ungroup = planGraphPatch(editorState.editor, [{ action: 'group.delete', groupId: 'g1' }], [])
    // planner 的 ref 只在同一批内有效，单独一批传 'g1' 会解析成 shape id 并因不是 group 被拒
    expect(ungroup.ok).toBe(false)
    if (!ungroup.ok) expect(ungroup.issue.code).toBe('GROUP_NOT_FOUND')
  })

  it('解组真实 group 走 ungroupShapes；对普通节点解组被拒', () => {
    const shapes = [card('a'), card('b'), groupShape('g', ['shape:a', 'shape:b'])]
    const editorState = mockEditor(shapes)
    const planned = planGraphPatch(editorState.editor, [{ action: 'group.delete', groupId: 'shape:g' }], [])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    planned.plan.apply(editorState.editor)
    expect(editorState.ungrouped).toHaveLength(1)
    expect(editorState.ungrouped[0]).toEqual(['shape:g'])

    const notGroup = planGraphPatch(
      editorState.editor,
      [{ action: 'group.delete', groupId: 'shape:a' }],
      []
    )
    expect(notGroup.ok).toBe(false)
    if (!notGroup.ok) expect(notGroup.issue.code).toBe('GROUP_NOT_FOUND')
  })

  it('组合要求至少两个节点，且节点必须存在', () => {
    const editorState = mockEditor([card('a')])
    const one = planGraphPatch(editorState.editor, [{ action: 'group.create', nodeIds: ['shape:a'] }], [])
    expect(one.ok).toBe(false)

    const ghost = planGraphPatch(
      editorState.editor,
      [{ action: 'group.create', nodeIds: ['shape:a', 'shape:ghost'] }],
      []
    )
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.issue.code).toBe('NODE_NOT_FOUND')
  })
})
