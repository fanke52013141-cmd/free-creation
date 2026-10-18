// @vitest-environment jsdom
// L01 验收 A01/A02：3 节点顺序运行共享同一根 trace、各自独立执行实例、
// 唯一终态；失败节点可定位阶段；敏感 fixture 不进入事件输出。
import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import type { Editor } from 'tldraw'
import { runWorkflow, runNodeManually } from '@renderer/engine/executor'
import {
  drainDiagnosticsEvents,
  diagnosticsTransportDropCount,
  emitDiagnosticsEvent,
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

function arrow(
  id: string,
  fromPort: string,
  toPort: string
): {
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
    updateShape: (patch: {
      id: string
      props?: Record<string, unknown>
      meta?: Record<string, unknown>
    }) => {
      const current = map.get(patch.id)
      if (!isCard(current)) return
      if (patch.props) Object.assign(current.props, patch.props)
      if (patch.meta) Object.assign(current.meta, patch.meta)
    },
    updateShapes: (
      patches: Array<{
        id: string
        props?: Record<string, unknown>
        meta?: Record<string, unknown>
      }>
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
  it('拒绝无模型的新 Agent 任务，不启动工作流或排队节点', async () => {
    const agent = node('shape:agent-no-model', 'agent', '缺少模型的任务目标')
    agent.props.config = JSON.stringify({
      schemaVersion: 1,
      role: 'specialist',
      interactionMode: 'autonomous',
      skills: [],
      tools: [],
      allowedNodeIds: [],
      maxSteps: 4,
      relations: []
    })
    const { editor, events } = setupEditor([agent])

    const result = await runNodeManually(editor, 'project-no-model', [], agent.id)
    await drainDiagnosticsEvents()

    expect(result).toEqual({ status: 'failed', reason: '请在节点设置中选择决策模型。' })
    expect(events).toEqual([])
    expect(agent.props.exec).toBe('idle')
    expect(agent.meta.nodeRun).toBeUndefined()
    expect(agent.meta.agentTask).toBeUndefined()
  })

  it('拒绝已禁用的文本模型，且不发出工作流事件', async () => {
    const agent = node('shape:agent-disabled-model', 'agent', '禁用模型时不得进入队列')
    agent.props.config = JSON.stringify({
      schemaVersion: 1,
      role: 'specialist',
      interactionMode: 'autonomous',
      modelDefinitionId: 'disabled-model',
      skills: [],
      tools: [],
      allowedNodeIds: [],
      maxSteps: 4,
      relations: []
    })
    const { editor, events } = setupEditor([agent])
    const api = (window as unknown as { api: Record<string, unknown> }).api
    api.models = {
      listDefinitions: async () => ({
        ok: true,
        data: [
          {
            id: 'disabled-model',
            connectionId: 'connection-1',
            enabled: false,
            capabilities: [{ operation: 'text.generate' }]
          }
        ]
      }),
      listConnections: async () => ({
        ok: true,
        data: [{ id: 'connection-1', enabled: true, protocol: 'openai-compatible' }]
      })
    }

    const result = await runNodeManually(editor, 'project-disabled-model', [], agent.id)
    await drainDiagnosticsEvents()

    expect(result).toEqual({
      status: 'failed',
      reason: '所选文本模型不可用，请检查模型设置。'
    })
    expect(events).toEqual([])
    expect(agent.props.exec).toBe('idle')
    expect(agent.meta.nodeRun).toBeUndefined()
    expect(agent.meta.agentTask).toBeUndefined()
  })

  it('拒绝缺少图像输入能力的图片审核模型，不启动工作流或节点', async () => {
    const review = node('shape:review-image-model', 'ai-review', '需要检查完整图片')
    review.props.config = JSON.stringify({
      schemaVersion: 1,
      reviewMode: 'image',
      modelDefinitionId: 'text-only-model',
      rulesVersion: 'rules-1',
      rejectPolicy: 'stop',
      maxReworks: 0,
      subjectSources: [{ nodeId: 'shape:source', portId: 'out-image' }],
      gatedNodeIds: [],
      relations: []
    })
    const { editor, events } = setupEditor([review])
    const api = (window as unknown as { api: Record<string, unknown> }).api
    api.models = {
      listDefinitions: async () => ({
        ok: true,
        data: [
          {
            id: 'text-only-model',
            connectionId: 'connection-1',
            enabled: true,
            capabilities: [{ operation: 'text.generate', acceptedAssetKinds: [] }],
            validation: { 'text.generate': { status: 'verified' } }
          }
        ]
      }),
      listConnections: async () => ({
        ok: true,
        data: [{ id: 'connection-1', enabled: true, protocol: 'openai-compatible' }]
      })
    }

    const result = await runNodeManually(editor, 'project-review-image-model', [], review.id)
    await drainDiagnosticsEvents()

    expect(result).toEqual({
      status: 'failed',
      reason: '所选审核模型未通过图像输入能力验证，请检查模型设置。'
    })
    expect(events).toEqual([])
    expect(review.props.exec).toBe('idle')
    expect(review.meta.nodeRun).toBeUndefined()
  })

  it('gives repeated publications distinct workflow spans linked to the same parent operation', async () => {
    const source = node('shape:source', 'text', 'private-publication')
    const { editor, events } = setupEditor([source])
    const publication = {
      projectId: 'project-1',
      nodeId: source.id,
      taskId: 'publication',
      semanticRevision: `sha256:${'a'.repeat(64)}`,
      traceId: 'trace-publication',
      spanId: 'parent-publication'
    }
    await runNodeManually(editor, 'project-1', [], source.id, undefined, publication)
    await runNodeManually(editor, 'project-1', [], source.id, undefined, publication)
    await drainDiagnosticsEvents()
    const starts = events.filter((event) => event.event === 'workflow.started')
    const ends = events.filter((event) =>
      ['workflow.completed', 'workflow.failed', 'workflow.cancelled'].includes(event.event)
    )
    expect(starts).toHaveLength(2)
    expect(new Set(starts.map((event) => event.spanId)).size).toBe(2)
    for (const start of starts) {
      expect(start.traceId).toBe(publication.traceId)
      expect(start.parentSpanId).toBe(publication.spanId)
      expect(ends.filter((end) => end.spanId === start.spanId)).toHaveLength(1)
    }
  })
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
    await drainDiagnosticsEvents()

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
    await drainDiagnosticsEvents()

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
    await drainDiagnosticsEvents()

    const dumped = JSON.stringify(events)
    expect(dumped).not.toContain('sk-fakekey12345678901234')
    expect(dumped).not.toContain('假提示词SECRET内容')
    expect(dumped).not.toContain('fake-value-123')
  })

  it('waits for in-flight IPC acknowledgements before the diagnostics queue is drained', async () => {
    let acknowledge!: (value: unknown) => void
    let markSent!: () => void
    const sent = new Promise<void>((resolve) => {
      markSent = resolve
    })
    let delivered = 0
    ;(window as unknown as { api: unknown }).api = {
      reportDiagnosticsEvents: (input: { events: DiagnosticsEventInput[] }) => {
        delivered += input.events.length
        markSent()
        return new Promise((resolve) => {
          acknowledge = resolve
        })
      }
    }

    emitDiagnosticsEvent({ event: 'node.completed' })
    let drained = false
    const draining = drainDiagnosticsEvents().then(() => {
      drained = true
    })
    await sent

    expect(delivered).toBe(1)
    expect(drained).toBe(false)
    acknowledge({ ok: true })
    await draining

    expect(drained).toBe(true)
    expect(diagnosticsTransportDropCount()).toBe(0)
  })

  it('completes drain after a failed transport and records dropped events', async () => {
    ;(window as unknown as { api: unknown }).api = {
      reportDiagnosticsEvents: () => Promise.reject(new Error('transport unavailable'))
    }

    emitDiagnosticsEvent({ event: 'node.failed' })
    await drainDiagnosticsEvents()

    expect(diagnosticsTransportDropCount()).toBe(1)
  })
})
