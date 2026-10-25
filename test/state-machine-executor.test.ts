// P2-A 状态机节点独立执行：权威实例、合法迁移、修订冲突、事件去重、
// 配置漂移、保存重开持久与 flow.state@1 正式输出。
import { describe, expect, it, vi } from 'vitest'
import {
  parseStateMachineInstance,
  parseStateMachinePending,
  stateMachineExecutor,
  stateMachineFlowState,
  type StateMachineInstance
} from '@shared/engine/executors/agentFlow'
import { projectStateMachineOutputs } from '@shared/agent-flow/agent-outputs'
import { DEFAULT_STATE_NODE_CONFIG } from '@shared/agent-flow/node-contracts'
import { validateNodeSchema } from '@shared/node-schemas'
import type { NodeExecutionContext } from '@shared/engine/executor-types'

const CONFIG = JSON.stringify({
  ...DEFAULT_STATE_NODE_CONFIG,
  states: ['draft', 'working', 'completed'],
  initialState: 'draft',
  transitions: [
    { from: 'draft', event: 'start', to: 'working' },
    { from: 'working', event: 'finish', to: 'completed' }
  ]
})

interface Harness {
  meta: Record<string, unknown>
  result: { value: string | null }
  traces: string[]
  run: (metaOverrides?: Record<string, unknown>) => Promise<ReturnType<typeof stateMachineExecutor>>
  clone: () => Record<string, unknown>
}

/** 最小执行上下文：网关一旦被访问立即抛错（状态机不得调用网关）。 */
function makeHarness(initialMeta: Record<string, unknown> = {}): Harness {
  const meta: Record<string, unknown> = { ...initialMeta }
  const result = { value: null as string | null }
  const traces: string[] = []
  const gateway = new Proxy(
    {},
    {
      get: () => {
        throw new Error('状态机执行器不得访问网关')
      }
    }
  )
  const applyPatch = (patch: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) delete meta[key]
      else meta[key] = value
    }
  }
  const run = (metaOverrides?: Record<string, unknown>): ReturnType<typeof stateMachineExecutor> =>
    stateMachineExecutor({
      node: { id: 'shape:sm', type: 'state-machine' },
      shape: {
        id: 'shape:sm',
        type: 'node-card',
        props: {
          nodeType: 'state-machine',
          title: '状态机',
          config: CONFIG,
          text: '',
          mediaId: '',
          mediaPath: '',
          mediaMime: '',
          exec: 'idle',
          w: 340,
          h: 260
        },
        meta: { ...meta, ...(metaOverrides ?? {}) }
      },
      projectId: 'project-a',
      runId: 'run-sm',
      providers: [],
      signal: { cancelled: false },
      gateway,
      trace: (phase, level, message) => traces.push(`${phase}:${level}:${message}`),
      updateMeta: applyPatch,
      updateResult: (value) => {
        result.value = value
      }
    } as unknown as NodeExecutionContext)
  return {
    meta,
    result,
    traces,
    run,
    clone: () => JSON.parse(JSON.stringify({ ...meta }))
  }
}

function pending(eventId: string, event: string, expectedRevision: number): string {
  return JSON.stringify({ eventId, event, expectedRevision })
}

describe('状态机独立执行（P2-A）', () => {
  it('首次运行初始化权威实例并输出 flow.state', async () => {
    const h = makeHarness()
    const outcome = await h.run()
    expect(outcome).toEqual({ status: 'done' })
    const instance = parseStateMachineInstance(h.meta.stateMachine)
    expect(instance).toMatchObject({
      schemaVersion: 1,
      taskId: 'state-machine:shape:sm',
      stateNodeId: 'shape:sm',
      revision: 1,
      state: 'draft',
      history: []
    })
    const flowState = JSON.parse(String(h.result.value))
    expect(flowState).toEqual({
      schemaVersion: 1,
      taskId: 'state-machine:shape:sm',
      stateNodeId: 'shape:sm',
      revision: 1,
      state: 'draft'
    })
    expect(validateNodeSchema({ id: 'flow.state', version: 1 }, flowState)).toMatchObject({
      ok: true,
      errors: []
    })
    const outputs = projectStateMachineOutputs({
      meta: { nodeResult: h.result.value }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(outputs['out-state']).toMatchObject({ kind: 'json', data: { state: 'draft' } })
  })

  it('合法迁移推进状态：revision 单调递增、lastEventId 记录、pending 清除', async () => {
    const h = makeHarness()
    await h.run()
    h.meta.stateMachinePending = pending('evt-1', 'start', 1)
    const outcome = await h.run()
    expect(outcome).toEqual({ status: 'done' })
    const instance = parseStateMachineInstance(h.meta.stateMachine)
    expect(instance).toMatchObject({ state: 'working', revision: 2, lastEventId: 'evt-1' })
    expect(instance?.history).toHaveLength(1)
    expect(instance?.history[0]).toMatchObject({ from: 'draft', to: 'working', revision: 2 })
    // 消费后写空串（tldraw meta 浅合并下删键不生效）。
    expect(h.meta.stateMachinePending).toBe('')
    expect(h.traces.some((line) => line.includes('draft -> working'))).toBe(true)
  })

  it('修订冲突拒绝应用：实例与 pending 原样保留', async () => {
    const h = makeHarness()
    await h.run()
    h.meta.stateMachinePending = pending('evt-stale', 'start', 99)
    const outcome = await h.run()
    expect(outcome).toMatchObject({ status: 'failed' })
    expect(String(outcome.reason)).toContain('状态修订冲突')
    const instance = parseStateMachineInstance(h.meta.stateMachine)
    expect(instance?.state).toBe('draft')
    expect(parseStateMachinePending(h.meta.stateMachinePending)).not.toBeNull()
  })

  it('同一事件按 lastEventId 去重，不重复应用', async () => {
    const h = makeHarness()
    await h.run()
    h.meta.stateMachinePending = pending('evt-1', 'start', 1)
    await h.run()
    // 同修订下重复提交同一 eventId：按去重拒绝，状态不变。
    const instance = parseStateMachineInstance(h.meta.stateMachine)
    const replay = { eventId: instance?.lastEventId, event: 'start', expectedRevision: 2 }
    h.meta.stateMachinePending = JSON.stringify(replay)
    const dedup = await h.run()
    expect(dedup).toMatchObject({ status: 'failed' })
    expect(String(dedup.reason)).toContain('无需重复提交')
    expect(parseStateMachineInstance(h.meta.stateMachine)?.state).toBe('working')
    // 基于旧修订（1）的迟到提交：按修订冲突拒绝。
    h.meta.stateMachinePending = pending('evt-late', 'finish', 1)
    const late = await h.run()
    expect(late).toMatchObject({ status: 'failed' })
    expect(String(late.reason)).toContain('状态修订冲突')
  })

  it('未声明的转换显式失败，不猜测迁移', async () => {
    const h = makeHarness()
    await h.run()
    h.meta.stateMachinePending = pending('evt-x', 'finish', 1)
    const outcome = await h.run()
    expect(outcome).toMatchObject({ status: 'failed' })
    expect(String(outcome.reason)).toContain('未声明的转换')
    expect(parseStateMachineInstance(h.meta.stateMachine)?.state).toBe('draft')
  })

  it('无事件运行是幂等刷新：状态与 revision 不变', async () => {
    const h = makeHarness()
    await h.run()
    h.meta.stateMachinePending = pending('evt-1', 'start', 1)
    await h.run()
    const before = h.clone()
    const outcome = await h.run()
    expect(outcome).toEqual({ status: 'done' })
    expect(JSON.parse(String(h.meta.stateMachine))).toEqual(
      JSON.parse(String(before.stateMachine))
    )
  })

  it('配置漂移（当前状态不在声明列表）显式失败，不静默迁移', async () => {
    const h = makeHarness({
      stateMachine: JSON.stringify({
        schemaVersion: 1,
        taskId: 'state-machine:shape:sm',
        stateNodeId: 'shape:sm',
        revision: 3,
        state: 'archived',
        history: []
      } satisfies StateMachineInstance)
    })
    const outcome = await h.run()
    expect(outcome).toMatchObject({ status: 'failed' })
    expect(String(outcome.reason)).toContain('已不在声明的阶段列表')
  })

  it('实例与节点不匹配时拒绝执行', async () => {
    const h = makeHarness({
      stateMachine: JSON.stringify({
        schemaVersion: 1,
        taskId: 'state-machine:shape:other',
        stateNodeId: 'shape:other',
        revision: 1,
        state: 'draft',
        history: []
      } satisfies StateMachineInstance)
    })
    const outcome = await h.run()
    expect(outcome).toMatchObject({ status: 'failed' })
    expect(String(outcome.reason)).toContain('实例与节点不匹配')
  })

  it('配置无效时输入阶段失败', async () => {
    const gateway = new Proxy(
      {},
      {
        get: () => {
          throw new Error('状态机执行器不得访问网关')
        }
      }
    )
    const outcome = stateMachineExecutor({
      node: { id: 'shape:sm', type: 'state-machine' },
      shape: {
        id: 'shape:sm',
        type: 'node-card',
        props: {
          nodeType: 'state-machine',
          config: '{invalid',
          text: '',
          mediaId: '',
          mediaPath: '',
          mediaMime: '',
          exec: 'idle',
          w: 340,
          h: 260
        },
        meta: {}
      },
      projectId: 'project-a',
      providers: [],
      signal: { cancelled: false },
      gateway
    } as unknown as NodeExecutionContext)
    expect(outcome).toMatchObject({ status: 'failed', diagnosticPhase: 'input' })
  })

  it('保存重开后实例与待应用事件按原样恢复，明确重试继续推进', async () => {
    const h = makeHarness()
    await h.run()
    h.meta.stateMachinePending = pending('evt-1', 'start', 1)
    // 模拟保存 → 重开：meta 经 JSON 序列化往返。
    const restored = h.clone()
    const h2 = makeHarness(restored)
    const outcome = await h2.run()
    expect(outcome).toEqual({ status: 'done' })
    expect(parseStateMachineInstance(h2.meta.stateMachine)).toMatchObject({
      state: 'working',
      revision: 2
    })
  })

  it('stateMachineFlowState 与 flow.state@1 契约一致（含 lastEventId）', () => {
    const flowState = stateMachineFlowState({
      schemaVersion: 1,
      taskId: 'state-machine:shape:sm',
      stateNodeId: 'shape:sm',
      revision: 4,
      state: 'completed',
      lastEventId: 'evt-2',
      history: []
    })
    expect(validateNodeSchema({ id: 'flow.state', version: 1 }, flowState)).toMatchObject({
      ok: true,
      errors: []
    })
  })

  it('非法 pending（缺字段或坏 JSON）按输入失败处理，不应用迁移', async () => {
    const h = makeHarness()
    await h.run()
    h.meta.stateMachinePending = '{broken'
    const outcome = await h.run()
    expect(outcome).toMatchObject({ status: 'failed' })
    expect(parseStateMachineInstance(h.meta.stateMachine)?.state).toBe('draft')
  })

  it('下游可以把 out-state 接到 json 端口（端口对兼容由注册矩阵覆盖）', () => {
    const outputs = projectStateMachineOutputs({
      meta: {
        nodeResult: JSON.stringify(
          stateMachineFlowState({
            schemaVersion: 1,
            taskId: 'state-machine:shape:sm',
            stateNodeId: 'shape:sm',
            revision: 2,
            state: 'working',
            lastEventId: 'evt-1',
            history: []
          })
        )
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(outputs['out-state']).toMatchObject({ kind: 'json', data: { state: 'working' } })
  })
})
