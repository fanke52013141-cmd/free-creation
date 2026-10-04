// 事件生产者工厂：renderer 与 main 共用的统一事件构造入口。
// 生产者只负责本进程能填的字段（producerMeta：process/producerId/sequence）；
// sessionId/receivedAt/eventId 由 main 入口补齐（见 main/diagnostics/sink）。
import type { DiagnosticContext, DiagnosticsLevel, DiagnosticsProcess } from './context'
import { DIAGNOSTICS_EVENTS } from './events'
import { normalizeDiagnosticError, type NormalizedDiagnosticError } from './errors'
import { safeAttributes, safeMessage } from './safe'
import type { DiagnosticsEventInput } from './schema'

export interface DiagnosticsProducerOptions {
  process: DiagnosticsProcess
  producerId: string
  /** 供测试注入固定时钟。 */
  now?: () => number
}

export interface EmitOptions {
  /** 终态/阶段结果。 */
  status?: DiagnosticsEventInput['status']
  durationMs?: number
  /** 原始抛出物；会被归一化，绝不进入事件。 */
  error?: unknown
  /** 已归一化的错误（调用方已处理时直接传入）。 */
  normalizedError?: NormalizedDiagnosticError
  withStack?: boolean
  attributes?: Record<string, unknown>
  linkedTraceIds?: string[]
  correlationMissing?: boolean
  /** 用户私有值（节点正文等），attributes/message 脱敏用；不进入事件。 */
  privateValues?: readonly string[]
}

export class DiagnosticsProducer {
  private sequence = 0
  private readonly now: () => number

  constructor(private readonly options: DiagnosticsProducerOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  get id(): string {
    return this.options.producerId
  }

  /**
   * 构造一条受限事件；注册表之外的 event 名直接丢弃（返回 null，调用方计数）。
   * attributes 未知键丢弃并计数；message 只保留脱敏后的安全摘要。
   * 任何分支不抛错。
   */
  build(
    event: string,
    level: DiagnosticsLevel | undefined,
    message: string,
    context: DiagnosticContext,
    options: EmitOptions = {}
  ): DiagnosticsEventInput | null {
    const definition = DIAGNOSTICS_EVENTS[event]
    if (!definition) return null
    const normalizedError =
      options.normalizedError ??
      (options.error !== undefined
        ? normalizeDiagnosticError(options.error, { withStack: options.withStack })
        : undefined)
    const { attributes, truncatedFields, droppedKeys } = safeAttributes(
      definition,
      options.attributes,
      options.privateValues
    )
    this.sequence += 1
    const resolvedLevel: DiagnosticsLevel = level ?? definition.defaultLevel
    const built: DiagnosticsEventInput = {
      event,
      level: resolvedLevel,
      message: safeMessage(message, options.privateValues),
      timestamp: new Date(this.now()).toISOString(),
      ...contextFields(context),
      ...(options.status ? { status: options.status } : {}),
      ...(options.durationMs !== undefined ? { durationMs: Math.round(options.durationMs) } : {}),
      ...(normalizedError
        ? {
            error: Object.fromEntries(
              Object.entries(normalizedError).filter(([, value]) => value !== undefined)
            ) as NormalizedDiagnosticError
          }
        : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(options.linkedTraceIds?.length ? { linkedTraceIds: options.linkedTraceIds } : {}),
      ...(options.correlationMissing ? { correlationMissing: true } : {}),
      producerMeta: {
        process: this.options.process,
        producerId: this.options.producerId,
        sequence: this.sequence,
        droppedKeys,
        ...(truncatedFields.length > 0 ? { truncatedFields } : {})
      }
    }
    return built
  }
}

/** 上下文 → wire 字段；空值一律不出现。 */
function contextFields(context: DiagnosticContext): Partial<DiagnosticsEventInput> {
  return {
    ...(context.traceId ? { traceId: context.traceId } : {}),
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.nodeExecutionId ? { nodeExecutionId: context.nodeExecutionId } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.upstreamTaskId ? { upstreamTaskId: context.upstreamTaskId } : {}),
    ...(context.upstreamRequestId ? { upstreamRequestId: context.upstreamRequestId } : {}),
    ...(context.batchId ? { batchId: context.batchId } : {}),
    ...(context.itemId ? { itemId: context.itemId } : {}),
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.nodeId ? { nodeId: context.nodeId } : {}),
    ...(context.nodeType ? { nodeType: context.nodeType } : {}),
    ...(context.resumesTraceId ? { resumesTraceId: context.resumesTraceId } : {}),
    ...(context.retryOfTraceId ? { retryOfTraceId: context.retryOfTraceId } : {}),
    ...(context.retryOfNodeExecutionId
      ? { retryOfNodeExecutionId: context.retryOfNodeExecutionId }
      : {})
  }
}
