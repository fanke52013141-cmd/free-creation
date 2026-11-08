// F8（二/收官）Flow 命令账本协作的外部实现。
//
// 边界（与 docs/local-agent-access/29-flow-commands-delivery.md 第 1、9 节一致）：
// - 读/结算类（lookup/availability/reconcile/check）只操作**既有**的 flow_commands 行；
// - 派发类（dispatch）经共享权威端口 `flow-command-bridge.ts` 复用 registerFlowCommandsIpc
//   那一个账本会话：main 生成命令/任务/运行身份、先 flush 再按已保存图计算语义版本、
//   以 principal='external' 入库，并沿用既有渲染器 grant 通道执行；外部不能自造身份；
// - 放弃类（abort）只允许外部主体放弃自己创建且**从未准入**的命令；
// - unknown 如实返回：commit 无法从已保存事实确认时，保留 pending/unknown 并给出稳定原因码，
//   绝不把 unknown 结算成 success，也不把任何回执改写成调用方声称的状态；
// - check 是**只读预演**：在回滚事务内复用账本 commit 规则，只告诉调用方"现在结算会得到什么"，
//   不落账；真正的结算仍必须经 reconcile（写 + 幂等键）。
// 不直写 SQLite、不复制账本规则、不另建账本实例。
import { randomUUID } from 'node:crypto'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import {
  FlowCommandError,
  NodeExecuteCommandSchema,
  type FlowCommandReceipt,
  type NodeExecuteCommand
} from '../../shared/agent-flow/commands'
import { FlowAssetError } from '../../shared/agent-flow/assets'
import { FlowCommandLedger } from '../agent-flow/command-ledger'
import { projectSemanticRevision } from '../agent-flow/command-intent'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { getDb } from '../store/db'
import * as projects from '../store/projects.repo'
import { DesktopAccessError, type AccessDesktop } from './desktop'
import { flowCommandAccessPort, type FlowCommandAccessPort } from './flow-command-bridge'

export type FlowCommandOperationId =
  | 'flow.command.lookup'
  | 'flow.command.availability'
  | 'flow.command.reconcile'
  | 'flow.command.check'
  | 'flow.command.dispatch'
  | 'flow.command.abort'

const FLOW_COMMAND_OPERATIONS: ReadonlySet<AccessOperationId> = new Set<AccessOperationId>([
  'flow.command.lookup',
  'flow.command.availability',
  'flow.command.reconcile',
  'flow.command.check',
  'flow.command.dispatch',
  'flow.command.abort'
])

/** 会触发真实供应商请求的目标类型：外部派发必须显式确认（与 node.execute 付费重跑同原则）。 */
const PAID_TARGET_TYPES: ReadonlySet<string> = new Set([
  'video',
  'image-gen',
  'image-edit',
  'speech',
  'tts',
  'voice-design'
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
  /** 当前活动画布；dispatch 要求它与目标项目一致（命令必须交给权威渲染器执行）。 */
  activeProjectId: () => string | null
  /** 受控桌面握手：dispatch 先用既有 flush 语义把画布协调到可计算的版本。 */
  desktop?: AccessDesktop
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

/** 回滚标记：只用于让预演事务无条件回滚，不携带任何业务信息。 */
class PreviewRollback extends Error {}

/**
 * 只读预演：在回滚事务内调用账本自己的 commit，得到"若现在结算会落到什么状态"，
 * 随后整体回滚。命令回执、输出版本与占用事实都不会落库；真正结算只由 reconcile 执行。
 * 复用同一 commit 规则（不复制），因此预演结论与随后的 reconcile 一致。
 */
function previewSettlement(
  instance: FlowCommandLedger,
  input: { projectId: string; commandId: string }
): { wouldSettle: boolean; wouldResultState?: FlowCommandReceipt['state']; reason?: string } {
  let predicted: FlowCommandReceipt | undefined
  try {
    getDb().transaction(() => {
      predicted = instance.commit(input)
      throw new PreviewRollback('preview')
    })()
  } catch (error) {
    if (!(error instanceof PreviewRollback)) {
      // 与 reconcile 相同：账本/资产事实错误表示"现在还不能结算"，不是命令失败。
      if (error instanceof FlowCommandError || error instanceof FlowAssetError)
        return { wouldSettle: false, reason: error.code }
      throw error
    }
  }
  return predicted
    ? { wouldSettle: true, wouldResultState: predicted.state }
    : { wouldSettle: false, reason: 'FLOW_RECEIPT_STORAGE_FAILED' }
}

function check(input: Record<string, unknown>, context: FlowCommandOperationContext): unknown {
  const projectId = input.projectId as string
  const commandId = input.commandId as string
  const startedAt = performance.now()
  const subject = { projectId, commandId }
  emitCommandOperation('started', 'reconcile-preview', context, subject, { commandId })
  const instance = ledger()
  let receipt: FlowCommandReceipt
  try {
    receipt = instance.lookup({ projectId, commandId })
  } catch (error) {
    const translated = translateLookupError(error)
    emitCommandOperation(
      'failed',
      'reconcile-preview',
      context,
      subject,
      { commandId, code: externalCode(translated) },
      { status: 'failed' }
    )
    throw translated
  }
  const alreadySettled = receipt.state !== 'pending' && receipt.state !== 'unknown'
  let wouldSettle = false
  let wouldResultState: FlowCommandReceipt['state'] | undefined
  let reason: string | undefined
  if (!alreadySettled) {
    const preview = previewSettlement(instance, { projectId, commandId })
    wouldSettle = preview.wouldSettle
    wouldResultState = preview.wouldResultState
    reason = preview.reason
  }
  emitCommandOperation(
    'completed',
    'reconcile-preview',
    context,
    { ...subject, nodeId: receipt.targetNodeId, taskId: receipt.taskId, runId: receipt.runId },
    { commandId, state: receipt.state },
    {
      // 预演结论无法结算时如实标 unknown，而不是把"还不能确认"记成成功。
      status: alreadySettled || wouldSettle ? 'success' : 'unknown',
      durationMs: Math.round(performance.now() - startedAt)
    }
  )
  return {
    projectId,
    commandId,
    state: receipt.state,
    alreadySettled,
    wouldSettle,
    ...(wouldResultState ? { wouldResultState } : {}),
    ...(reason ? { reason } : {}),
    receipt: receiptDto(receipt)
  }
}

/** dispatch / abort 等需要共享权威端口的操作必须等 registerFlowCommandsIpc 发布端口后可用。 */
function requirePort(phase: string): FlowCommandAccessPort {
  const port = flowCommandAccessPort()
  if (!port) refuse('FLOW_COMMANDS_UNAVAILABLE', phase)
  return port
}

/**
 * 外部派发：不另建账本，全部经共享端口复用 registerFlowCommandsIpc 的同一账本会话。
 * 受理回执只表示"main 已持久写入命令并交给渲染器"，不表示执行完成。
 */
async function dispatch(
  input: Record<string, unknown>,
  context: FlowCommandOperationContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const agentNodeId = input.agentNodeId as string
  const targetNodeId = input.targetNodeId as string
  const startedAt = performance.now()
  const subject = { projectId, nodeId: targetNodeId }
  emitCommandOperation('started', 'dispatch', context, subject, {})
  let commandId: string | undefined
  try {
    // 命令必须交给当前活动画布的权威渲染器执行；没有活动宿主就如实拒绝。
    if (context.activeProjectId() !== projectId)
      refuse(
        'ACTIVE_PROJECT_REQUIRED',
        'active-project:project.open the target canvas first, then retry flow.command.dispatch'
      )
    const desktop = context.desktop
    if (!desktop) refuse('DESKTOP_UNAVAILABLE', 'desktop')
    const port = requirePort('port')
    // 端口绑定的是渲染器 attach 的活动画布；与 service 的活动项目判断互为兜底（attach 有启动竞态）。
    if (!port.isActive(projectId))
      refuse('ACTIVE_PROJECT_REQUIRED', 'active-project:canvas bridge is not attached')
    // 与项目保存/固定资产提交同一条 flush 握手：先把画布协调到正式保存版本，再算语义版本。
    const flushed = await desktop.run({ action: 'flush', projectId })
    const saved = projects.openProject(projectId)
    if (!saved) refuse('NOT_FOUND', 'project-read')
    if (saved.meta.graphVersion !== flushed.graphVersion)
      refuse('REVISION_CONFLICT', 'flush-version')
    const target = saved.nodes.find((node) => node.id === targetNodeId)
    if (!target) refuse('NODE_NOT_FOUND', 'target-read')
    // 付费族必须显式确认，闸门发生在 prepare 之前（不会创建命令，更不会触达供应商）。
    if (PAID_TARGET_TYPES.has(target.type) && input.confirmPaidTarget !== true)
      refuse('PAID_TARGET_CONFIRM_REQUIRED', 'paid-target')
    if (!saved.nodes.some((node) => node.id === agentNodeId))
      refuse('NODE_NOT_FOUND', 'agent-read')
    // 命令/任务/运行身份与语义版本全部由 main 生成，外部不能自造。
    const command: NodeExecuteCommand = {
      schemaVersion: 1,
      kind: 'node.execute',
      commandId: randomUUID(),
      projectId,
      taskId: randomUUID(),
      agentNodeId,
      targetNodeId,
      contractVersion: input.contractVersion as number,
      expectedSemanticRevision: projectSemanticRevision(saved),
      inputs: input.inputs as NodeExecuteCommand['inputs'],
      traceId: context.traceId,
      spanId: context.spanId
    }
    const parsed = NodeExecuteCommandSchema.safeParse(command)
    if (!parsed.success)
      refuse('INVALID_INPUT', parsed.error.issues[0]?.path.join('.') || 'command')
    commandId = parsed.data.commandId
    // 唯一权威账本会话；principal='external' 由端口内部写入，外部无法指定。
    const prepared = port.prepareExternal(parsed.data)
    if (prepared.state !== 'ready') refuse('FLOW_COMMAND_CONFLICT', 'prepare')
    try {
      port.send(prepared.grant)
    } catch (error) {
      if (
        error instanceof FlowCommandError &&
        (error.code === 'FLOW_PROJECT_INACTIVE' || error.code === 'FLOW_DESKTOP_UNAVAILABLE')
      ) {
        // 确定未下发：放弃这条从未准入的命令释放占用；本次派发仍按 failed 报告。
        try {
          port.abandonExternal({ projectId, commandId: parsed.data.commandId })
        } catch {
          /* 帐本不可用时保留 pending，由 arm 定时器转 unknown。 */
        }
        refuse(error.code, 'delivery')
      }
      // 是否已下发无法确认：保留 pending，由账本 arm 超时或外部核对转 unknown，绝不宣告成功。
      throw new DesktopAccessError(
        'FLOW_COMMAND_DELIVERY_UNKNOWN',
        true,
        'dispatch delivery outcome unconfirmed'
      )
    }
    emitCommandOperation(
      'completed',
      'dispatch',
      context,
      { ...subject, taskId: parsed.data.taskId, runId: prepared.grant.runId },
      { commandId: parsed.data.commandId, state: 'pending' },
      { status: 'success', durationMs: Math.round(performance.now() - startedAt) }
    )
    return {
      projectId,
      commandId: parsed.data.commandId,
      taskId: parsed.data.taskId,
      runId: prepared.grant.runId,
      targetNodeId,
      graphVersion: saved.meta.graphVersion,
      accepted: true as const,
      state: 'pending' as const
    }
  } catch (error) {
    const translated =
      error instanceof DesktopAccessError
        ? error
        : error instanceof FlowCommandError || error instanceof FlowAssetError
          ? new DesktopAccessError(error.code, false, error.phase)
          : error
    emitCommandOperation(
      'failed',
      'dispatch',
      context,
      subject,
      { ...(commandId ? { commandId } : {}), code: externalCode(translated) },
      { status: 'failed' }
    )
    throw translated
  }
}

/** 外部放弃：只允许外部主体放弃自己创建且从未准入的命令（账本方法负责全部判定）。 */
function abort(
  input: Record<string, unknown>,
  context: FlowCommandOperationContext
): unknown {
  const projectId = input.projectId as string
  const commandId = input.commandId as string
  const startedAt = performance.now()
  const subject = { projectId, commandId }
  emitCommandOperation('started', 'abandon', context, subject, { commandId })
  try {
    const port = requirePort('port')
    let receipt: FlowCommandReceipt
    try {
      receipt = port.abandonExternal({ projectId, commandId })
    } catch (error) {
      const known =
        error instanceof FlowCommandError
          ? error.code === 'FLOW_COMMAND_MISSING' || error.code === 'FLOW_PROJECT_MISSING'
            ? new DesktopAccessError('NOT_FOUND', false, 'command-read')
            : new DesktopAccessError(error.code, false, error.phase)
          : error
      throw known
    }
    emitCommandOperation(
      'completed',
      'abandon',
      context,
      {
        ...subject,
        nodeId: receipt.targetNodeId,
        taskId: receipt.taskId,
        runId: receipt.runId
      },
      { commandId, state: receipt.state },
      { status: 'success', durationMs: Math.round(performance.now() - startedAt) }
    )
    return receiptDto(receipt)
  } catch (error) {
    emitCommandOperation(
      'failed',
      'abandon',
      context,
      subject,
      { commandId, code: externalCode(error) },
      { status: 'failed' }
    )
    throw error
  }
}

/** dispatch 分组分支的唯一入口；operationId 已由 isFlowCommandOperation 收窄。 */
export async function runFlowCommandOperation(
  operationId: FlowCommandOperationId,
  input: Record<string, unknown>,
  context: FlowCommandOperationContext
): Promise<unknown> {
  switch (operationId) {
    case 'flow.command.lookup':
      return lookup(input, context)
    case 'flow.command.availability':
      return availability(input, context)
    case 'flow.command.reconcile':
      return reconcile(input, context)
    case 'flow.command.check':
      return check(input, context)
    case 'flow.command.dispatch':
      return dispatch(input, context)
    case 'flow.command.abort':
      return abort(input, context)
  }
}
