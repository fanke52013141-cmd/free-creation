// 有界异步队列（LOGGING_SPEC.md §9）：最多 2048 条或 8 MiB（先到为准），
// 预留 128 条关键事件容量。溢出先丢 debug 与重复 stage 事件，关键事件优先；
// 不承诺绝不丢失，丢弃进入健康计数与事件环。
import type { DiagnosticsEvent } from '@shared/observability'
import {
  DIAGNOSTICS_QUEUE_CRITICAL_RESERVED,
  DIAGNOSTICS_QUEUE_MAX_BYTES,
  DIAGNOSTICS_QUEUE_MAX_ITEMS
} from '@shared/observability'

export type QueueDropReason = 'queue_full' | 'overflow_evicted' | 'debug_throttled'

export interface QueuedDrop {
  reason: QueueDropReason
  level: string
  event: string
}

export interface EnqueueResult {
  ok: boolean
  drop?: QueuedDrop
}

interface QueueItem {
  event: DiagnosticsEvent
  bytes: number
  critical: boolean
}

function eventBytes(event: DiagnosticsEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8')
  } catch {
    // 不可序列化的事件按上限处理（safe 阶段已拦截，这里只兜底）。
    return 16 * 1024
  }
}

function isCritical(event: DiagnosticsEvent): boolean {
  return event.level === 'error' || event.level === 'fatal' || event.status !== undefined
}

function isDebug(event: DiagnosticsEvent): boolean {
  return event.level === 'debug'
}

function isRepeatableStage(event: DiagnosticsEvent): boolean {
  return event.event === 'node.stage' && event.level === 'info'
}

export class DiagnosticsQueue {
  private items: QueueItem[] = []
  private bytes = 0

  constructor(
    private readonly limits: {
      maxItems: number
      maxBytes: number
      criticalReserved: number
    } = {
      maxItems: DIAGNOSTICS_QUEUE_MAX_ITEMS,
      maxBytes: DIAGNOSTICS_QUEUE_MAX_BYTES,
      criticalReserved: DIAGNOSTICS_QUEUE_CRITICAL_RESERVED
    }
  ) {}

  get depth(): number {
    return this.items.length
  }

  get queuedBytes(): number {
    return this.bytes
  }

  /**
   * 入队。容量不足时：关键事件逐出最旧的普通事件（debug → stage → 普通）；
   * 普通事件在满时直接丢弃（计数返回）。关键预留耗尽后关键事件也可能被丢。
   */
  push(event: DiagnosticsEvent): EnqueueResult {
    const bytes = eventBytes(event)
    const critical = isCritical(event)
    const atItemLimit = this.items.length >= this.limits.maxItems
    const atByteLimit = this.bytes + bytes > this.limits.maxBytes
    const normalBudget = this.limits.maxItems - this.limits.criticalReserved

    // 普通事件不允许占用关键预留空间（条数或字节任一触达即丢）。
    if (!critical && (this.items.length >= normalBudget || atByteLimit)) {
      if (isDebug(event)) {
        return { ok: false, drop: { reason: 'debug_throttled', level: String(event.level), event: event.event } }
      }
      return { ok: false, drop: { reason: 'queue_full', level: String(event.level), event: event.event } }
    }

    if (!atItemLimit && !atByteLimit) {
      this.items.push({ event, bytes, critical })
      this.bytes += bytes
      return { ok: true }
    }

    if (critical) {
      // 关键事件：逐出最旧的可牺牲项，为它腾位置。
      const evictIndex = this.findEvictable(bytes)
      if (evictIndex >= 0) {
        const [evicted] = this.items.splice(evictIndex, 1)
        this.bytes -= evicted.bytes
        this.items.push({ event, bytes, critical })
        this.bytes += bytes
        return {
          ok: true,
          drop: { reason: 'overflow_evicted', level: String(evicted.event.level), event: evicted.event.event }
        }
      }
      // 预留也耗尽：丢弃新关键事件（有界内存环保存摘要，见 health）。
      return { ok: false, drop: { reason: 'queue_full', level: String(event.level), event: event.event } }
    }

    this.items.push({ event, bytes, critical })
    this.bytes += bytes
    return { ok: true }
  }

  private findEvictable(incomingBytes: number): number {
    const byteOk = (index: number): boolean =>
      this.bytes - this.items[index].bytes + incomingBytes <= this.limits.maxBytes
    for (const pass of [
      (item: QueueItem) => isDebug(item.event),
      (item: QueueItem) => isRepeatableStage(item.event),
      (item: QueueItem) => !item.critical
    ]) {
      for (let index = 0; index < this.items.length; index += 1) {
        if (!pass(this.items[index])) continue
        if (byteOk(index)) return index
      }
    }
    // 只有关键事件且字节数也放不下：逐出最旧的关键事件（队列必须有界）。
    for (let index = 0; index < this.items.length; index += 1) {
      if (byteOk(index)) return index
    }
    return -1
  }

  /** 取出最多 maxItems 条（FIFO）。 */
  drain(maxItems = 64): DiagnosticsEvent[] {
    const taken = this.items.splice(0, maxItems)
    for (const item of taken) this.bytes -= item.bytes
    return taken.map((item) => item.event)
  }
}
