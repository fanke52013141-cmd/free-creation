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
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  buildNodeRunDiagnosticsReport,
  safeRunFilename
} from '../diagnostics/node-run-export'
import { DesktopAccessError, type AccessDesktop } from './desktop'

const MESSAGE_MAX_CHARS = 500
const ATTRIBUTE_MAX_KEYS = 32
const ATTRIBUTE_VALUE_MAX_CHARS = 256
const MAX_READ = 2000

export interface DiagnosticsOperationContext {
  /**
   * LocalAccessOptions.diagnostics。装配层只声明了 Pick<DiagnosticsService,'health'>，
   * 这里按鸭子类型取 query/exportBundle，避免为了一个查询改共享选项类型 / server 装配签名。
   */
  diagnostics: unknown
  /** 受控导出目录（服务启动时 realpath 固定）；导出包只能写在这里。 */
  exportRoot: string
  /** 节点运行记录的来源：权威宿主（与 GUI 面板"导出诊断信息"同一份数据）。 */
  activeProjectId?: () => string | null
  desktop?: AccessDesktop
}

interface DiagnosticsQueryHost {
  health(): DiagnosticsHealthSnapshot
  query(input: DiagnosticsQueryInput): Promise<DiagnosticsQueryResult>
}

interface DiagnosticsExportHost extends DiagnosticsQueryHost {
  exportBundle(
    input: { scope: Record<string, unknown>; label?: string },
    filePath: string
  ): Promise<{ totalEvents?: number }>
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

/**
 * 诊断包导出：范围由外部指定，**输出位置由 main 决定**（受控导出目录内、带时间戳、
 * 不覆盖已有文件）。导出内容复用 DiagnosticsService.exportBundle 的既有脱敏写入，
 * 本函数只负责边界（可用性、范围、落位、回执）。
 */
async function exportDiagnosticsBundle(
  input: Record<string, unknown>,
  context: DiagnosticsOperationContext
): Promise<unknown> {
  const host = resolveHost(context.diagnostics) as DiagnosticsExportHost | null
  if (!host) refuse('DIAGNOSTICS_UNAVAILABLE', 'host-missing')
  if (typeof host.exportBundle !== 'function') refuse('DIAGNOSTICS_UNAVAILABLE', 'export-unsupported')
  let health: DiagnosticsHealthSnapshot | null = null
  try {
    health = host.health()
  } catch {
    health = null
  }
  if (!health || health.available !== true) refuse('DIAGNOSTICS_UNAVAILABLE', 'degraded')
  const scope: Record<string, unknown> = {}
  if (typeof input.traceId === 'string') scope.traceId = input.traceId
  if (typeof input.runId === 'string') scope.runId = input.runId
  if (typeof input.since === 'number') scope.since = input.since
  if (typeof input.until === 'number') scope.until = input.until
  // 空范围会导出"全部事件"，对诊断包没有意义且可能很大：要求至少给一个边界。
  if (Object.keys(scope).length === 0)
    refuse('INVALID_INPUT', 'scope requires traceId, runId, since or until')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fileName = `diagnostics-${stamp}.zip`
  const target = join(context.exportRoot, fileName)
  if (existsSync(target)) refuse('OUTPUT_EXISTS', fileName)
  let exported: { totalEvents?: number }
  try {
    exported = await host.exportBundle(
      { scope, ...(typeof input.label === 'string' ? { label: input.label } : {}) },
      target
    )
  } catch {
    refuse('EXPORT_FAILED', 'export-bundle')
  }
  if (!existsSync(target)) refuse('EXPORT_FAILED', 'package-missing')
  const bytes = readFileSync(target)
  if (bytes.length <= 0) refuse('EXPORT_FAILED', 'package-empty')
  return {
    fileName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
    totalEvents: Number.isInteger(exported?.totalEvents) ? Number(exported.totalEvents) : 0,
    scope
  }
}

/**
 * 节点运行诊断导出：记录由权威宿主提供（与 GUI「导出诊断信息」同一份 nodeRun/nodeRunHistory），
 * 报告构造与 GUI 共用 `buildNodeRunDiagnosticsReport`，落位固定在受控导出目录、不覆盖已有文件。
 * 节点正文作为 redactValues 传入，导出前被抹掉——所以报告里不会出现提示词或正文。
 */
async function exportNodeRunDiagnostics(
  input: Record<string, unknown>,
  context: DiagnosticsOperationContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const active = context.activeProjectId?.() ?? null
  if (active !== projectId)
    refuse('ACTIVE_PROJECT_REQUIRED', 'project.open the target canvas first')
  if (!context.desktop) refuse('DESKTOP_UNAVAILABLE', 'authoritative host is not running')
  let reply: { graphVersion: number; result?: unknown }
  try {
    reply = await context.desktop.run({ action: 'read-node-runs', projectId, nodeId }, undefined, 30000)
  } catch (error) {
    if (error instanceof DesktopAccessError) throw error
    refuse('NODE_RUNS_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 120) : undefined)
  }
  const payload = (reply.result ?? {}) as {
    nodeType?: string
    nodeTitle?: string
    runs?: unknown[]
    redactValues?: unknown[]
  }
  const runs = Array.isArray(payload.runs) ? (payload.runs as never[]) : []
  const report = buildNodeRunDiagnosticsReport({
    projectId,
    nodeId,
    nodeType: String(payload.nodeType ?? 'unknown').slice(0, 80),
    ...(typeof payload.nodeTitle === 'string' ? { nodeTitle: payload.nodeTitle } : {}),
    runs,
    ...(Array.isArray(payload.redactValues)
      ? { redactValues: payload.redactValues.filter((v): v is string => typeof v === 'string') }
      : {}),
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node
    }
  })
  const nodeType = String(payload.nodeType ?? 'node')
  const fileName = `${safeRunFilename(nodeType)}-${safeRunFilename(nodeId)}-diagnostics.json`
  const target = join(context.exportRoot, fileName)
  if (existsSync(target)) refuse('OUTPUT_EXISTS', fileName)
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (bytes.length <= 0) refuse('EXPORT_FAILED', 'empty-report')
  // 排他创建：并发下也不会覆盖已有文件。
  const fd = openSync(target, 'wx')
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return {
    fileName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
    runCount: Array.isArray((report as { runs?: unknown[] }).runs)
      ? (report as { runs: unknown[] }).runs.length
      : 0,
    nodeType: nodeType.slice(0, 80)
  }
}

/** diagnostics.* 的统一入口。 */
export async function runDiagnosticsOperation(
  operation: string,
  input: Record<string, unknown>,
  context: DiagnosticsOperationContext
): Promise<unknown> {
  switch (operation) {
    case 'diagnostics.query':
      return queryDiagnostics(input, context)
    case 'diagnostics.exportBundle':
      return exportDiagnosticsBundle(input, context)
    case 'diagnostics.exportNodeRun':
      return exportNodeRunDiagnostics(input, context)
    default:
      throw new DesktopAccessError('UNSUPPORTED_OPERATION', false, 'diagnostics-dispatch')
  }
}
