// renderer 诊断事件上报器：微批缓冲 + fire-and-forget IPC。
// 日志失败不改变业务：transport 缺失（最小 mock / 浏览器模式）或调用抛错一律静默。
import type { DiagnosticsEventInput } from '@shared/observability'

const FLUSH_DELAY_MS = 50
const MAX_BATCH = 32

let buffer: DiagnosticsEventInput[] = []
let droppedByTransport = 0
let timer: ReturnType<typeof setTimeout> | null = null

type Transport = (input: { events: unknown[] }) => Promise<unknown>

function transport(): Transport | null {
  if (typeof window === 'undefined') return null
  const report = (window.api as unknown as { reportDiagnosticsEvents?: Transport } | undefined)
    ?.reportDiagnosticsEvents
  return typeof report === 'function' ? report : null
}

function schedule(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    flushDiagnosticsEvents()
  }, FLUSH_DELAY_MS)
}

/** 立即把缓冲中最多一批事件发往 main；剩余的继续排队。任何失败静默计数。 */
export function flushDiagnosticsEvents(): void {
  if (buffer.length === 0) return
  const batch = buffer.splice(0, MAX_BATCH)
  const send = transport()
  if (!send) {
    droppedByTransport += batch.length
    if (buffer.length > 0) schedule()
    return
  }
  try {
    void send({ events: batch as unknown[] }).catch(() => {
      droppedByTransport += batch.length
    })
  } catch {
    droppedByTransport += batch.length
  }
  if (buffer.length > 0) schedule()
}

/** 产出一条结构化事件（null 直接忽略）；不阻塞、不抛错。 */
export function emitDiagnosticsEvent(event: DiagnosticsEventInput | null): void {
  if (!event) return
  buffer.push(event)
  if (buffer.length >= MAX_BATCH) flushDiagnosticsEvents()
  else schedule()
}

/** 供测试观察缓冲状态。 */
export function pendingDiagnosticsEventCount(): number {
  return buffer.length
}

/** 供测试观察「transport 缺失导致丢弃」的计数。 */
export function diagnosticsTransportDropCount(): number {
  return droppedByTransport
}

/** 测试辅助：重置内部状态。 */
export function resetDiagnosticsReporterForTest(): void {
  buffer = []
  droppedByTransport = 0
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
