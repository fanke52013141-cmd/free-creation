// @vitest-environment jsdom
// 卡片内手动执行必须与工作流共用同一套「连线 → 输入收集 → 执行 → 输出投影」路径。
import { beforeAll, describe, expect, it } from 'vitest'
import type { Editor } from 'tldraw'
import { runNodeManually, runWorkflowToNode } from '@renderer/engine/executor'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { registerAllNodeTypes } from './helpers/registerNodes'

beforeAll(() => registerAllNodeTypes())

function node(id: string, nodeType: string, text: string): NodeCardShape {
  return {
    id: id as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType,
      title: nodeType,
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  }
}

describe('runNodeManually · 卡片内统一执行入口', () => {
  it('预填真实上游投影后，按连线把值送入目标节点', async () => {
    const source = node('shape:text', 'text', '来自上游的真实文本')
    const target = node('shape:processor', 'processor', '')
    const arrow = {
      id: 'shape:arrow',
      type: 'arrow',
      meta: { fromPort: 'out-text', toPort: 'in-value' }
    }
    const shapes = new Map<string, typeof source | typeof target | typeof arrow>([
      [source.id, source],
      [target.id, target],
      [arrow.id, arrow]
    ])
    const editor = {
      getCurrentPageShapes: () => Array.from(shapes.values()),
      getShape: (id: string) => shapes.get(id),
      getBindingsFromShape: (id: string) =>
        id === arrow.id
          ? [
              { props: { terminal: 'start' }, toId: source.id },
              { props: { terminal: 'end' }, toId: target.id }
            ]
          : [],
      updateShape: (patch: {
        id: string
        props?: Record<string, unknown>
        meta?: Record<string, unknown>
      }) => {
        const current = shapes.get(patch.id)
        if (!current || current.type !== 'node-card') return
        if (patch.props) Object.assign(current.props, patch.props)
        if (patch.meta) Object.assign(current.meta, patch.meta)
      },
      markHistoryStoppingPoint: () => undefined
    } as unknown as Editor

    const result = await runNodeManually(editor, 'project-1', [], target.id)

    expect(result.status).toBe('done')
    expect(target.props.exec).toBe('success')
    expect(JSON.parse(String(target.meta.nodeResult))).toMatchObject({
      kind: 'text',
      text: '来自上游的真实文本'
    })
    expect(target.meta.nodeRun).toMatchObject({
      status: 'success',
      inputs: { 'in-value': [{ nodeId: source.id, portId: 'out-text' }] },
      outputPorts: ['out-value']
    })
    expect(target.meta.nodeRunHistory).toEqual([
      expect.objectContaining({
        status: 'success',
        inputs: { 'in-value': [{ nodeId: source.id, portId: 'out-text' }] }
      })
    ])
  })

  it('运行至目标节点时只执行其真实上游闭包，不扫描无关节点', async () => {
    const source = node('shape:subgraph-source', 'text', '子图输入')
    const target = node('shape:subgraph-target', 'processor', '')
    const unrelated = node('shape:subgraph-unrelated', 'processor', '')
    const arrow = {
      id: 'shape:subgraph-arrow',
      type: 'arrow',
      meta: { fromPort: 'out-text', toPort: 'in-value' }
    }
    const shapes = new Map<string, typeof source | typeof target | typeof unrelated | typeof arrow>(
      [
        [source.id, source],
        [target.id, target],
        [unrelated.id, unrelated],
        [arrow.id, arrow]
      ]
    )
    const editor = {
      getCurrentPageShapes: () => Array.from(shapes.values()),
      getShape: (id: string) => shapes.get(id),
      getBindingsFromShape: (id: string) =>
        id === arrow.id
          ? [
              { props: { terminal: 'start' }, toId: source.id },
              { props: { terminal: 'end' }, toId: target.id }
            ]
          : [],
      updateShape: (patch: {
        id: string
        props?: Record<string, unknown>
        meta?: Record<string, unknown>
      }) => {
        const current = shapes.get(patch.id)
        if (!current || current.type !== 'node-card') return
        if (patch.props) Object.assign(current.props, patch.props)
        if (patch.meta) Object.assign(current.meta, patch.meta)
      },
      markHistoryStoppingPoint: () => undefined
    } as unknown as Editor

    await runWorkflowToNode(editor, 'project-1', [], target.id)

    expect(source.props.exec).toBe('success')
    expect(target.props.exec).toBe('success')
    expect(unrelated.props.exec).toBe('idle')
    expect(JSON.parse(String(target.meta.nodeResult))).toMatchObject({ text: '子图输入' })
  })

  it('不会把最近失败节点遗留的输出当作有效上游输入', async () => {
    const source = node('shape:failed-source', 'text', '旧的遗留文本')
    source.meta.nodeRun = {
      runId: 'old-run',
      status: 'failed',
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      inputs: {},
      error: { phase: 'execution', reason: '上次失败' }
    }
    const target = node('shape:failed-target', 'processor', '')
    const arrow = {
      id: 'shape:failed-arrow',
      type: 'arrow',
      meta: { fromPort: 'out-text', toPort: 'in-value' }
    }
    const shapes = new Map<string, typeof source | typeof target | typeof arrow>([
      [source.id, source],
      [target.id, target],
      [arrow.id, arrow]
    ])
    const editor = {
      getCurrentPageShapes: () => Array.from(shapes.values()),
      getShape: (id: string) => shapes.get(id),
      getBindingsFromShape: (id: string) =>
        id === arrow.id
          ? [
              { props: { terminal: 'start' }, toId: source.id },
              { props: { terminal: 'end' }, toId: target.id }
            ]
          : [],
      updateShape: (patch: {
        id: string
        props?: Record<string, unknown>
        meta?: Record<string, unknown>
      }) => {
        const current = shapes.get(patch.id)
        if (!current || current.type !== 'node-card') return
        if (patch.props) Object.assign(current.props, patch.props)
        if (patch.meta) Object.assign(current.meta, patch.meta)
      },
      markHistoryStoppingPoint: () => undefined
    } as unknown as Editor

    const result = await runNodeManually(editor, 'project-1', [], target.id)

    expect(result.status).toBe('failed')
    expect(target.props.exec).toBe('failed')
    expect(target.meta.nodeRun).toMatchObject({
      status: 'failed',
      error: { phase: 'input' }
    })
  })
})
