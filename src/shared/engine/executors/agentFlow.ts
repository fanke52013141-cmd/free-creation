import type { NodeExecutor } from '../executor-types'
import { newTraceId, newSpanId } from '../../observability'
import {
  AgentNodeConfigSchema,
  FlowStateSchema,
  StateMachineNodeConfigSchema,
  type FlowState
} from '../../agent-flow/node-contracts'
import { flowAgentFailureMessage } from '../../agent-flow/failure-messages'
export const agentExecutor: NodeExecutor = async (ctx) => {
  if (!ctx.gateway.runFlowAgent) return { status: 'failed', reason: '当前宿主未启用画布 Agent' }
  const config = AgentNodeConfigSchema.safeParse(
    (() => {
      try {
        return JSON.parse(ctx.shape.props.config || '{}')
      } catch {
        return null
      }
    })()
  )
  if (!config.success)
    return {
      status: 'failed',
      reason: '当前支持主控与专业 Agent 执行，请检查配置',
      diagnosticPhase: 'input'
    }
  if (config.data.role === 'builder') {
    if (!ctx.gateway.buildFlowAgent) return { status: 'failed', reason: '当前宿主未启用建图' }
    const reply = await ctx.gateway.buildFlowAgent({
      projectId: ctx.projectId,
      nodeId: ctx.node.id,
      action: 'propose',
      requestId: ctx.runId ?? crypto.randomUUID(),
      traceId: ctx.diagnostics?.traceId ?? newTraceId(),
      spanId: ctx.diagnostics?.spanId ?? newSpanId()
    })
    if (!reply.ok)
      return { status: 'failed', reason: reply.error.message, diagnosticPhase: 'execution' }
    ctx.updateResult(null)
    return { status: 'skipped', reason: '建图预览已保存，请在本节点明确提交图变更' }
  }
  const task = (() => {
    try {
      return JSON.parse((ctx.shape.meta as Record<string, unknown>)?.agentTask as string)
    } catch {
      return null
    }
  })()
  const input = {
    projectId: ctx.projectId,
    nodeId: ctx.node.id,
    requestId: ctx.runId ?? crypto.randomUUID(),
    traceId: ctx.diagnostics?.traceId ?? newTraceId(),
    spanId: ctx.diagnostics?.spanId ?? newSpanId(),
    action:
      task?.state === 'blocked' ||
      (task?.state === 'waiting' &&
        task.waitKind === 'reconcile' &&
        config.data.role === 'specialist' &&
        !['FLOW_COMMAND_FACTS_VERIFIED', 'FLOW_VIDEO_RECONCILE_READY'].includes(task.code))
        ? task?.recoveryAction === 'restore'
          ? ('restore' as const)
          : ('reconcile' as const)
        : task?.state === 'waiting' && ctx.runId !== task.taskId
          ? ('continue' as const)
          : ('start' as const),
    ...(task ? { expectedTaskId: task.taskId } : {}),
    ...(['waiting', 'blocked'].includes(task?.state)
      ? { eventId: ctx.runId ?? crypto.randomUUID(), expectedWaitRevision: task.waitRevision }
      : {})
  }
  let stopRequested = false
  const timer = setInterval(() => {
    if (ctx.signal.cancelled && !stopRequested && ctx.gateway.stopFlowAgent) {
      stopRequested = true
      void ctx.gateway
        .stopFlowAgent({ projectId: ctx.projectId, nodeId: ctx.node.id })
        .catch(() => {
          ctx.trace?.('execution', 'error', 'Agent 停止未确认，请核对任务状态')
        })
    }
  }, 100)
  let reply: Awaited<ReturnType<NonNullable<typeof ctx.gateway.runFlowAgent>>>
  try {
    reply = await ctx.gateway.runFlowAgent(input)
  } finally {
    clearInterval(timer)
  }
  if (!reply.ok)
    return { status: 'failed', reason: reply.error.message, diagnosticPhase: 'execution' }
  ctx.updateMeta?.({ agentTask: JSON.stringify(reply.data.task) })
  if (reply.data.task.state !== 'completed') {
    ctx.updateResult(null)
    return {
      status:
        reply.data.task.state === 'waiting' || reply.data.task.state === 'cancelled'
          ? 'skipped'
          : 'failed',
      reason:
        reply.data.task.state === 'waiting'
          ? reply.data.task.waitKind === 'human'
            ? '等待人工确认，请在本节点继续'
            : '执行结果待核对，请确认原命令'
          : flowAgentFailureMessage(reply.data.task.code)
    }
  }
  ctx.updateResult(
    JSON.stringify({
      schemaVersion: 1,
      taskId: reply.data.task.taskId,
      outputs: reply.data.outputs,
      refs: reply.data.refs
    })
  )
  return { status: 'done', artifactOutputPorts: Object.keys(reply.data.outputs) }
}

export const AGENT_FLOW_EXECUTION_PENDING = '配置已开放，执行能力待接入'
export const reviewExecutor: NodeExecutor = async (ctx) => {
  if (!ctx.gateway.reviewFlowAssets) return { status: 'failed', reason: '当前宿主未启用 AI 审核' }
  const reply = await ctx.gateway.reviewFlowAssets({
    projectId: ctx.projectId,
    nodeId: ctx.node.id,
    requestId: ctx.runId ?? crypto.randomUUID(),
    traceId: ctx.diagnostics?.traceId ?? newTraceId(),
    spanId: ctx.diagnostics?.spanId ?? newSpanId()
  })
  if (!reply.ok)
    return { status: 'failed', reason: reply.error.message, diagnosticPhase: 'execution' }
  ctx.updateResult(JSON.stringify(reply.data))
  return { status: 'done' }
}
/** C1 is configuration-only: no gateway call, state mutation or fabricated output. */
export const agentFlowPendingExecutor: NodeExecutor = () => ({
  status: 'skipped',
  reason: AGENT_FLOW_EXECUTION_PENDING
})

// ── 状态机节点独立执行（P2-A 首版：人工事件驱动）──
//
// 迁移权威是一份持久化状态机实例（meta.stateMachine），只有本执行器会推进它；
// UI 只能把「人工提交事件」写进 meta.stateMachinePending，类似聊天面板只写
// 待发送消息。事件来源首版仅限人工提交：模型/上游数据没有把状态改成成功的
// 通道，满足协同规范“模型文字不能直接赋予成功状态”的首版门槛。
// revision 随每次迁移单调递增；提交时携带 expectedRevision，过期提交按
// 修订冲突拒绝。lastEventId 提供事件去重。配置漂移（当前状态不在声明列表）
// 显式失败，不做静默猜测迁移。

export interface StateMachineInstance {
  schemaVersion: 1
  /** 状态机实例绑定的任务标识；首版派生自节点 ID，保存重开保持稳定。 */
  taskId: string
  stateNodeId: string
  revision: number
  state: string
  lastEventId?: string
  /** 已应用的事件历史（仅 ID/事件/迁移/修订，不含用户正文）。 */
  history: Array<{
    eventId: string
    event: string
    from: string
    to: string
    revision: number
    at: number
  }>
}

export interface StateMachinePendingEvent {
  eventId: string
  event: string
  expectedRevision: number
}

const STATE_MACHINE_MAX_HISTORY = 200

export function parseStateMachineInstance(raw: unknown): StateMachineInstance | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const value = JSON.parse(raw) as StateMachineInstance
    if (
      value?.schemaVersion !== 1 ||
      typeof value.taskId !== 'string' ||
      typeof value.stateNodeId !== 'string' ||
      typeof value.revision !== 'number' ||
      !Number.isInteger(value.revision) ||
      value.revision < 1 ||
      typeof value.state !== 'string' ||
      !Array.isArray(value.history)
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

export function parseStateMachinePending(raw: unknown): StateMachinePendingEvent | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const value = JSON.parse(raw) as StateMachinePendingEvent
    if (typeof value?.eventId !== 'string' || !value.eventId) return null
    if (typeof value?.event !== 'string' || !value.event) return null
    if (typeof value?.expectedRevision !== 'number' || !Number.isInteger(value.expectedRevision)) {
      return null
    }
    return value
  } catch {
    return null
  }
}

/** 正式 out-state 输出：持久化实例 → flow.state@1 契约（严格字段）。 */
export function stateMachineFlowState(instance: StateMachineInstance): FlowState {
  return FlowStateSchema.parse({
    schemaVersion: 1,
    taskId: instance.taskId,
    stateNodeId: instance.stateNodeId,
    revision: instance.revision,
    state: instance.state,
    ...(instance.lastEventId ? { lastEventId: instance.lastEventId } : {})
  })
}

export const stateMachineExecutor: NodeExecutor = (ctx) => {
  const meta = ctx.shape.meta
  const parsedConfig = StateMachineNodeConfigSchema.safeParse(
    (() => {
      try {
        return JSON.parse(ctx.shape.props.config || '{}')
      } catch {
        return null
      }
    })()
  )
  if (!parsedConfig.success) {
    return { status: 'failed', reason: '状态机配置无效，请在设置中修复', diagnosticPhase: 'input' }
  }
  const config = parsedConfig.data
  const states = new Set(config.states)

  // 1) 读取或初始化权威实例。迁移在闭包里重绑定，用 ref 保持单一权威引用。
  const instanceRef: { current: StateMachineInstance } = { current: null as never }
  const existing = parseStateMachineInstance(meta?.stateMachine)
  if (existing && existing.stateNodeId !== ctx.node.id) {
    return {
      status: 'failed',
      reason: '状态机实例与节点不匹配，请重置本节点的状态机任务后重试',
      diagnosticPhase: 'input'
    }
  }
  instanceRef.current = existing ?? {
    schemaVersion: 1,
    taskId: `state-machine:${ctx.node.id}`,
    stateNodeId: ctx.node.id,
    revision: 1,
    state: config.initialState,
    history: []
  }
  if (!states.has(instanceRef.current.state)) {
    return {
      status: 'failed',
      reason: `当前阶段「${instanceRef.current.state}」已不在声明的阶段列表中；请修改配置或重置状态机任务`,
      diagnosticPhase: 'input'
    }
  }

  // 2) 应用待处理的人工提交事件（若有）。损坏的提交按输入失败处理，
  // 不静默当作「没有事件」——那会掩盖一次真实的用户操作。
  const pendingRaw = meta?.stateMachinePending
  if (typeof pendingRaw === 'string' && pendingRaw.trim() && !parseStateMachinePending(pendingRaw)) {
    return {
      status: 'failed',
      reason: '待应用的事件提交格式无效；请在本卡片重新提交该事件',
      diagnosticPhase: 'input'
    }
  }
  const pending = parseStateMachinePending(pendingRaw)
  let transitionApplied = ''
  if (pending) {
    if (pending.expectedRevision !== instanceRef.current.revision) {
      return {
        status: 'failed',
        reason: `状态修订冲突：提交基于修订 ${pending.expectedRevision}，当前已是修订 ${instanceRef.current.revision}。请在卡片重新提交该事件`,
        diagnosticPhase: 'input'
      }
    }
    if (
      instanceRef.current.lastEventId &&
      pending.eventId === instanceRef.current.lastEventId
    ) {
      return {
        status: 'failed',
        reason: '该事件已应用到当前状态，无需重复提交',
        diagnosticPhase: 'input'
      }
    }
    const transition = config.transitions.find(
      (item) => item.from === instanceRef.current.state && item.event === pending.event
    )
    if (!transition) {
      return {
        status: 'failed',
        reason: `未声明的转换：当前阶段「${instanceRef.current.state}」不存在事件「${pending.event}」`,
        diagnosticPhase: 'input'
      }
    }
    const nextRevision = instanceRef.current.revision + 1
    const applied: StateMachineInstance = {
      ...instanceRef.current,
      state: transition.to,
      revision: nextRevision,
      lastEventId: pending.eventId,
      history: [
        ...instanceRef.current.history,
        {
          eventId: pending.eventId,
          event: pending.event,
          from: transition.from,
          to: transition.to,
          revision: nextRevision,
          at: Date.now()
        }
      ].slice(-STATE_MACHINE_MAX_HISTORY)
    }
    instanceRef.current = applied
    transitionApplied = pending.event
    ctx.trace?.('execution', 'info', `状态迁移 ${transition.from} -> ${transition.to}（事件 ${pending.event}，修订 ${nextRevision}）`)
    // tldraw 对 meta 是浅合并：删键不生效，用空串表示「已消费」（解析侧视为无事件）。
    ctx.updateMeta?.({ stateMachinePending: '' })
  }

  // 3) 持久化实例并投影正式 out-state 输出。
  const finalInstance = instanceRef.current
  ctx.updateMeta?.({ stateMachine: JSON.stringify(finalInstance) })
  const flowState = stateMachineFlowState(finalInstance)
  ctx.updateResult(JSON.stringify(flowState))
  if (!transitionApplied) {
    ctx.trace?.(
      'execution',
      'info',
      `状态机处于阶段「${finalInstance.state}」（修订 ${finalInstance.revision}），没有待应用事件`
    )
  }
  return { status: 'done' }
}
