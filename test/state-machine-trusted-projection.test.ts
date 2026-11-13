// O1 状态机可信事件投影：纯迁移计算（修订 CAS / 去重 / 合法性 / source=agent）、
// pending source 校验、执行器事件来源审计。守住"模型文字不能直接赋予成功状态"——
// 外部接口只允许 human，agent 仅内部协调器投影。
import { describe, expect, it } from 'vitest'
import {
  parseStateMachineInstance,
  parseStateMachinePending,
  projectTrustedStateMachineEvent,
  stateMachineExecutor,
  type StateMachineInstance
} from '@shared/engine/executors/agentFlow'
import type { NodeExecutionContext } from '@shared/engine/executor-types'

const transitions = [
  { from: 'idle', event: 'agent.completed', to: 'active' },
  { from: 'active', event: 'flow.completed', to: 'completed' }
]
const base: StateMachineInstance = {
  schemaVersion: 1,
  taskId: 'state-machine:shape:sm',
  stateNodeId: 'shape:sm',
  revision: 1,
  state: 'idle',
  history: []
}

describe('O1 可信事件投影（纯函数）', () => {
  it('应用可信事件，推进状态/修订并记录 source=agent', () => {
    const next = projectTrustedStateMachineEvent(base, transitions, {
      eventId: 'e1',
      event: 'agent.completed',
      expectedRevision: 1,
      source: 'agent'
    })
    expect(next).not.toBeNull()
    expect(next!.state).toBe('active')
    expect(next!.revision).toBe(2)
    expect(next!.lastEventId).toBe('e1')
    expect(next!.history.at(-1)).toMatchObject({
      event: 'agent.completed',
      from: 'idle',
      to: 'active',
      source: 'agent',
      revision: 2
    })
  })

  it('修订冲突返回 null（不静默改状态）', () => {
    expect(
      projectTrustedStateMachineEvent(base, transitions, {
        eventId: 'e1',
        event: 'agent.completed',
        expectedRevision: 99,
        source: 'agent'
      })
    ).toBeNull()
  })

  it('重复事件返回 null（去重）', () => {
    const once = projectTrustedStateMachineEvent(base, transitions, {
      eventId: 'e1',
      event: 'agent.completed',
      expectedRevision: 1,
      source: 'agent'
    })!
    expect(
      projectTrustedStateMachineEvent(once, transitions, {
        eventId: 'e1',
        event: 'agent.completed',
        expectedRevision: 2,
        source: 'agent'
      })
    ).toBeNull()
  })

  it('非法迁移返回 null（当前状态不存在该事件）', () => {
    expect(
      projectTrustedStateMachineEvent(base, transitions, {
        eventId: 'e1',
        event: 'flow.completed',
        expectedRevision: 1,
        source: 'agent'
      })
    ).toBeNull()
  })

  it('连续投影保持状态序列一致', () => {
    const first = projectTrustedStateMachineEvent(base, transitions, {
      eventId: 'e1',
      event: 'agent.completed',
      expectedRevision: 1,
      source: 'agent'
    })!
    const second = projectTrustedStateMachineEvent(first, transitions, {
      eventId: 'e2',
      event: 'flow.completed',
      expectedRevision: 2,
      source: 'agent'
    })!
    expect(second.state).toBe('completed')
    expect(second.revision).toBe(3)
    expect(second.history.map((h) => h.source)).toEqual(['agent', 'agent'])
  })
})

describe('O1 pending source 校验', () => {
  it('接受 human / agent，拒绝非法 source，缺省兼容', () => {
    expect(
      parseStateMachinePending(
        JSON.stringify({ eventId: 'e', event: 'x', expectedRevision: 1, source: 'agent' })
      )
    ).toMatchObject({ source: 'agent' })
    expect(
      parseStateMachinePending(
        JSON.stringify({ eventId: 'e', event: 'x', expectedRevision: 1, source: 'human' })
      )
    ).toMatchObject({ source: 'human' })
    expect(
      parseStateMachinePending(
        JSON.stringify({ eventId: 'e', event: 'x', expectedRevision: 1, source: 'bogus' })
      )
    ).toBeNull()
    expect(
      parseStateMachinePending(JSON.stringify({ eventId: 'e', event: 'x', expectedRevision: 1 }))
    ).toMatchObject({ eventId: 'e', event: 'x' })
  })
})

describe('O1 执行器事件来源审计', () => {
  const CONFIG = JSON.stringify({
    schemaVersion: 1,
    initialState: 'idle',
    states: ['idle', 'active', 'completed'],
    transitions,
    relations: []
  })
  const run = (
    meta: Record<string, unknown>
  ): { meta: Record<string, unknown>; status: string } => {
    const store: Record<string, unknown> = { ...meta }
    const outcome = stateMachineExecutor({
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
        meta: store
      },
      projectId: 'project-a',
      runId: 'run-sm',
      providers: [],
      signal: { cancelled: false },
      gateway: new Proxy(
        {},
        {
          get: () => {
            throw new Error('状态机执行器不得访问网关')
          }
        }
      ),
      trace: () => undefined,
      updateMeta: (patch: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === null || value === '') delete store[key]
          else store[key] = value
        }
      },
      updateResult: () => undefined
    } as unknown as NodeExecutionContext) as { status: string }
    return { meta: store, status: outcome.status }
  }

  it('人工事件记录 source=human（缺省兼容）', () => {
    const { meta, status } = run({
      stateMachinePending: JSON.stringify({ eventId: 'h1', event: 'agent.completed', expectedRevision: 1 })
    })
    expect(status).toBe('done')
    const instance = parseStateMachineInstance(meta.stateMachine)!
    expect(instance.state).toBe('active')
    expect(instance.history.at(-1)).toMatchObject({ source: 'human' })
  })

  it('可信事件记录 source=agent', () => {
    const { meta, status } = run({
      stateMachinePending: JSON.stringify({
        eventId: 'a1',
        event: 'agent.completed',
        expectedRevision: 1,
        source: 'agent'
      })
    })
    expect(status).toBe('done')
    const instance = parseStateMachineInstance(meta.stateMachine)!
    expect(instance.state).toBe('active')
    expect(instance.history.at(-1)).toMatchObject({ source: 'agent' })
  })
})