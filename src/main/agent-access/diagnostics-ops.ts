// F9（三）诊断查询：外部操作复用 main 的 DiagnosticsService.query（GUI 运行中心同一条
// 读取路径与同一份已脱敏存储），不另建日志读取器、不读 electron-log 明文、不读项目数据。
//
// 关键口径：
// - 服务不可用（未注入 / available=false 降级服务）必须如实报 DIAGNOSTICS_UNAVAILABLE；
//   不用空数组冒充"查到了但没有"。
// - 输出再做一遍脱敏与截断（message ≤500 字符、attributes 值 ≤256、错误不含 safeStack），
//   保证即使历史行是旧版本写入的也符合当前脱敏规则。
// - 分页有界：单页 ≤200 条、偏移 ≤5000、主进程一次最多读 2000 条。
import type {
  DiagnosticsHealthSnapshot,
  DiagnosticsQueryInput,
  DiagnosticsQueryResult
} from '../../shared/contracts'
import type { DiagnosticsEvent } from '../../shared/observability'
import { DIAGNOSTICS_EVENTS } from '../../shared/observability'
import { redactDiagnosticText } from '../../shared/diagnostics'
import { DesktopAccessError } from './desktop'

const MESSAGE_MAX_CHARS = 500
const ATTRIBUTE_MAX_KEYS = 32
const ATTRIBUTE_VALUE_MAX_CHARS = 256
const MAX_READ = 2000

export interface DiagnosticsOperationContext {
  /**
   * LocalAccessOptions.diagnostics。装配层只声明了 Pick<DiagnosticsService,'health'>，
   * 这里按鸭子类型取 query，避免为了一个查询改共享选项类型 / server 装配签名。
   */
  diagnostics: unknown
}

interface DiagnosticsQueryHost {
  health(): DiagnosticsHealthSnapshot
  query(input: DiagnosticsQueryInput): Promise<DiagnosticsQueryResult>
}

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, `diagnostics:${detail ?? code}`)
}

/** 只接受同时具备 health/query 的宿主对象；其余一律视为"诊断存储不可用"。 */
function resolveHost(value: unknown): DiagnosticsQueryHost | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { health?: unknown; query?: unknown }
  if (typeof candidate.health !== 'function' || typeof candidate.query !== 'function') return null
  return candidate as unknown as DiagnosticsQueryHost
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const redacted = redactDiagnosticText(value, maxChars)
  return redacted.length > 0 ? redacted : undefined
}

/** 事件 → 外部 DTO：白名单字段 + 二次脱敏 + 截断；safeStack 与未知字段不出现。 */
function projectEvent(event: DiagnosticsEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    eventId: boundedString(event.eventId, 160) ?? 'unknown',
    event: boundedString(event.event, 120) ?? 'unknown',
    level: event.level ?? 'info',
    message: redactDiagnosticText(event.message ?? '', MESSAGE_MAX_CHARS),
    receivedAt: boundedString(event.receivedAt, 40) ?? '',
    process: event.process === 'renderer' || event.process === 'worker' ? event.process : 'main',
    sessionId: boundedString(event.sessionId, 160) ?? 'unknown'
  }
  const optional = (key: string, maxChars: number): void => {
    const value = (event as unknown as Record<string, unknown>)[key]
    const bounded = boundedString(value, maxChars)
    if (bounded) out[key] = bounded
  }
  optional('phase', 40)
  optional('timestamp', 40)
  optional('traceId', 128)
  optional('spanId', 128)
  optional('parentSpanId', 128)
  optional('runId', 128)
  optional('nodeExecutionId', 128)
  optional('requestId', 128)
  optional('taskId', 128)
  optional('projectId', 128)
  optional('nodeId', 128)
  optional('nodeType', 80)
  if (
    event.status === 'success' ||
    event.status === 'failed' ||
    event.status === 'cancelled' ||
    event.status === 'skipped' ||
    event.status === 'interrupted' ||
    event.status === 'unknown'
  )
    out.status = event.status
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0)
    out.durationMs = event.durationMs
  if (event.correlationMissing === true) out.correlationMissing = true
  if (event.attributes) {
    // 只保留事件注册表为该事件登记的 attributes 键：即使历史行里混进了未知字段
    // （旧版本写入/更宽松的校验），外部查询也不会把它带出去。
    const allowed = DIAGNOSTICS_EVENTS[event.event]?.attributes ?? {}
    const attributes: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(event.attributes).slice(0, ATTRIBUTE_MAX_KEYS)) {
      if (!Object.prototype.hasOwnProperty.call(allowed, key)) continue
      if (typeof value === 'number' && Number.isFinite(value)) attributes[key] = value
      else if (typeof value === 'boolean') attributes[key] = value
      else if (typeof value === 'string') {
        const bounded = boundedString(value, ATTRIBUTE_VALUE_MAX_CHARS)
        if (bounded) attributes[key] = bounded
      }
    }
    if (Object.keys(attributes).length > 0) out.attributes = attributes
  }
  if (event.error) {
    const error: Record<string, unknown> = {
      code: boundedString(event.error.code, 64) ?? 'UNKNOWN',
      category: boundedString(event.error.category, 32) ?? 'unknown',
      retryable: event.error.retryable === true
    }
    if (typeof event.error.httpStatus === 'number' && Number.isInteger(event.error.httpStatus))
      error.httpStatus = event.error.httpStatus
    const sourceCode = boundedString(event.error.sourceCode, 64)
    if (sourceCode) error.sourceCode = sourceCode
    const causeCode = boundedString(event.error.causeCode, 64)
    if (causeCode) error.causeCode = causeCode
    out.error = error
  }
  return out
}

async function queryDiagnostics(
  input: Record<string, unknown>,
  context: DiagnosticsOperationContext
): Promise<unknown> {
  const host = resolveHost(context.diagnostics)
  if (!host) refuse('DIAGNOSTICS_UNAVAILABLE', 'host-missing')
  let health: DiagnosticsHealthSnapshot | null = null
  try {
    health = host.health()
  } catch {
    health = null
  }
  // 降级服务（数据目录不可用）的 query 返回空数组；这里必须按不可用处理，
  // 否则外部会把"日志存储坏了"误读成"没有事件"。
  if (!health || health.available !== true) refuse('DIAGNOSTICS_UNAVAILABLE', 'degraded')
  const offset = input.offset as number
  const limit = input.limit as number
  const readLimit = Math.min(offset + limit, MAX_READ)
  const query: DiagnosticsQueryInput = { limit: readLimit }
  if (typeof input.traceId === 'string') query.traceId = input.traceId
  if (typeof input.runId === 'string') query.runId = input.runId
  if (typeof input.requestId === 'string') query.requestId = input.requestId
  if (typeof input.nodeId === 'string') query.nodeId = input.nodeId
  if (typeof input.level === 'string')
    query.level = input.level as DiagnosticsQueryInput['level']
  if (typeof input.since === 'number') query.since = input.since
  if (typeof input.until === 'number') query.until = input.until
  let result: DiagnosticsQueryResult
  try {
    result = await host.query(query)
  } catch {
    refuse('QUERY_FAILED', 'query')
  }
  if (!result || !Array.isArray(result.events)) refuse('QUERY_FAILED', 'malformed')
  const events = result.events as DiagnosticsEvent[]
  const page = events.slice(offset, offset + limit)
  // 判定"后面还有"：存储侧明确截断、读满本次上限、或本次读取里还有本页之外的事件。
  const hasMore =
    result.truncated === true || events.length >= readLimit || events.length > offset + page.length
  return {
    events: page.map(projectEvent),
    returned: page.length,
    offset,
    limit,
    truncated: result.truncated === true,
    nextOffset: hasMore ? offset + page.length : null,
    badLines: Number.isInteger(result.badLines) ? result.badLines : 0,
    scannedShards: Number.isInteger(result.scannedShards) ? result.scannedShards : 0,
    source: 'diagnostics-store' as const,
    redaction: 'event-whitelist@1' as const
  }
}

/** diagnostics.* 的统一入口（本包只有 query；未登记分支由类型系统与 dispatch 兜底）。 */
export async function runDiagnosticsOperation(
  operation: string,
  input: Record<string, unknown>,
  context: DiagnosticsOperationContext
): Promise<unknown> {
  switch (operation) {
    case 'diagnostics.query':
      return queryDiagnostics(input, context)
    default:
      throw new DesktopAccessError('UNSUPPORTED_OPERATION', false, 'diagnostics-dispatch')
  }
}
