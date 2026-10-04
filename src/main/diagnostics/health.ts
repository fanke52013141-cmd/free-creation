// 日志健康状态（LOGGING_SPEC.md §9）：接收/写入/丢弃/故障计数 + 有界事件环。
// 恢复后只报告真实计数，不重建已丢数据；降级摘要只输出一次受控文本。
import type { DiagnosticsHealthSnapshot } from '@shared/contracts'
import { DIAGNOSTICS_HEALTH_RING_ITEMS } from '@shared/observability'
import type { QueuedDrop } from './queue'

export interface HealthIncident {
  at: string
  kind: string
  detail: string
}

export class DiagnosticsHealth {
  received = 0
  written = 0
  private droppedTotal = 0
  private writeFailures = 0
  private badLines = 0
  private lastWriteErrorAt: string | undefined
  private incidents: HealthIncident[] = []

  countReceived(): void {
    this.received += 1
  }

  countWritten(count: number): void {
    this.written += count
  }

  countDrop(drop: QueuedDrop): void {
    this.droppedTotal += 1
    this.incident(
      `queue.${drop.reason}`,
      `${drop.event}(${drop.level})`
    )
  }

  countWriteFailure(at: string, detail: string): void {
    this.writeFailures += 1
    this.lastWriteErrorAt = at
    this.incident('write.failed', detail)
  }

  countRecovered(at: string): void {
    this.incident('write.recovered', at)
  }

  countBadLines(count: number): void {
    this.badLines += count
  }

  /** 有界事件环：最多保留最近 DIAGNOSTICS_HEALTH_RING_ITEMS 条。 */
  incident(kind: string, detail: string): void {
    this.incidents.push({ at: new Date().toISOString(), kind, detail })
    if (this.incidents.length > DIAGNOSTICS_HEALTH_RING_ITEMS) {
      this.incidents.splice(0, this.incidents.length - DIAGNOSTICS_HEALTH_RING_ITEMS)
    }
  }

  snapshot(options: {
    sessionId: string
    degraded: boolean
    available: boolean
    queueDepth: number
    queueBytes: number
  }): DiagnosticsHealthSnapshot {
    return {
      available: options.available,
      sessionId: options.sessionId,
      degraded: options.degraded,
      received: this.received,
      written: this.written,
      queueDepth: options.queueDepth,
      queueBytes: options.queueBytes,
      droppedTotal: this.droppedTotal,
      writeFailures: this.writeFailures,
      ...(this.lastWriteErrorAt ? { lastWriteErrorAt: this.lastWriteErrorAt } : {}),
      badLines: this.badLines,
      incidentLog: [...this.incidents]
    }
  }
}
