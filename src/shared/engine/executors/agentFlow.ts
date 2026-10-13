import type { NodeExecutor } from '../executor-types'
import { newTraceId, newSpanId } from '../../observability'
import { AgentNodeConfigSchema } from '../../agent-flow/node-contracts'
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
  if (!config.success || config.data.role !== 'specialist')
    return {
      status: 'failed',
      reason: '当前仅专业 Agent 已接入任务执行，请检查配置',
      diagnosticPhase: 'input'
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
    action: task?.state === 'waiting' ? ('continue' as const) : ('start' as const),
    ...(task?.state === 'waiting' ? { eventId: ctx.runId ?? crypto.randomUUID() } : {})
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
/** C1 is configuration-only: no gateway call, state mutation or fabricated output. */
export const agentFlowPendingExecutor: NodeExecutor = () => ({
  status: 'skipped',
  reason: AGENT_FLOW_EXECUTION_PENDING
})
