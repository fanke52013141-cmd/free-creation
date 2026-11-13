// O2 只读收件箱聚合：human-task 待提交 / collaborative Agent 待人工确认进入清单；
// 已完成、纯自主、运行中、其他节点不进入。纯函数，不改任何状态。
import { describe, expect, it } from 'vitest'
import { deriveHumanInbox, type HumanInboxShape } from '@shared/agent-flow/human-inbox'

const agentConfig = (interactionMode: 'collaborative' | 'autonomous'): string =>
  JSON.stringify({
    schemaVersion: 1,
    role: 'specialist',
    interactionMode,
    skills: [],
    tools: [],
    allowedNodeIds: [],
    maxSteps: 12,
    relations: []
  })

const humanTask = (status: 'pending' | 'completed'): string =>
  JSON.stringify({ schemaVersion: 1, nodeId: 'n', revision: 1, status })

const shape = (
  id: string,
  nodeType: string,
  opts: { config?: string; meta?: Record<string, unknown>; title?: string } = {}
): HumanInboxShape => ({
  id,
  props: { nodeType, title: opts.title ?? id, config: opts.config },
  meta: opts.meta
})

describe('O2 待你处理收件箱聚合（只读）', () => {
  it('human-task pending 进入清单', () => {
    const items = deriveHumanInbox([
      shape('h1', 'human-task', { meta: { humanTask: humanTask('pending') }, title: '终审' })
    ])
    expect(items).toEqual([
      { nodeId: 'h1', title: '终审', kind: 'human-task', reason: '待提交人工结果' }
    ])
  })

  it('human-task 无实例视为待提交', () => {
    expect(deriveHumanInbox([shape('h1', 'human-task')]).map((i) => i.nodeId)).toEqual(['h1'])
  })

  it('human-task completed 不进入清单', () => {
    expect(
      deriveHumanInbox([shape('h1', 'human-task', { meta: { humanTask: humanTask('completed') } })])
    ).toEqual([])
  })

  it('collaborative Agent 等待人工进入清单', () => {
    const items = deriveHumanInbox([
      shape('a1', 'agent', {
        config: agentConfig('collaborative'),
        meta: { agentTask: JSON.stringify({ state: 'waiting', waitKind: 'human' }) },
        title: '框架专家'
      })
    ])
    expect(items).toEqual([
      { nodeId: 'a1', title: '框架专家', kind: 'collaborative-agent', reason: '待人工确认 / 讨论' }
    ])
  })

  it('autonomous Agent 不进入清单（即使 waiting）', () => {
    expect(
      deriveHumanInbox([
        shape('a1', 'agent', {
          config: agentConfig('autonomous'),
          meta: { agentTask: JSON.stringify({ state: 'waiting', waitKind: 'human' }) }
        })
      ])
    ).toEqual([])
  })

  it('collaborative Agent 运行中不进入清单', () => {
    expect(
      deriveHumanInbox([
        shape('a1', 'agent', {
          config: agentConfig('collaborative'),
          meta: { agentTask: JSON.stringify({ state: 'running', waitKind: null }) }
        })
      ])
    ).toEqual([])
  })

  it('其他节点类型不进入清单', () => {
    expect(deriveHumanInbox([shape('t1', 'text'), shape('s1', 'state-machine')])).toEqual([])
  })

  it('混合场景保持画布顺序', () => {
    const items = deriveHumanInbox([
      shape('h1', 'human-task', { meta: { humanTask: humanTask('pending') } }),
      shape('t1', 'text'),
      shape('a1', 'agent', {
        config: agentConfig('collaborative'),
        meta: { agentTask: JSON.stringify({ state: 'waiting', waitKind: 'human' }) }
      }),
      shape('h2', 'human-task', { meta: { humanTask: humanTask('completed') } })
    ])
    expect(items.map((i) => i.nodeId)).toEqual(['h1', 'a1'])
  })
})