// session 分片 JSONL writer（LOGGING_SPEC.md §9）：
// 每个主进程 session 写自己的分片（多实例互不覆盖）；按天或 10 MiB 轮转；
// 追加失败进入降级（保留队列继续接收，健康计数），恢复后补写。
// 读取跳过残缺 JSON 行并计数，绝不因坏行丢掉有效前缀。
import { join } from 'path'
import type { DiagnosticsEvent } from '@shared/observability'
import { DIAGNOSTICS_SHARD_MAX_BYTES } from '@shared/observability'
import type { DiagnosticsFileStore } from './fs-types'
import type { DiagnosticsClock } from './clock'

export interface ShardReadResult {
  events: DiagnosticsEvent[]
  badLines: number
  scannedShards: number
  truncated: boolean
}

function shardDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replaceAll('-', '')
}

export class DiagnosticsShardWriter {
  private currentFile: string | null = null
  private currentDay = ''
  private seq = 0
  private degraded = false

  constructor(
    private readonly options: {
      store: DiagnosticsFileStore
      clock: DiagnosticsClock
      dir: string
      sessionId: string
      shardMaxBytes?: number
      onWriteFailure?: (at: string, detail: string) => void
      onRecovered?: (at: string) => void
    }
  ) {}

  get isDegraded(): boolean {
    return this.degraded
  }

  get currentShard(): string | null {
    return this.currentFile
  }

  private nextShardPath(): string {
    const day = shardDay(this.options.clock.nowMs())
    if (day !== this.currentDay) {
      this.currentDay = day
      this.seq = 0
    }
    this.seq += 1
    return join(this.options.dir, `session-${this.options.sessionId}-${day}-${this.seq}.jsonl`)
  }

  /** 追加一批事件；单批内部按行序列化，一次 append。返回 {written, failed}。 */
  async append(events: DiagnosticsEvent[]): Promise<{ written: number; failed: number }> {
    if (events.length === 0) return { written: 0, failed: 0 }
    let payload = ''
    for (const event of events) {
      try {
        payload += `${JSON.stringify(event)}\n`
      } catch {
        // 单条不可序列化：跳过该条，不影响整批。
      }
    }
    if (!payload) return { written: 0, failed: events.length }
    try {
      if (!this.currentFile) {
        this.currentFile = this.nextShardPath()
        await this.options.store.mkdir(this.options.dir)
      }
      await this.options.store.appendFile(this.currentFile, payload)
      if (this.degraded) {
        this.degraded = false
        this.options.onRecovered?.(new Date(this.options.clock.nowMs()).toISOString())
      }
      const shardStat = await this.options.store.stat(this.currentFile)
      if (
        shardStat &&
        shardStat.size >= (this.options.shardMaxBytes ?? DIAGNOSTICS_SHARD_MAX_BYTES)
      ) {
        // 立即轮转：下一条写入新分片。
        this.currentFile = null
      }
      return { written: events.length, failed: 0 }
    } catch (error) {
      this.degraded = true
      const detail = error instanceof Error ? error.message : String(error)
      this.options.onWriteFailure?.(new Date(this.options.clock.nowMs()).toISOString(), detail)
      // 当前分片可能已损坏/被锁：下次换新分片再试。
      this.currentFile = null
      return { written: 0, failed: events.length }
    }
  }

  /** 列出全部分片文件名（旧→新）。目录不可读时返回空。 */
  async listShards(): Promise<string[]> {
    try {
      const names = await this.options.store.readdir(this.options.dir)
      return names.filter((name) => name.endsWith('.jsonl')).sort()
    } catch {
      return []
    }
  }

  /**
   * 读取匹配过滤条件的事件（新分片优先）。limit 达到即截断；
   * 残缺行计数跳过；只读不做任何写操作。
   */
  async readEvents(
    filter: {
      traceId?: string
      runId?: string
      requestId?: string
      nodeId?: string
      level?: string
      since?: number
      until?: number
      limit?: number
    },
    mapEvent?: (event: DiagnosticsEvent) => DiagnosticsEvent
  ): Promise<ShardReadResult> {
    const shards = (await this.listShards()).reverse()
    const limit = filter.limit ?? 1000
    const events: DiagnosticsEvent[] = []
    let badLines = 0
    let scannedShards = 0
    for (const shard of shards) {
      if (events.length >= limit) break
      scannedShards += 1
      let raw: string
      try {
        raw = await this.options.store.readFile(join(this.options.dir, shard))
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let event: DiagnosticsEvent | null = null
        try {
          event = JSON.parse(trimmed) as DiagnosticsEvent
        } catch {
          badLines += 1
          continue
        }
        if (filter.traceId && event.traceId !== filter.traceId) continue
        if (filter.runId && event.runId !== filter.runId) continue
        if (filter.requestId && event.requestId !== filter.requestId) continue
        if (filter.nodeId && event.nodeId !== filter.nodeId) continue
        if (filter.level && event.level !== filter.level) continue
        const timestampMs = event.timestamp ? Date.parse(event.timestamp) : NaN
        if (Number.isFinite(timestampMs)) {
          if (filter.since !== undefined && timestampMs < filter.since) continue
          if (filter.until !== undefined && timestampMs > filter.until) continue
        }
        events.push(mapEvent ? mapEvent(event) : event)
        if (events.length >= limit) break
      }
    }
    return { events, badLines, scannedShards, truncated: events.length >= limit }
  }
}
