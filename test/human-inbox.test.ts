// O2 只读收件箱聚合：human-task 待提交 / collaborative Agent 待人工确认进入清单；
// 已完成、纯自主、运行中、其他节点不进入。纯函数，不改任何状态。
import { describe, expect, it } from 'vitest'
import {
  deriveHumanInbox,
  humanInboxFromOverview,
  humanInboxFromSteps,
  mergeHumanInbox,
  type HumanInboxShape
} from '@shared/agent-flow/human-inbox'

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

  // A1：主控 Agent 等待人工采用也属于"待你处理"。
  it('A1：主控 Agent 等待人工采用进入清单', () => {
    const coordinatorConfig = JSON.stringify({
      schemaVersion: 1,
      role: 'coordinator',
      interactionMode: 'autonomous',
      skills: [],
      tools: [],
      allowedNodeIds: [],
      maxSteps: 12,
      relations: []
    })
    const items = deriveHumanInbox([
      shape('c1', 'agent', {
        config: coordinatorConfig,
        meta: {
          agentTask: JSON.stringify({ state: 'waiting', waitKind: 'human', waitReason: 'human' })
        },
        title: '主控 Agent'
      })
    ])
    expect(items).toEqual([
      { nodeId: 'c1', title: '主控 Agent', kind: 'coordinator', reason: '阶段待人工采用 / 确认' }
    ])
  })

  // A3：waitReason 不是 human 时，即使 state=waiting 也不能进收件箱（假待办）。
  it('A3：在途子任务/待审核/受阻的等待不进入清单', () => {
    for (const waitReason of ['active-child', 'pending-review', 'blocked', 'paused']) {
      const items = deriveHumanInbox([
        shape('a1', 'agent', {
          config: agentConfig('collaborative'),
          meta: {
            agentTask: JSON.stringify({ state: 'waiting', waitKind: 'human', waitReason })
          }
        })
      ])
      expect(items, `waitReason=${waitReason}`).toEqual([])
    }
  })

  // A3 兼容：旧数据没有 waitReason，仍按 waitKind 判定。
  it('A3：旧数据缺 waitReason 时回退 waitKind', () => {
    const items = deriveHumanInbox([
      shape('a1', 'agent', {
        config: agentConfig('collaborative'),
        meta: { agentTask: JSON.stringify({ state: 'waiting', waitKind: 'human' }) }
      })
    ])
    expect(items.map((i) => i.kind)).toEqual(['collaborative-agent'])
  })

  it('A1：自主专业 Agent 等待人工采用不进入清单', () => {
    expect(
      deriveHumanInbox([
        shape('a1', 'agent', {
          config: agentConfig('autonomous'),
          meta: {
            agentTask: JSON.stringify({ state: 'waiting', waitKind: 'human', waitReason: 'human' })
          }
        })
      ])
    ).toEqual([])
  })
})

describe('A1 运行总览来源与合并', () => {
  it('needsYou 的审核步骤进入清单，普通步骤不进入', () => {
    const items = humanInboxFromSteps([
      { nodeId: 'r1', title: '终审', kind: 'review', state: 'waiting-human', needsYou: true },
      { nodeId: 'a1', title: '写作', kind: 'agent', state: 'running', needsYou: false },
      { nodeId: 'h1', title: '人工补料', kind: 'human-task', state: 'waiting-human', needsYou: true }
    ])
    expect(items).toEqual([
      { nodeId: 'r1', title: '终审', kind: 'review', reason: '待人工复审 / 返工确认' },
      { nodeId: 'h1', title: '人工补料', kind: 'human-task', reason: '待提交人工结果' }
    ])
  })

  it('缺必需材料的阻塞标为待补输入，技术失败不算', () => {
    const blocked = humanInboxFromOverview(
      { nodeId: 'c1', state: 'blocked', code: 'FLOW_CONTEXT_REQUIRED_MISSING' },
      []
    )
    expect(blocked).toEqual([
      {
        nodeId: 'c1',
        title: '主控流程',
        kind: 'input',
        reason: '待补充输入（FLOW_CONTEXT_REQUIRED_MISSING）'
      }
    ])
    // 普通技术失败 / 非阻塞态不能变成"人要做的事"
    expect(
      humanInboxFromOverview({ nodeId: 'c1', state: 'blocked', code: 'AGENT_MODEL_FAILED' }, [])
    ).toEqual([])
    expect(
      humanInboxFromOverview(
        { nodeId: 'c1', state: 'running', code: 'FLOW_CONTEXT_REQUIRED_MISSING' },
        []
      )
    ).toEqual([])
  })

  it('合并按节点去重且画布实时事实优先', () => {
    const merged = mergeHumanInbox(
      [{ nodeId: 'a1', title: '画布标题', kind: 'collaborative-agent', reason: '待人工确认 / 讨论' }],
      [
        { nodeId: 'a1', title: '总览标题', kind: 'review', reason: '待人工复审 / 返工确认' },
        { nodeId: 'r1', title: '终审', kind: 'review', reason: '待人工复审 / 返工确认' }
      ]
    )
    expect(merged).toEqual([
      { nodeId: 'a1', title: '画布标题', kind: 'collaborative-agent', reason: '待人工确认 / 讨论' },
      { nodeId: 'r1', title: '终审', kind: 'review', reason: '待人工复审 / 返工确认' }
    ])
  })
})