// 交互式操作的等待口径：有些操作在返回前必须等人在 GUI 现场点「允许」。
// 这类操作没有下行流量可等，不能用默认 15s 响应超时衡量；把「哪些操作是交互式的」
// 与「客户端该等多久」收敛成一份真值，main 与 CLI 客户端都从这里取。
import { ACCESS_OPERATIONS } from './registry'

/**
 * main 侧等待人工决定的上限（与 `main/agent-access/human-decision` 同源）。
 * 人工决定何时发生由人决定，不能压缩成默认响应超时。
 */
export const HUMAN_DECISION_TIMEOUT_MS = 5 * 60 * 1000

/** 非交互操作的响应超时：应用无响应时尽快失败。 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000

/** 交互式操作的客户端响应超时：人工决定上限 + 确认后实际写入的余量。 */
export const INTERACTIVE_RESPONSE_TIMEOUT_MS = HUMAN_DECISION_TIMEOUT_MS + 30_000

/**
 * 操作是否可能阻塞在「人在 GUI 点确认」上。
 * 真值来自 `OperationSpec.interactive`：新增阻塞式 `requestHumanDecision` / `desktop.ask`
 * 调用点时，必须在操作定义上声明 `interactive: true`，否则 CLI 会在 15s 时误报
 * `OUTCOME_UNKNOWN`，把「人还没点」说成「结果未知」。
 */
export function isInteractiveOperation(operationId: string): boolean {
  return (
    (ACCESS_OPERATIONS as Record<string, { interactive?: boolean } | undefined>)[operationId]
      ?.interactive === true
  )
}

/**
 * 客户端 socket 的响应超时：
 * - `run.wait` 按请求的等待时长（长轮询，等待期间没有下行流量）；
 * - 交互式操作等满人工决定上限；
 * - 其余操作保持 15s 快速失败。
 */
export function responseTimeoutMs(operationId: string, requestedWaitMs: number): number {
  if (requestedWaitMs > 0) return requestedWaitMs + 30_000
  return isInteractiveOperation(operationId)
    ? INTERACTIVE_RESPONSE_TIMEOUT_MS
    : DEFAULT_RESPONSE_TIMEOUT_MS
}
