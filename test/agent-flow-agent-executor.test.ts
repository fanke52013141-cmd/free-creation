import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { agentExecutor } from '../src/shared/engine/executors/agentFlow'
import { projectAgentOutputs } from '../src/shared/agent-flow/agent-outputs'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'
import type { FlowAgentReply } from '../src/shared/agent-flow/desktop-tasks'
vi.stubGlobal('crypto', webcrypto)
afterEach(() => vi.useRealTimers())
function context() {
  const updateResult = vi.fn(),
    updateMeta = vi.fn()
  const signal = { cancelled: false }
  const shape = {
    props: {
      config: JSON.stringify({
        schemaVersion: 1,
        role: 'specialist',
        interactionMode: 'collaborative',
        skills: [],
        tools: [{ id: 'node.execute', version: '1' }],
        allowedNodeIds: ['processor'],
        maxSteps: 12,
        relations: []
      })
    },
    meta: {}
  }
  const task = {
    taskId: 'task',
    state: 'waiting' as const,
    waitKind: 'human' as const,
    waitRevision: 1,
    decisions: 4,
    tools: 2
  }
  const runFlowAgent = vi.fn(async () => ({
    ok: true as const,
    data: { task, outputs: {}, refs: [] } as FlowAgentReply
  }))
  const stopFlowAgent = vi.fn(async () => ({
    ok: true as const,
    data: { ...task, state: 'cancelled' as const }
  }))
  const ctx = {
    shape,
    node: { id: 'agent' },
    projectId: 'project',
    runId: 'run',
    signal,
    updateResult,
    updateMeta,
    gateway: { runFlowAgent, stopFlowAgent }
  } as unknown as NodeExecutionContext
  return { ctx, signal, shape, updateResult, updateMeta, runFlowAgent, stopFlowAgent, task }
}
describe('Agent shares the registered node executor', () => {
  it('persists human wait as task metadata without projecting a success or a business result', async () => {
    const f = context()
    expect((await agentExecutor(f.ctx)).status).toBe('skipped')
    expect(f.updateMeta).toHaveBeenCalledWith({ agentTask: JSON.stringify(f.task) })
    expect(f.updateResult).toHaveBeenCalledWith(null)
    expect(f.runFlowAgent.mock.calls[0][0]).toMatchObject({
      action: 'start',
      projectId: 'project',
      nodeId: 'agent'
    })
  })
  it('continues the existing wait through main and exposes only declared successful output ports', async () => {
    const f = context()
    f.shape.meta = { agentTask: JSON.stringify(f.task) }
    f.runFlowAgent.mockResolvedValue({
      ok: true,
      data: {
        task: { ...f.task, state: 'completed' },
        refs: [],
        outputs: { 'out-text': { kind: 'text', text: 'observed' } }
      }
    })
    expect(await agentExecutor(f.ctx)).toMatchObject({
      status: 'done',
      artifactOutputPorts: ['out-text']
    })
    expect(f.runFlowAgent.mock.calls[0][0]).toMatchObject({ action: 'continue', eventId: 'run' })
    const result = f.updateResult.mock.calls[0][0]
    expect(
      projectAgentOutputs({ meta: { nodeResult: result } } as NodeExecutionContext['shape'])
    ).toEqual({ 'out-text': { kind: 'text', text: 'observed' } })
    expect(
      projectAgentOutputs({ meta: { nodeResult: 'goal prose' } } as NodeExecutionContext['shape'])
    ).toEqual({})
  })
  it('propagates public workflow cancellation once to the main task while its request is pending', async () => {
    vi.useFakeTimers()
    const f = context()
    let finish!: (reply: { ok: true; data: FlowAgentReply }) => void
    f.runFlowAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const running = agentExecutor(f.ctx)
    f.signal.cancelled = true
    await vi.advanceTimersByTimeAsync(300)
    expect(f.stopFlowAgent).toHaveBeenCalledTimes(1)
    finish({ ok: true, data: { task: { ...f.task, state: 'cancelled' }, refs: [], outputs: {} } })
    expect((await running).status).toBe('skipped')
    expect(f.updateResult).toHaveBeenCalledWith(null)
  })
  it('rejects invalid config without invoking a model or interpreting its contents', async () => {
    const f = context()
    f.shape.props.config = 'private invalid config'
    expect(await agentExecutor(f.ctx)).toMatchObject({ status: 'failed', diagnosticPhase: 'input' })
    expect(f.runFlowAgent).not.toHaveBeenCalled()
  })
})
