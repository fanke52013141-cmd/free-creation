import type { NodeExecutor } from '../executor-types'
import { parseStoredNodeValue, type NodeValue } from '../values'
import {
  HumanTaskNodeConfigSchema,
  HumanTaskInstanceSchema,
  HumanTaskPendingSchema,
  type HumanTaskInstance
} from '../../agent-flow/node-contracts'

/**
 * C4 纯人工任务节点执行器（停等语义）：
 * - 无模型参与；UI/外部 op 只写 meta.humanTaskPending，执行器是唯一推进权威。
 * - 未提交结果时返回 skipped（等待人工），不伪造成功；全局运行遇此节点停等。
 * - 人工提交经 expectedRevision 防过期 + submissionId 去重；完成后投影正式 out-text/out-json。
 * - 复用状态机范式：tldraw meta 浅合并，消费 pending 用空串（删键不生效）。
 */
export const humanTaskExecutor: NodeExecutor = async (ctx) => {
  const config = HumanTaskNodeConfigSchema.safeParse(
    (() => {
      try {
        return JSON.parse(ctx.shape.props.config || '{}')
      } catch {
        return null
      }
    })()
  )
  if (!config.success)
    return { status: 'failed', reason: '人工任务配置无效，请在设置中修复', diagnosticPhase: 'input' }

  const meta = ctx.shape.meta as Record<string, unknown> | undefined
  const existing = (() => {
    const raw = meta?.humanTask
    if (typeof raw !== 'string' || !raw.trim()) return null
    const parsed = HumanTaskInstanceSchema.safeParse(
      (() => {
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      })()
    )
    return parsed.success ? parsed.data : null
  })()
  if (existing && existing.nodeId !== ctx.node.id)
    return {
      status: 'failed',
      reason: '人工任务实例与节点不匹配，请重置本节点任务后重试',
      diagnosticPhase: 'input'
    }

  const newScope = Boolean(ctx.humanTaskScope && existing?.scope !== ctx.humanTaskScope)
  if (newScope && existing) {
    ctx.updateMeta?.({
      humanTask: JSON.stringify({
        schemaVersion: 1,
        nodeId: String(ctx.node.id),
        revision: existing.revision + 1,
        status: 'pending',
        scope: ctx.humanTaskScope
      }),
      humanTaskPending: ''
    })
    return { status: 'skipped', reason: '等待人工提交' }
  }
  const instance: HumanTaskInstance = existing ?? {
    schemaVersion: 1,
    nodeId: String(ctx.node.id),
    revision: 1,
    status: 'pending',
    scope: ctx.humanTaskScope
  }

  // 待应用的人工提交：损坏的提交按输入失败处理，不静默当作「没有提交」。
  const pendingRaw = meta?.humanTaskPending
  if (typeof pendingRaw === 'string' && pendingRaw.trim()) {
    const parsedPending = HumanTaskPendingSchema.safeParse(
      (() => {
        try {
          return JSON.parse(pendingRaw)
        } catch {
          return null
        }
      })()
    )
    if (!parsedPending.success)
      return {
        status: 'failed',
        reason: '待应用的人工提交格式无效；请在本卡片重新提交',
        diagnosticPhase: 'input'
      }
    const pending = parsedPending.data
    if (pending.expectedRevision !== instance.revision)
      return {
        status: 'failed',
        reason: `人工任务修订冲突：提交基于修订 ${pending.expectedRevision}，当前已是修订 ${instance.revision}。请重新提交`,
        diagnosticPhase: 'input'
      }
    if (instance.lastSubmissionId && pending.submissionId === instance.lastSubmissionId)
      return {
        status: 'failed',
        reason: '该提交已应用，无需重复提交',
        diagnosticPhase: 'input'
      }
    const expectedKind = config.data.outputType
    if (pending.value.kind !== expectedKind)
      return {
        status: 'failed',
        reason: `人工提交类型与节点声明不符：节点要求 ${expectedKind}，提交为 ${pending.value.kind}`,
        diagnosticPhase: 'input'
      }
    const value = pending.value
    const output = value.kind === 'image' || value.kind === 'video'
      ? await ctx.resolveHumanTaskMedia?.(value.kind, value.mediaId)
      : value
    if (!output)
      return { status: 'failed', reason: '人工提交的媒体不在当前项目中或类型不符', diagnosticPhase: 'input' }
    const applied: HumanTaskInstance = {
      ...instance,
      revision: instance.revision + 1,
      status: 'completed',
      result: pending.value,
      handoffNote: pending.handoffNote,
      lastSubmissionId: pending.submissionId,
      submittedAt: Date.now(),
      actor: { kind: 'user', roleId: config.data.humanRole ?? 'owner' }
    }
    ctx.updateMeta?.({ humanTask: JSON.stringify(applied), humanTaskPending: '' })
    ctx.updateResult(JSON.stringify(output))
    ctx.trace?.('execution', 'info', `人工任务完成（修订 ${applied.revision}）`)
    return { status: 'done' }
  }

  // 无待提交：已完成则投影既有结果；否则停等（skipped，不伪造成功）。
  ctx.updateMeta?.({ humanTask: JSON.stringify(instance) })
  if (instance.status === 'completed' && instance.result) {
    const result = instance.result
    if (result.kind !== config.data.outputType)
      return { status: 'skipped', reason: '结果类型已更改，请重新提交', diagnosticPhase: 'input' }
    const output = result.kind === 'image' || result.kind === 'video'
      ? await ctx.resolveHumanTaskMedia?.(result.kind, result.mediaId)
      : result
    if (!output)
      return { status: 'failed', reason: '人工交付媒体不可用，请重新提交', diagnosticPhase: 'input' }
    ctx.updateResult(JSON.stringify(output))
    return { status: 'done' }
  }
  ctx.updateResult(null)
  return {
    status: 'skipped',
    reason: '等待人工提交结果，请在本节点提交后继续',
    diagnosticPhase: 'execution'
  }
}

/** 正式输出投影：仅 completed 的人工任务结果按声明端口投影，未提交不产生输出。 */
export function projectHumanTaskOutputs(shape: {
  props?: { config?: string }
  meta?: Record<string, unknown>
}): Record<string, NodeValue> {
  const raw = shape.meta?.humanTask
  if (typeof raw !== 'string' || !raw.trim()) return {}
  const parsed = HumanTaskInstanceSchema.safeParse(
    (() => {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    })()
  )
  if (!parsed.success || parsed.data.status !== 'completed' || !parsed.data.result) return {}
  const result = parsed.data.result
  if (result.kind === 'text') return { 'out-text': { kind: 'text', text: result.text } }
  if (result.kind === 'json') return { 'out-json': { kind: 'json', data: result.data } }
  const saved = typeof shape.meta?.nodeResult === 'string'
    ? parseStoredNodeValue(shape.meta.nodeResult)
    : null
  return saved?.kind === result.kind && saved.mediaId === result.mediaId
    ? { [`out-${result.kind}`]: saved }
    : {}
}
