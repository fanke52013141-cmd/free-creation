// @vitest-environment jsdom
// L01 验收 A01/A02：3 节点顺序运行共享同一根 trace、各自独立执行实例、
// 唯一终态；失败节点可定位阶段；敏感 fixture 不进入事件输出。
import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import type { Editor } from 'tldraw'
import { runWorkflow } from '@renderer/engine/executor'
import {
  flushDiagnosticsEvents,
  resetDiagnosticsReporterForTest
} from '@renderer/engine/diagnosticsReporter'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { registerAllNodeTypes } from '../helpers/registerNodes'
import type { DiagnosticsEventInput } from '@shared/observability'

beforeAll(() => registerAllNodeTypes())
afterEach(() => resetDiagnosticsReporterForTest())

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
      config: '',
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  }
}

function arrow(id: string, fromPort: string, toPort: string): {
  id: string
  type: 'arrow'
  meta: { fromPort: string; toPort: string }
} {
  return { id, type: 'arrow', meta: { fromPort, toPort } }
}

function setupEditor(
  shapes: unknown[],
  bindings: Record<string, Array<{ toId: string }>> = {}
): { editor: Editor; events: DiagnosticsEventInput[] } {
  const map = new Map<string, unknown>()
  for (const shape of shapes as Array<{ id: string }>) map.set(shape.id, shape)
  const events: DiagnosticsEventInput[] = []
  // 捕获 renderer reporter 发出的结构化事件（代替 preload IPC transport）。
  ;(window as unknown as { api: unknown }).api = {
    reportDiagnosticsEvents: (input: { events: DiagnosticsEventInput[] }) => {
      events.push(...input.events)
      return Promise.resolve({ ok: true, data: { accepted: input.events.length } })
    },
    reportNodeRunEvent: () => Promise.resolve({ ok: true, data: true }),
    workspace: { recordGenerationTiming: () => Promise.resolve({ ok: true, data: true }) }
  }
  const isCard = (value: unknown): value is NodeCardShape =>
    Boolean(value) && (value as { type?: string }).type === 'node-card'
  const editor = {
    getCurrentPageShapes: () => Array.from(map.values()),
    getShape: (id: string) => map.get(id),
    getBindingsFromShape: (id: string) => bindings[id] ?? [],
    updateShape: (patch: { id: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
      const current = map.get(patch.id)
      if (!isCard(current)) return
      if (patch.props) Object.assign(current.props, patch.props)
      if (patch.meta) Object.assign(current.meta, patch.meta)
    },
    updateShapes: (
      patches: Array<{ id: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }>
    ) => {
      for (const patch of patches) {
        const current = map.get(patch.id)
        if (!isCard(current)) continue
        if (patch.props) Object.assign(current.props, patch.props)
        if (patch.meta) Object.assign(current.meta, patch.meta)
      }
    },
    run: (fn: () => void) => fn(),
    markHistoryStoppingPoint: () => undefined
  } as unknown as Editor
  return { editor, events }
}

const FLUSH_WAIT_MS = 80
const SOURCE_MID_BINDINGS = {
  'shape:arrow-source-mid': [
    { props: { terminal: 'start' }, toId: 'shape:source' },
    { props: { terminal: 'end' }, toId: 'shape:mid' }
  ],
  'shape:arrow-mid-target': [
    { props: { terminal: 'start' }, toId: 'shape:mid' },
    { props: { terminal: 'end' }, toId: 'shape:target' }
  ]
}

describe('A01 · 3 节点顺序运行共享根 trace', () => {
  it('workflow.started/completed + 每节点 started/唯一终态，traceId 相同、nodeExecutionId 互不相同', async () => {
    const a = node('shape:source', 'text', '第一段')
    const b = node('shape:mid', 'processor', '')
    const c = node('shape:target', 'processor', '')
    // text.out-text → processor.in-value；processor.out-value → processor.in-value。
    const { editor, events } = setupEditor(
      [
        a,
        b,
        c,
        arrow('shape:arrow-source-mid', 'out-text', 'in-value'),
        arrow('shape:arrow-mid-target', 'out-value', 'in-value')
      ],
      SOURCE_MID_BINDINGS
    )

    await runWorkflow(editor, 'project-1', [])
    flushDiagnosticsEvents()
    await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))

    const names = events.map((event) => event.event)
    expect(names).toContain('workflow.started')
    expect(names).toContain('workflow.completed')
    expect(names.filter((name) => name === 'node.started')).toHaveLength(3)

    const started = events.filter((event) => event.event === 'workflow.started')[0]
    const completed = events.filter((event) => event.event === 'workflow.completed')[0]
    expect(started.traceId).toBe(completed.traceId)

    const nodeStarted = events.filter((event) => event.event === 'node.started')
    const traceIds = new Set(nodeStarted.map((event) => event.traceId))
    expect(traceIds.size).toBe(1)
    expect(traceIds.has(started.traceId)).toBe(true)
    const executionIds = new Set(nodeStarted.map((event) => event.nodeExecutionId))
    expect(executionIds.size).toBe(3)

    // 每个节点恰好一个终态，且全部成功；终态事件以 workflow span 为父。
    const terminals = events.filter((event) =>
      ['node.completed', 'node.failed', 'node.cancelled', 'node.skipped'].includes(event.event)
    )
    expect(terminals).toHaveLength(3)
    expect(terminals.every((event) => event.status === 'success')).toBe(true)
    expect(terminals.every((event) => event.parentSpanId === started.spanId)).toBe(true)
    expect(new Set(terminals.map((event) => event.nodeExecutionId)).size).toBe(3)

    // 运行记录持久化 traceId/nodeExecutionId（供运行中心与诊断包关联）。
    for (const shape of [a, b, c]) {
      const record = shape.meta.nodeRun as {
        traceId?: string
        nodeExecutionId?: string
        status?: string
      }
      expect(record.traceId).toBe(started.traceId)
      expect(record.nodeExecutionId).toBeTruthy()
      expect(record.status).toBe('success')
    }
  })

  it('上游跳过导致下游契约失败：node.failed 带 INPUT_INVALID；跳过节点自带原因（A02）', async () => {
    const a = node('shape:source', 'processor', '') // 无输入无固定值 → skipped
    const b = node('shape:target', 'processor', '')
    const { editor, events } = setupEditor(
      [a, b, arrow('shape:arrow-source-mid', 'out-value', 'in-value')],
      {
        'shape:arrow-source-mid': [
          { props: { terminal: 'start' }, toId: 'shape:source' },
          { props: { terminal: 'end' }, toId: 'shape:target' }
        ]
      }
    )

    await runWorkflow(editor, 'project-1', [])
    flushDiagnosticsEvents()
    await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))

    const skipped = events.filter((event) => event.event === 'node.skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].status).toBe('skipped')
    expect(skipped[0].nodeType).toBe('processor')

    const failed = events.filter((event) => event.event === 'node.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].status).toBe('failed')
    expect(failed[0].error?.code).toBe('INPUT_INVALID')

    // 失败根因可按阶段定位：无伪造的请求/能力事件。
    expect(events.some((event) => event.event.startsWith('model.request'))).toBe(false)
    expect(events.some((event) => event.event === 'workflow.failed')).toBe(true)
  })

  it('敏感 fixture（假密钥/假提示词）不会进入任何事件输出（A15）', async () => {
    const a = node(
      'shape:source',
      'text',
      'sk-fakekey12345678901234 假提示词SECRET内容 api_key=fake-value-123'
    )
    const b = node('shape:target', 'processor', '')
    const { editor, events } = setupEditor(
      [a, b, arrow('shape:arrow-source-mid', 'out-text', 'in-value')],
      {
        'shape:arrow-source-mid': [
          { props: { terminal: 'start' }, toId: 'shape:source' },
          { props: { terminal: 'end' }, toId: 'shape:target' }
        ]
      }
    )

    await runWorkflow(editor, 'project-1', [])
    flushDiagnosticsEvents()
    await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))

    const dumped = JSON.stringify(events)
    expect(dumped).not.toContain('sk-fakekey12345678901234')
    expect(dumped).not.toContain('假提示词SECRET内容')
    expect(dumped).not.toContain('fake-value-123')
  })
})
