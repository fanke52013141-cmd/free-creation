// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  diagnosticsTransportDropCount,
  drainDiagnosticsEvents,
  emitDiagnosticsEvent,
  resetDiagnosticsReporterForTest
} from '@renderer/engine/diagnosticsReporter'
import {
  DiagnosticsProducer,
  newProducerId,
  type DiagnosticsEventInput
} from '@shared/observability'

afterEach(() => resetDiagnosticsReporterForTest())

const diagnosticsProducer = new DiagnosticsProducer({
  process: 'renderer',
  producerId: newProducerId('renderer')
})

function agentNodeEvent(event: 'node.completed' | 'node.failed'): DiagnosticsEventInput {
  return diagnosticsProducer.build(
    event,
    undefined,
    event === 'node.completed' ? 'Agent节点执行完成' : 'Agent节点执行失败',
    {
      traceId: 'trace-agent-node-01',
      spanId: 'span-agent-node-01',
      runId: 'run-agent-01',
      nodeExecutionId: 'execution-agent-01',
      projectId: 'agent-project-01',
      nodeId: 'agent-node-01',
      nodeType: 'agent',
      taskId: 'agent-task-01'
    },
    event === 'node.completed'
      ? { status: 'success', attributes: { portCount: 1 } }
      : { status: 'failed' }
  )!
}

describe('LOG-06 Agent renderer diagnostic transport', () => {
  it('keeps drain pending until the Agent resume event receives its IPC acknowledgement', async () => {
    let acknowledge!: (value: unknown) => void
    let markSent!: () => void
    const sent = new Promise<void>((resolve) => {
      markSent = resolve
    })
    const delivered: DiagnosticsEventInput[] = []
    ;(window as unknown as { api: unknown }).api = {
      reportDiagnosticsEvents: (input: { events: DiagnosticsEventInput[] }) => {
        delivered.push(...input.events)
        markSent()
        return new Promise((resolve) => {
          acknowledge = resolve
        })
      }
    }

    const completedEvent = agentNodeEvent('node.completed')
    emitDiagnosticsEvent(completedEvent)
    let drained = false
    const draining = drainDiagnosticsEvents().then(() => {
      drained = true
    })
    await sent

    expect(delivered).toEqual([completedEvent])
    expect(drained).toBe(false)
    acknowledge({ ok: true })
    await draining

    expect(drained).toBe(true)
    expect(diagnosticsTransportDropCount()).toBe(0)
  })

  it('records an Agent diagnostic batch rejected by IPC without rejecting drain', async () => {
    ;(window as unknown as { api: unknown }).api = {
      reportDiagnosticsEvents: () => Promise.reject(new Error('transport unavailable'))
    }

    emitDiagnosticsEvent(agentNodeEvent('node.failed'))

    await expect(drainDiagnosticsEvents()).resolves.toBeUndefined()
    expect(diagnosticsTransportDropCount()).toBe(1)
  })
})
