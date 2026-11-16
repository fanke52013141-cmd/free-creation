// 并发循环项影子编辑器隔离正确性（P1）：循环体节点运行态写本项影子层，
// 非循环体形状（泳道/产物）走真实画布；两项影子互不污染。
import { describe, it, expect } from 'vitest'
import type { Editor } from 'tldraw'
import { createShadowEditor } from '@renderer/engine/executor'

function mockRealEditor(): { editor: Editor; store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>()
  store.set('body1', { id: 'body1', type: 'node-card', props: { exec: 'idle', text: 'base' }, meta: {} })
  store.set('lane1', { id: 'lane1', type: 'node-card', props: { text: '' }, meta: {} })
  const editor = {
    getShape: (id: string) => store.get(id),
    updateShape: (patch: { id: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
      const cur = store.get(patch.id) ?? { id: patch.id, type: 'node-card', props: {}, meta: {} }
      store.set(patch.id, {
        ...cur,
        props: { ...(cur.props as object), ...patch.props },
        meta: { ...(cur.meta as object), ...patch.meta }
      })
    },
    updateShapes: (patches: Array<{ id: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }>) => {
      for (const patch of patches) editor.updateShape(patch)
    }
  } as unknown as Editor
  return { editor, store }
}

describe('createShadowEditor 并发隔离', () => {
  it('循环体节点运行态写影子层，真实定义卡不被填充', () => {
    const { editor, store } = mockRealEditor()
    const shadow = new Map()
    const proxy = createShadowEditor(editor, shadow, new Set(['body1']))
    proxy.updateShape({ id: 'body1', type: 'node-card', props: { exec: 'running' } } as never)
    proxy.updateShape({ id: 'body1', type: 'node-card', meta: { nodeRun: { status: 'success' } } } as never)
    expect((store.get('body1')!.props as Record<string, unknown>).exec).toBe('idle')
    expect(store.get('body1')!.meta).toEqual({})
    const view = proxy.getShape('body1' as never) as Record<string, unknown>
    expect((view.props as Record<string, unknown>).exec).toBe('running')
    expect((view.props as Record<string, unknown>).text).toBe('base')
    expect((view.meta as Record<string, unknown>).nodeRun).toEqual({ status: 'success' })
  })

  it('非循环体形状（泳道/产物）直写真实画布', () => {
    const { editor, store } = mockRealEditor()
    const proxy = createShadowEditor(editor, new Map(), new Set(['body1']))
    proxy.updateShape({ id: 'lane1', type: 'node-card', props: { text: '提示词' } } as never)
    expect((store.get('lane1')!.props as Record<string, unknown>).text).toBe('提示词')
  })

  it('两个并发项的影子互不污染', () => {
    const { editor } = mockRealEditor()
    const shadowA = new Map()
    const shadowB = new Map()
    const a = createShadowEditor(editor, shadowA, new Set(['body1']))
    const b = createShadowEditor(editor, shadowB, new Set(['body1']))
    a.updateShape({ id: 'body1', type: 'node-card', meta: { nodeResult: 'A的结果' } } as never)
    b.updateShape({ id: 'body1', type: 'node-card', meta: { nodeResult: 'B的结果' } } as never)
    const viewA = a.getShape('body1' as never) as Record<string, unknown>
    const viewB = b.getShape('body1' as never) as Record<string, unknown>
    expect((viewA.meta as Record<string, unknown>).nodeResult).toBe('A的结果')
    expect((viewB.meta as Record<string, unknown>).nodeResult).toBe('B的结果')
  })
})