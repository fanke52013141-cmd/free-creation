// 诊断上下文：一次操作从流程/节点贯穿到请求、任务、媒体与保存的关联字段
// （LOGGING_SPEC.md §4）。字段全部可选按需填写；main 入口会重新校验并覆盖
// 自身的 session/producer/时间信息，不接受伪造系统日志。

export type DiagnosticsProcess = 'main' | 'renderer' | 'worker'
export type DiagnosticsLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type DiagnosticsStatus =
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'interrupted'
  | 'unknown'

/**
 * 生成/传递诊断上下文的持有者。renderer 由执行器入口生成根 traceId；
 * main 恢复旧任务时开启新 trace 并记录 resumesTraceId。
 */
export interface DiagnosticContext {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  /** 已有工作流/子流程运行 ID，保留原名与原语义。 */
  runId?: string
  /** 每次节点调用独立生成；同节点重跑与不同迭代项不冲突。 */
  nodeExecutionId?: string
  /** 一次逻辑网关调用的本地 ID；自动重试期间不变。 */
  requestId?: string
  /** 逻辑请求的实际尝试序号，从 1 开始。 */
  attempt?: number
  /** 本地异步任务 / 供应商任务 ID，与 requestId 区分。 */
  taskId?: string
  upstreamTaskId?: string
  upstreamRequestId?: string
  /** 批次与稳定子项身份（迭代），不能用数组位置替代。 */
  batchId?: string
  itemId?: string
  projectId?: string
  nodeId?: string
  nodeType?: string
  /** 手动重跑关联：新 trace 指向其重跑对象。 */
  retryOfTraceId?: string
  retryOfNodeExecutionId?: string
  /** 恢复关联：新 trace 指向旧 trace；旧记录缺 traceId 时不补造。 */
  resumesTraceId?: string
  /** 旧路径/恢复场景：无法关联既有 trace 时显式标记，不补造时间线。 */
  correlationMissing?: boolean
}

/** 从父上下文派生子步骤上下文（不继承 request/attempt 等边界字段）。 */
export function childSpan(
  parent: DiagnosticContext,
  spanId: string,
  extra?: Partial<DiagnosticContext>
): DiagnosticContext {
  return {
    traceId: parent.traceId,
    parentSpanId: parent.spanId ?? parent.parentSpanId,
    runId: parent.runId,
    projectId: parent.projectId,
    ...extra,
    spanId
  }
}
