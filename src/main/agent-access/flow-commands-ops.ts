// F8（二）Flow 命令账本协作的外部实现。
//
// 边界（与 docs/local-agent-access/29-flow-commands-delivery.md 第 1 节一致）：
// - 只操作**既有**的 flow_commands 行，从不创建命令/租约，也不向渲染器下发 grant；
// - 读回执、跑同一占用/审核门禁、按已保存运行事实调用账本自己的 commit；
// - 外部没有 leaseId / owner_session 写口，所以不存在冒充内部 Agent 会话的路径；
// - unknown 如实返回：commit 无法从已保存事实确认时，保留 pending/unknown 并给出稳定原因码，
//   绝不把 unknown 结算成 success，也不把任何回执改写成调用方声称的状态。
// 复用同一个 FlowCommandLedger 类与数据库表，不直写 SQLite、不复制账本规则。
import type { AccessOperationId } from '../../shared/agent-access/registry'
import {
  FlowCommandError,
  type FlowCommandReceipt
} from '../../shared/agent-flow/commands'
import { FlowAssetError } from '../../shared/agent-flow/assets'
import { FlowCommandLedger } from '../agent-flow/command-ledger'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { getDb } from '../store/db'
import * as projects from '../store/projects.repo'
import { DesktopAccessError } from './desktop'

export type FlowCommandOperationId =
  | 'flow.command.lookup'
  | 'flow.command.availability'
  | 'flow.command.reconcile'

const FLOW_COMMAND_OPERATIONS: ReadonlySet<AccessOperationId> = new Set<AccessOperationId>([
  'flow.command.lookup',
  'flow.command.availability',
  'flow.command.reconcile'
])

export function isFlowCommandOperation(
  id: AccessOperationId
): id is FlowCommandOperationId {
  return FLOW_COMMAND_OPERATIONS.has(id)
}

export interface FlowCommandOperationContext {
  /** agent.access 的 trace/span，供账本阶段事件关联；不新增事件类型。 */
  traceId: string
  spanId: string
}

type CommandEventStage = 'started' | 'completed' | 'failed'

function emitCommandOperation(
  stage: CommandEventStage,
  phase: string,
  context: FlowCommandOperationContext,
  subject: { projectId?: string; nodeId?: string; taskId?: string; runId?: string },
  attributes: Record<string, unknown>,
  options: { status?: 'success' | 'failed' | 'skipped' | 'unknown'; durationMs?: number } = {}
): void {
  emitGatewayEvent(
    `command.operation.${stage}`,
    '外部命令账本操作',
    {
      traceId: context.traceId,
      spanId: context.spanId,
      ...(subject.projectId ? { projectId: subject.projectId } : {}),
      ...(subject.nodeId ? { nodeId: subject.nodeId } : {}),
      ...(subject.taskId ? { taskId: subject.taskId } : {}),
      ...(subject.runId ? { runId: subject.runId } : {})
    },
    {
      ...(options.status ? { status: options.status } : {}),
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
      attributes: { phase, ...attributes }
    }
  )
}

function refuse(code: string, phase: string, detail?: string): never {
  throw new DesktopAccessError(
    code,
    false,
    `${phase}${detail ? `:${detail.slice(0, 200)}` : ''}`
  )
}

/** main 侧唯一账本实现；每次调用都复用同一个类，不缓存会话（本包不做任何账本写入身份）。 */
function ledger(): FlowCommandLedger {
  return new FlowCommandLedger(getDb(), projects.openProject)
}

function externalCode(error: unknown): string {
  if (
    error instanceof DesktopAccessError ||
    error instanceof FlowCommandError ||
    error instanceof FlowAssetError
  )
    return error.code
  return 'STORAGE_UNAVAILABLE'
}

/** 账本缺失语义 → 外部稳定的 NOT_FOUND（不泄漏"命令属于别的项目"这一区别）。 */
function translateLookupError(error: unknown): unknown {
  if (error instanceof FlowCommandError) {
    if (error.code === 'FLOW_COMMAND_MISSING' || error.code === 'FLOW_PROJECT_MISSING')
      return new DesktopAccessError('NOT_FOUND', false, 'command-read')
    return error
  }
  return error
}

/** 只投影回执的受控字段；命令输入清单、用户正文与资产值不进入外部回执。 */
function receiptDto(receipt: FlowCommandReceipt): unknown {
  return {
    projectId: receipt.projectId,
    commandId: receipt.commandId,
    taskId: receipt.taskId,
    targetNodeId: receipt.targetNodeId,
    state: receipt.state,
    runId: receipt.runId,
    ...(receipt.nodeExecutionId ? { nodeExecutionId: receipt.nodeExecutionId } : {}),
    ...(receipt.inputFingerprint ? { inputFingerprint: receipt.inputFingerprint } : {}),
    outputRefs: receipt.outputRefs.map((ref) => ({
      assetId: ref.assetId,
      versionId: ref.versionId,
      sourceNodeId: ref.sourceNodeId,
      sourcePortId: ref.sourcePortId
    })),
    ...(receipt.graphVersion !== undefined ? { graphVersion: receipt.graphVersion } : {}),
    ...(receipt.code ? { code: receipt.code } : {})
  }
}

function lookup(
  input: Record<string, unknown>,
  context: FlowCommandOperationContext
): unknown {
  const projectId = input.projectId as string
  const commandId = input.commandId as string
  const startedAt = performance.now()
  const subject = { projectId, commandId }
  emitCommandOperation('started', 'lookup', context, subject, { commandId })
  let receipt: FlowCommandReceipt
  try {
    receipt = ledger().lookup({ projectId, commandId })
  } catch (error) {
    const translated = translateLookupError(error)
    emitCommandOperation(
      'failed',
      'lookup',
      context,
      subject,
      { commandId, code: externalCode(translated) },
      { status: 'failed' }
    )
    throw translated
  }
  emitCommandOperation(
    'completed',
    'lookup',
    context,
    { ...subject, nodeId: receipt.targetNodeId, taskId: receipt.taskId, runId: receipt.runId },
    {
      commandId,
      state: receipt.state,
      ...(receipt.outputRefs[0] ? { versionId: receipt.outputRefs[0].versionId } : {})
    },
    { status: 'success', durationMs: Math.round(performance.now() - startedAt) }
  )
  return receiptDto(receipt)
}

function availability(
  input: Record<string, unknown>,
  context: FlowCommandOperationContext
): unknown {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const startedAt = performance.now()
  const subject = { projectId, nodeId }
  emitCommandOperation('started', 'manual-occupancy', context, subject, {})
  try {
    const file = projects.openProject(projectId)
    if (!file) refuse('NOT_FOUND', 'project-read')
    if (!file.nodes.some((node) => node.id === nodeId)) refuse('NODE_NOT_FOUND', 'node-read')
    // 与 GUI 手动运行前完全相同的账本门禁（占用/控制范围/审核）。
    ledger().assertNodeAvailable({ projectId, nodeId })
    emitCommandOperation(
      'completed',
      'manual-occupancy',
      context,
      subject,
      {},
      { status: 'success', durationMs: Math.round(performance.now() - startedAt) }
    )
    return { projectId, nodeId, graphVersion: file.meta.graphVersion, available: true as const }
  } catch (error) {
    const translated =
      error instanceof FlowCommandError
        ? error.code === 'FLOW_PROJECT_MISSING'
          ? new DesktopAccessError('NOT_FOUND', false, 'project-read')
          : error.code === 'FLOW_NODE_MISSING'
            ? // 门禁读取审核节点快照失败：项目快照不完整，而不是被查询节点不存在。
              new DesktopAccessError('STORAGE_INCONSISTENT', false, 'review-snapshot')
            : new DesktopAccessError(error.code, false, error.phase)
        : error
    emitCommandOperation(
      'failed',
      'manual-occupancy',
      context,
      subject,
      { code: externalCode(translated) },
      { status: 'failed' }
    )
    throw translated
  }
}

function reconcile(
  input: Record<string, unknown>,
  context: FlowCommandOperationContext
): unknown {
  const projectId = input.projectId as string
  const commandId = input.commandId as string
  const startedAt = performance.now()
  const subject = { projectId, commandId }
  emitCommandOperation('started', 'saved-receipt', context, subject, { commandId })
  const instance = ledger()
  let receipt: FlowCommandReceipt
  try {
    receipt = instance.lookup({ projectId, commandId })
  } catch (error) {
    const translated = translateLookupError(error)
    emitCommandOperation(
      'failed',
      'saved-receipt',
      context,
      subject,
      { commandId, code: externalCode(translated) },
      { status: 'failed' }
    )
    throw translated
  }
  let commitAttempted = false
  let reason: string | undefined
  if (receipt.state === 'pending' || receipt.state === 'unknown') {
    commitAttempted = true
    try {
      receipt = instance.commit({ projectId, commandId })
    } catch (error) {
      // 只有账本/资产事实错误才表示"尚无法确认"；此时保留原回执，不伪造失败或成功。
      if (error instanceof FlowCommandError || error instanceof FlowAssetError) {
        reason = error.code
        try {
          receipt = instance.lookup({ projectId, commandId })
        } catch (readError) {
          const translated = translateLookupError(readError)
          emitCommandOperation(
            'failed',
            'saved-receipt',
            context,
            subject,
            { commandId, code: externalCode(translated) },
            { status: 'failed' }
          )
          throw translated
        }
      } else throw error
    }
  }
  emitCommandOperation(
    'completed',
    'saved-receipt',
    context,
    { ...subject, nodeId: receipt.targetNodeId, taskId: receipt.taskId, runId: receipt.runId },
    {
      commandId,
      state: receipt.state,
      ...(receipt.outputRefs[0] ? { versionId: receipt.outputRefs[0].versionId } : {})
    },
    {
      status:
        receipt.state === 'committed'
          ? 'success'
          : receipt.state === 'pending' || receipt.state === 'unknown'
            ? 'unknown'
            : 'failed',
      durationMs: Math.round(performance.now() - startedAt)
    }
  )
  return {
    projectId,
    commandId,
    state: receipt.state,
    commitAttempted,
    ...(reason ? { reason } : {}),
    receipt: receiptDto(receipt)
  }
}

/** dispatch 分组分支的唯一入口；operationId 已由 isFlowCommandOperation 收窄。 */
export function runFlowCommandOperation(
  operationId: FlowCommandOperationId,
  input: Record<string, unknown>,
  context: FlowCommandOperationContext
): unknown {
  switch (operationId) {
    case 'flow.command.lookup':
      return lookup(input, context)
    case 'flow.command.availability':
      return availability(input, context)
    case 'flow.command.reconcile':
      return reconcile(input, context)
  }
}
