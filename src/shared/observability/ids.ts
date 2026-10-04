// 诊断关联 ID 生成（LOGGING_SPEC.md §4）。
// 只生成新 ID；已有 runId/itemRunId 语义保持不变，不重命名不重解释。
import { DIAGNOSTICS_ID_MAX_CHARS } from './limits'

function randomId(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID()
  // 测试/非安全上下文兜底：不追求密码学强度，只要求不重复。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function prefixed(prefix: string): string {
  return `${prefix}-${randomId()}`
}

/** 事件唯一 ID；同事件重送沿用原 ID。 */
export const newEventId = (): string => prefixed('evt')
/** 一次用户操作/工作流的根 trace。 */
export const newTraceId = (): string => prefixed('trace')
/** 一个逻辑步骤（节点/请求/下载等 span）。 */
export const newSpanId = (): string => prefixed('span')
/** 每次节点调用独立的执行实例。 */
export const newNodeExecutionId = (): string => prefixed('nexec')
/** 一次逻辑网关调用的本地请求 ID（重试期间不变）。 */
export const newRequestId = (): string => prefixed('req')
/** 主进程会话 ID（重启必须不同）。 */
export const newSessionId = (): string => prefixed('session')
/** 生产者实例 ID（配 sequence 发现丢失/乱序）。 */
export const newProducerId = (process: 'main' | 'renderer' | 'worker'): string =>
  `${process}-${randomId().slice(0, 13)}`

/** 校验并钳制外部传入的 ID：非字符串/超长/含空白一律丢弃返回 undefined。 */
export function safeId(value: unknown, maxChars = DIAGNOSTICS_ID_MAX_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxChars || /\s/.test(trimmed)) return undefined
  return trimmed
}
