// main 网关边界诊断事件（L03/L04）：chat/image/video/audio 适配层的统一发射点。
// 只携带模型身份与关联 ID；请求/响应正文、密钥、完整 URL 一律不进入事件。
// 诊断上下文在这里统一做 ID 钳制（safeId），伪造/超长/含空白字段直接丢弃。
import {
  DiagnosticsProducer,
  newProducerId,
  safeId,
  safeShort,
  type DiagnosticContext,
  type DiagnosticsEventInput
} from '@shared/observability'
import type { GatewayDiagnosticsContext } from '../../shared/contracts'

export interface GatewayEventSink {
  emit(event: DiagnosticsEventInput | null): void
}

let sink: GatewayEventSink | null = null
const producer = new DiagnosticsProducer({
  process: 'main',
  producerId: newProducerId('main')
})

/** main/index.ts 初始化诊断服务后注入；测试可注入内存收集器。 */
export function setGatewayEventSink(next: GatewayEventSink | null): void {
  sink = next
}

export interface GatewayEmitOptions {
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  status?: DiagnosticsEventInput['status']
  /** 阶段标识（如 voice-clone 的 configuration/reference-audio）。 */
  phase?: string
  durationMs?: number
  error?: unknown
  attributes?: Record<string, unknown>
  /** 逻辑请求尝试序号（正式事件字段）。 */
  attempt?: number
  upstreamTaskId?: string
  upstreamRequestId?: string
  mediaId?: string
  state?: string
  byteSize?: number
  mime?: string
  outputChars?: number
  pollCount?: number
  transientErrors?: number
  waitMs?: number
  /** 显式覆盖关联缺失标记（默认按 traceId 是否存在推断）。 */
  correlationMissing?: boolean
  /** 用户私有值（节点正文等），message/attributes 脱敏用；绝不进入事件。 */
  privateValues?: readonly string[]
}

/** 上下文钳制：任何字段不过 safeId/safeShort 的一律不出现。 */
function toDiagnosticContext(input: GatewayDiagnosticsContext | undefined): DiagnosticContext {
  return {
    traceId: safeId(input?.traceId),
    spanId: safeId(input?.spanId),
    parentSpanId: safeId(input?.parentSpanId),
    runId: safeId(input?.runId),
    nodeExecutionId: safeId(input?.nodeExecutionId),
    requestId: safeId(input?.requestId),
    batchId: safeId(input?.batchId),
    itemId: safeId(input?.itemId),
    taskId: safeId(input?.taskId),
    projectId: safeId(input?.projectId),
    nodeId: safeId(input?.nodeId),
    nodeType: safeShort(input?.nodeType, 80),
    correlationMissing: input?.correlationMissing
  }
}

/**
 * 发射一条网关边界事件。attributes 走注册表白名单（未知键丢弃并计数）；
 * trace 缺失（旧调用方/直接网关调用）显式标记 correlationMissing，不补造关联。
 * 任何分支不抛错——日志失败不改变业务路径。
 */
export function emitGatewayEvent(
  event: string,
  message: string,
  diagnostics: GatewayDiagnosticsContext | undefined,
  options: GatewayEmitOptions = {}
): void {
  try {
    const context = toDiagnosticContext(diagnostics)
    const correlationMissing = options.correlationMissing ?? context.correlationMissing ?? !context.traceId
    const extraContext: Partial<DiagnosticContext> = {}
    const upstreamTaskId = safeId(options.upstreamTaskId)
    if (upstreamTaskId) extraContext.upstreamTaskId = upstreamTaskId
    const upstreamRequestId = safeId(options.upstreamRequestId)
    if (upstreamRequestId) extraContext.upstreamRequestId = upstreamRequestId
    const {
      level,
      status,
      phase,
      durationMs,
      error,
      attributes,
      attempt,
      privateValues,
      upstreamTaskId: _taskId,
      upstreamRequestId: _reqId,
      ...rest
    } = options
    void _taskId
    void _reqId
    const built = producer.build(event, level, message, { ...context, ...extraContext }, {
      ...(status ? { status } : {}),
      ...(phase ? {} : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(correlationMissing ? { correlationMissing: true } : {}),
      attributes: { ...rest, ...attributes },
      privateValues
    })
    let enriched = built
    if (enriched && phase) enriched = { ...enriched, phase }
    const withAttempt = enriched && attempt !== undefined ? { ...enriched, attempt } : enriched
    sink?.emit(withAttempt)
  } catch {
    // 日志失败不改变业务路径。
  }
}

/** 从调用方上下文取 requestId；没有则生成新的（一次逻辑调用一个，重试保持不变）。 */
export function ensureRequestId(diagnostics: GatewayDiagnosticsContext | undefined): string {
  return safeId(diagnostics?.requestId) ?? `req-${Math.random().toString(36).slice(2, 12)}`
}
