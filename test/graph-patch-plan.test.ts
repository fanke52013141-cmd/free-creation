// F2 graph.patch 权威宿主规划器测试：整批校验的拒绝矩阵与原子应用计划。
// 使用真实节点注册表；编辑器用最小模拟（只实现规划阶段读取的方法与 apply 记录）。
// @vitest-environment jsdom
import { describe, expect, it, beforeAll } from 'vitest'
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

function mockEditor(shapes: MockShape[]): Editor {
  const created: any[] = []
  const updated: any[] = []
  const deleted: string[] = []
  const editor = {
    getCurrentPageShapes: () => shapes,
    getBindingsFromShape: (shapeId: TLShapeId, _type: string) =>
      arrowBindings.get(String(shapeId)) ?? [],
    getShape: (shapeId: TLShapeId) => shapes.find((s) => s.id === String(shapeId)),
    createShape: (input: any) => {
      created.push(input)
      shapes.push(input as MockShape)
    },
    updateShape: (input: any) => updated.push(input),
    deleteShapes: (ids: TLShapeId[]) => {
      for (const id of ids) deleted.push(String(id))
    },
    bringToFront: () => {},
    sendToBack: () => {},
    run: (fn: () => void) => fn(),
    __created: created,
    __updated: updated,
    __deleted: deleted
  }
  return editor as unknown as Editor
}

const arrowBindings = new Map<string, { from: string; to: string }>()

function card(id: string, nodeType: string, config = '', text = ''): MockShape {
  return {
    id: `shape:${id}`,
    type: 'node-card',
    x: 0,
    y: 0,
    index: 'a1',
    props: {
      w: 340,
      h: 260,
      nodeType,
      title: id,
      config,
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    }
  }
}

function arrow(
  id: string,
  from: string,
  to: string,
  fromPort: string,
  toPort: string
): MockShape {
  return {
    id: `shape:${id}`,
    type: 'arrow',
    x: 0,
    y: 0,
    index: 'a2',
    meta: { fromPort, toPort },
    props: {}
  }
}

function editorWith(
  shapes: MockShape[],
  bindings: Array<[string, { from: string; to: string }]>
): Editor {
  arrowBindings.clear()
  for (const [id, value] of bindings)
    arrowBindings.set(`shape:${id}`, [
      { props: { terminal: 'start' }, toId: `shape:${value.from}` },
      { props: { terminal: 'end' }, toId: `shape:${value.to}` }
    ])
  return mockEditor(shapes)
}

describe('graph.patch 规划器校验矩阵', () => {
  it('创建文本节点并合并配置，返回可映射的 created 计划', () => {
    const editor = mockEditor([])
    const result = planGraphPatch(
      editor,
      [
        {
          action: 'node.create',
          ref: 'a',
          nodeType: 'text',
          x: 10,
          y: 20,
          title: '外部',
          config: { keep: 1 }
        }
      ],
      []
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.created).toHaveLength(1)
    expect(result.plan.created[0].ref).toBe('a')
    expect(result.plan.counts.nodeCreated).toBe(1)
    result.plan.apply(editor)
    const created = (editor as any).__created as any[]
    expect(created).toHaveLength(1)
    expect(created[0].props.nodeType).toBe('text')
    expect(created[0].props.title).toBe('外部')
    expect(JSON.parse(created[0].props.config)).toEqual({ keep: 1 })
  })

  it('文本→处理节点的连线合法；文本→JSON 输入按类型拒绝', () => {
    const ok = planGraphPatch(
      editorWith([card('a', 'text'), card('b', 'processor')], []),
      [
        {
          action: 'edge.create',
          from: { nodeId: 'shape:a', portId: 'out-text' },
          to: { nodeId: 'shape:b', portId: 'in-value' }
        }
      ],
      []
    )
    expect(ok).toMatchObject({ ok: true, plan: { counts: { edgeCreated: 1 } } })

    const bad = planGraphPatch(
      editorWith([card('a', 'text'), card('b', 'json')], []),
      [
        {
          action: 'edge.create',
          from: { nodeId: 'shape:a', portId: 'out-text' },
          to: { nodeId: 'shape:b', portId: 'in-json' }
        }
      ],
      []
    )
    expect(bad).toMatchObject({ ok: false, issue: { index: 0, code: 'EDGE_INCOMPATIBLE' } })
  })

  it('单值输入端口已被占用时拒绝第二条连线，重复连线拒绝', () => {
    const occupied = planGraphPatch(
      editorWith(
        [
          card('s1', 'image'),
          card('s2', 'image'),
          card('crop', 'image-crop'),
          arrow('e0', 'shape:s1', 'shape:crop', 'out-image', 'in-image')
        ],
        [['e0', { from: 's1', to: 'crop' }]]
      ),
      [
        {
          action: 'edge.create',
          from: { nodeId: 'shape:s2', portId: 'out-image' },
          to: { nodeId: 'shape:crop', portId: 'in-image' }
        }
      ],
      []
    )
    expect(occupied).toMatchObject({ ok: false, issue: { index: 0, code: 'EDGE_OCCUPIED' } })

    const dup = planGraphPatch(
      editorWith(
        [card('a', 'text'), card('b', 'text'), arrow('e0', 'shape:a', 'shape:b', 'out-text', 'in-text')],
        [['e0', { from: 'a', to: 'b' }]]
      ),
      [
        {
          action: 'edge.create',
          from: { nodeId: 'shape:a', portId: 'out-text' },
          to: { nodeId: 'shape:b', portId: 'in-text' }
        }
      ],
      []
    )
    expect(dup).toMatchObject({ ok: false, issue: { index: 0, code: 'EDGE_DUPLICATE' } })
  })

  it('批次成环整批拒绝，不留下半张图', () => {
    const cyclic = planGraphPatch(
      editorWith([card('a', 'text'), card('b', 'text')], []),
      [
        {
          action: 'edge.create',
          from: { nodeId: 'shape:a', portId: 'out-text' },
          to: { nodeId: 'shape:b', portId: 'in-text' }
        },
        {
          action: 'edge.create',
          from: { nodeId: 'shape:b', portId: 'out-text' },
          to: { nodeId: 'shape:a', portId: 'in-text' }
        }
      ],
      []
    )
    expect(cyclic).toMatchObject({ ok: false, issue: { code: 'EDGE_CYCLE' } })
  })

  it('同批 ref 先建后连；未知引用在宿主侧拒绝', () => {
    const ok = planGraphPatch(
      editorWith([card('up', 'text')], []),
      [
        { action: 'node.create', ref: 'down', nodeType: 'text', x: 0, y: 0 },
        {
          action: 'edge.create',
          from: { nodeId: 'shape:up', portId: 'out-text' },
          to: { nodeId: 'down', portId: 'in-text' }
        }
      ],
      []
    )
    expect(ok).toMatchObject({ ok: true, plan: { counts: { nodeCreated: 1, edgeCreated: 1 } } })

    const unknown = planGraphPatch(
      editorWith([], []),
      [
        {
          action: 'edge.create',
          from: { nodeId: 'ghost', portId: 'out-text' },
          to: { nodeId: 'shape:x', portId: 'in-text' }
        }
      ],
      []
    )
    expect(unknown).toMatchObject({ ok: false, issue: { index: 0, code: 'NODE_NOT_FOUND' } })
  })

  it('删除节点级联移除连线；不存在的目标拒绝', () => {
    const editor = editorWith(
      [card('a', 'text'), card('b', 'text'), arrow('e0', 'shape:a', 'shape:b', 'out-text', 'in-text')],
      [['e0', { from: 'a', to: 'b' }]]
    )
    const plan = planGraphPatch(editor, [{ action: 'node.delete', nodeId: 'shape:a' }], [])
    expect(plan).toMatchObject({ ok: true, plan: { counts: { nodeDeleted: 1 } } })
    if (plan.ok) plan.plan.apply(editor)
    expect((editor as any).__deleted as string[]).toEqual(['shape:a'])

    const missing = planGraphPatch(
      editorWith([], []),
      [{ action: 'node.delete', nodeId: 'shape:zz' }],
      []
    )
    expect(missing).toMatchObject({ ok: false, issue: { index: 0, code: 'NODE_NOT_FOUND' } })
  })

  it('更新配置使连线引用的动态端口消失时整批拒绝', () => {
    const config = JSON.stringify({ params: [], outputs: [{ name: 'result', type: 'text' }] })
    const editor = editorWith(
      [card('c', 'code', config), card('t', 'text'), arrow('e0', 'shape:c', 'shape:t', 'out-result', 'in-text')],
      [['e0', { from: 'c', to: 't' }]]
    )
    const result = planGraphPatch(
      editor,
      [
        {
          action: 'node.update',
          nodeId: 'shape:c',
          config: { outputs: [{ name: 'other', type: 'text' }] }
        }
      ],
      []
    )
    // 移除 result 输出字段会让既有连线悬空 → 必须拒绝而不是静默删边
    expect(result).toMatchObject({ ok: false, issue: { code: 'EDGE_PORT_INVALID' } })
  })

  it('未登记节点类型、超大配置与无效操作在规划前拒绝', () => {
    const notActive = planGraphPatch(
      editorWith([], []),
      [{ action: 'node.create', nodeType: 'script' as never, x: 0, y: 0 }],
      []
    )
    expect(notActive).toMatchObject({ ok: false, issue: { code: 'INVALID_INPUT' } })

    const big = planGraphPatch(
      editorWith([], []),
      [
        {
          action: 'node.create',
          nodeType: 'text',
          x: 0,
          y: 0,
          config: { blob: 'x'.repeat(70_000) }
        }
      ],
      []
    )
    expect(big).toMatchObject({ ok: false, issue: { code: 'CONFIG_TOO_LARGE' } })

    const malformed = planGraphPatch(editorWith([], []), [{ action: 'node.frobnicate' } as never], [])
    expect(malformed).toMatchObject({ ok: false, issue: { code: 'INVALID_INPUT' } })
  })

  it('W1：composite 只允许带固定 manifest 快照插入，不能无配置创建', () => {
    const withoutManifest = planGraphPatch(
      editorWith([], []),
      [{ action: 'node.create', nodeType: 'composite', x: 0, y: 0 }],
      []
    )
    expect(withoutManifest).toMatchObject({ ok: false, issue: { code: 'NODE_TYPE_INVALID' } })

    const compositeEditor = mockEditor([])
    const withManifest = planGraphPatch(
      compositeEditor,
      [
        {
          action: 'node.create',
          nodeType: 'composite',
          x: 0,
          y: 0,
          config: { manifest: { capabilityId: 'copy-polish', version: '1.0' } }
        }
      ],
      []
    )
    expect(withManifest.ok).toBe(true)
    if (!withManifest.ok) return
    withManifest.plan.apply(compositeEditor)
    expect((compositeEditor as any).__created[0].props.nodeType).toBe('composite')
  })
})
