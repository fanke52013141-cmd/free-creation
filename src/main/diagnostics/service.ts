// 诊断服务门面：main 进程统一写入入口（LOGGING_SPEC.md §9）。
// 职责：renderer 事件校验/finalize → 有界队列 → 定时批量落盘 → 健康状态；
// 业务成功不等待日志持久确认；日志故障不抛入业务路径。
import { join } from 'path'
import {
  DIAGNOSTICS_FLUSH_BATCH_ITEMS,
  DIAGNOSTICS_FLUSH_INTERVAL_MS,
  DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS,
  DIAGNOSTICS_SCHEMA_VERSION,
  newEventId,
  newSessionId,
  type DiagnosticsEvent,
  type DiagnosticsEventInput,
  type DiagnosticsProducer
} from '@shared/observability'
import { DIAGNOSTICS_EVENT_INPUT_SCHEMA } from '@shared/observability'
import type {
  DiagnosticsHealthSnapshot,
  DiagnosticsQueryInput,
  DiagnosticsQueryResult,
  ExportDiagnosticsBundleInput
} from '../../shared/contracts'
import { redactDiagnosticText } from '../../shared/diagnostics'
import { DIAGNOSTICS_EVENTS } from '@shared/observability'
import type { DiagnosticsClock } from './clock'
import { systemClock } from './clock'
import type { DiagnosticsFileStore } from './fs-types'
import { nodeFsStore } from './fs-types'
import { DiagnosticsHealth } from './health'
import { DiagnosticsQueue } from './queue'
import { enforceRetention } from './retention'
import { findUncleanSessions, writeSessionState } from './session'
import { DiagnosticsShardWriter } from './writer'

export interface DiagnosticsServiceOptions {
  dataDir: string
  store?: DiagnosticsFileStore
  clock?: DiagnosticsClock
  producer?: DiagnosticsProducer
  /** 环境/构建标识：写入 session 状态文件，诊断包据此携带（规范 §5）。 */
  env?: Record<string, string | number | boolean>
  /** 测试关闭定时器；由测试手动调用 flushNow()。 */
  disableTimers?: boolean
}

export interface DiagnosticsService {
  readonly sessionId: string
  /** renderer / main 事件统一入口；返回接受数与拒绝数。永不抛错。 */
  ingest(events: unknown[]): Promise<{ accepted: number; rejected: number }>
  /** main 内部模块直接发事件（app 生命周期、网关边界等）。 */
  emit(event: DiagnosticsEventInput | null): void
  health(): DiagnosticsHealthSnapshot
  query(input: DiagnosticsQueryInput): Promise<DiagnosticsQueryResult>
  /** L05：按范围导出诊断包（临时文件成功后原子改名）。 */
  exportBundle(
    input: ExportDiagnosticsBundleInput,
    targetPath: string
  ): Promise<{ totalEvents: number; truncated: boolean; bytes: number; badLines: number }>
  /** 立即把队列落盘（测试与退出用）。 */
  flushNow(): Promise<void>
  /** 正常退出：≤2s 等待 flush，超时留非完整状态标记。 */
  flushOnQuit(): Promise<void>
}

export async function initDiagnosticsService(
  options: DiagnosticsServiceOptions
): Promise<DiagnosticsService> {
  const store = options.store ?? nodeFsStore()
  const clock = options.clock ?? systemClock()
  const sessionId = newSessionId()
  const rootDir = join(options.dataDir, 'diagnostics')
  const eventsDir = join(rootDir, 'events')
  const sessionsDir = join(rootDir, 'sessions')
  const health = new DiagnosticsHealth()
  const queue = new DiagnosticsQueue()

  let degraded = false
  let flushTimer: unknown = null
  let lastIngestErrorLogged = false

  const writer = new DiagnosticsShardWriter({
    store,
    clock,
    dir: eventsDir,
    sessionId,
    onWriteFailure: (at, detail) => {
      degraded = true
      health.countWriteFailure(at, detail)
    },
    onRecovered: () => {
      degraded = false
      health.countRecovered(new Date(clock.nowMs()).toISOString())
    }
  })

  const scheduleFlush = (delayMs = DIAGNOSTICS_FLUSH_INTERVAL_MS): void => {
    if (options.disableTimers || flushTimer) return
    flushTimer = clock.setTimeout(() => {
      flushTimer = null
      void flushNow()
    }, delayMs)
  }

  const flushNow = async (): Promise<void> => {
    if (queue.depth === 0) return
    const batch = queue.drain(DIAGNOSTICS_FLUSH_BATCH_ITEMS * 8)
    const result = await writer.append(batch)
    health.countWritten(result.written)
    if (result.failed > 0) {
      // 写失败的事件不回队（避免无限膨胀）：计入丢失，健康环有摘要。
      health.incident('write.lost_batch', `${result.failed} events`)
    }
  }

  const flushNowInternal = flushNow

  const finalize = (input: DiagnosticsEventInput): DiagnosticsEvent => {
    const meta = input.producerMeta
    const { producerMeta: _meta, ...rest } = input
    void _meta
    return {
      ...rest,
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      eventId: newEventId(),
      sessionId,
      producerId: meta?.producerId ?? 'main-unknown',
      sequence: meta?.sequence ?? 0,
      process: meta?.process ?? 'main',
      receivedAt: new Date(clock.nowMs()).toISOString(),
      ...(meta?.droppedKeys ? { droppedKeys: meta.droppedKeys } : {}),
      ...(meta?.truncatedFields?.length ? { truncatedFields: meta.truncatedFields } : {})
    }
  }

  const enqueueEvent = (event: DiagnosticsEvent): void => {
    const result = queue.push(event)
    if (result.ok) {
      // 错误级事件尽快调度写入，但不阻塞主路径（异步）。
      scheduleFlush(event.level === 'error' || event.level === 'fatal' ? 50 : undefined)
    } else if (result.drop) {
      health.countDrop(result.drop)
    }
  }

  const service: DiagnosticsService = {
    sessionId,

    async ingest(events: unknown[]): Promise<{ accepted: number; rejected: number }> {
      if (!Array.isArray(events)) return { accepted: 0, rejected: 0 }
      let accepted = 0
      let rejected = 0
      for (const candidate of events.slice(0, 512)) {
        health.countReceived()
        const parsed = DIAGNOSTICS_EVENT_INPUT_SCHEMA.safeParse(candidate)
        if (!parsed.success) {
          rejected += 1
          continue
        }
        enqueueEvent(finalize(parsed.data))
        accepted += 1
      }
      if (rejected > 0 && !lastIngestErrorLogged) {
        lastIngestErrorLogged = true
        health.incident('ingest.rejected', `${rejected} invalid events`)
      }
      scheduleFlush()
      return { accepted, rejected }
    },

    emit(event: DiagnosticsEventInput | null): void {
      if (!event) return
      health.countReceived()
      const parsed = DIAGNOSTICS_EVENT_INPUT_SCHEMA.safeParse(event)
      if (!parsed.success) {
        health.incident('emit.invalid', String(parsed.error.issues.length))
        return
      }
      enqueueEvent(finalize(parsed.data))
    },

    health(): DiagnosticsHealthSnapshot {
      return health.snapshot({
        sessionId,
        degraded: degraded || writer.isDegraded,
        available: true,
        queueDepth: queue.depth,
        queueBytes: queue.queuedBytes
      })
    },

    async query(input: DiagnosticsQueryInput): Promise<DiagnosticsQueryResult> {
      return writer.readEvents({
        traceId: input.traceId,
        runId: input.runId,
        requestId: input.requestId,
        nodeId: input.nodeId,
        level: input.level,
        since: input.since,
        until: input.until,
        limit: Math.min(input.limit ?? 500, 2000)
      })
    },

    async exportBundle(input, targetPath) {
      const BUNDLE_LIMIT_BYTES = 25 * 1024 * 1024
      // 二次脱敏：落盘前已清洗，导出再过一遍最后一道防线。
      const redactEvent = (event: DiagnosticsEvent): DiagnosticsEvent => ({
        ...event,
        ...(event.message ? { message: redactDiagnosticText(event.message, 500) } : {}),
        ...(event.error?.safeStack
          ? { error: { ...event.error, safeStack: redactDiagnosticText(event.error.safeStack, 4096) } }
          : {})
      })
      const read = await writer.readEvents(
        {
          traceId: input.scope.traceId,
          runId: input.scope.runId,
          since: input.scope.since,
          until: input.scope.until,
          limit: 20_000
        },
        redactEvent
      )

      // 家族覆盖统计（coverage.json）：范围内出现过的 family 与注册表对比。
      const familyCounts: Record<string, number> = {}
      for (const event of read.events) {
        const definition = DIAGNOSTICS_EVENTS[event.event]
        const family = definition?.family ?? 'unknown'
        familyCounts[family] = (familyCounts[family] ?? 0) + 1
      }

      // summary.txt：失败/根因/未完成，供开发 Agent 从摘要进入根因事件。
      const summaryLines: string[] = []
      summaryLines.push('# Canvas Studio 诊断摘要')
      summaryLines.push(`导出时间：${new Date(clock.nowMs()).toISOString()}`)
      summaryLines.push(`范围：${JSON.stringify({ ...input.scope, label: input.label ?? '' })}`)
      summaryLines.push(`事件数：${read.events.length}${read.truncated ? '（已截断）' : ''}`)
      summaryLines.push(`坏行数：${read.badLines}`)
      const failures = read.events.filter(
        (event) => event.status === 'failed' || event.level === 'error'
      )
      summaryLines.push('')
      summaryLines.push(`## 失败与错误（${failures.length} 条）`)
      for (const event of failures.slice(0, 200)) {
        const code = event.error?.code ?? ''
        const cause = event.error?.causeCode ? ` <- ${event.error.causeCode}` : ''
        summaryLines.push(
          `${event.timestamp} [${event.event}] node=${event.nodeId ?? '-'} run=${event.runId ?? '-'} ${code}${cause} ${event.message}`
        )
      }
      if (failures.length === 0) summaryLines.push('（范围内没有失败事件）')
      const started = read.events.filter((event) => event.event === 'workflow.started')
      const finished = read.events.filter((event) =>
        ['workflow.completed', 'workflow.failed', 'workflow.cancelled'].includes(event.event)
      )
      if (started.length > finished.length) {
        summaryLines.push('')
        summaryLines.push(
          `## 未完成：${started.length - finished.length} 个已开始的流程没有观察到终态（可能中断/仍在运行）`
        )
      }

      const healthSnapshot = health.snapshot({
        sessionId,
        degraded: degraded || writer.isDegraded,
        available: true,
        queueDepth: queue.depth,
        queueBytes: queue.queuedBytes
      })
      const manifest = {
        format: 'canvas-studio-diagnostics-bundle-v1',
        exportedAt: new Date(clock.nowMs()).toISOString(),
        sessionId,
        scope: input.scope,
        label: input.label ?? '',
        totalEvents: read.events.length,
        truncated: read.truncated,
        badLines: read.badLines,
        health: healthSnapshot,
        privacy: {
          includesPromptsOrReplies: false,
          includesApiKeys: false,
          includesRawUrls: false,
          note: 'events.jsonl 中的文本均为固定模板安全摘要；路径以受控资源 ID 表示'
        }
      }
      const coverage = {
        familyCounts,
        registeredFamilies: [...new Set(Object.values(DIAGNOSTICS_EVENTS).map((d) => d.family))],
        note: '未出现的家族表示该范围内没有该类事件；不代表功能未实现'
      }

      // adm-zip 为 CJS 默认导出：动态 import 后取 default。
      const admZipModule = (await import('adm-zip')) as unknown as {
        default: new (data?: Buffer) => {
          addFile: (name: string, data: Buffer) => void
          toBuffer: () => Buffer
        }
      }
      const zip = new admZipModule.default()
      const jsonOf = (value: unknown): Buffer =>
        Buffer.from(`${JSON.stringify(value, null, 2)}
`, 'utf8')
      zip.addFile('manifest.json', jsonOf(manifest))
      zip.addFile('coverage.json', jsonOf(coverage))
      zip.addFile('summary.txt', Buffer.from(`${summaryLines.join('\n')}\n`, 'utf8'))

      // 25MiB 上限：超限从最旧事件开始截断并标注，不静默丢弃。
      const eventLines = read.events.map((event) => JSON.stringify(event))
      let truncated = read.truncated
      const headerBytes =
        jsonOf(manifest).length + jsonOf(coverage).length + summaryLines.join('\n').length
      const eventsBudget = BUNDLE_LIMIT_BYTES - headerBytes
      if (
        eventLines.length > 0 &&
        Buffer.byteLength(eventLines.join('\n'), 'utf8') > eventsBudget
      ) {
        while (
          eventLines.length > 0 &&
          Buffer.byteLength(eventLines.join('\n'), 'utf8') > eventsBudget
        ) {
          eventLines.shift() // 从最旧开始丢，保留最近事件
        }
        truncated = true
        manifest.truncated = true
        manifest.totalEvents = eventLines.length
      }
      const eventsText = eventLines.length > 0 ? `${eventLines.join('\n')}\n` : ''
      zip.addFile('events.jsonl', Buffer.from(eventsText, 'utf8'))

      const zipped = zip.toBuffer()
      // 原子落盘：临时文件成功后再改名，失败清理自身临时文件。
      const tmpPath = `${targetPath}.tmp-${clock.nowMs()}`
      try {
        await store.writeFile(tmpPath, zipped)
        await store.rename(tmpPath, targetPath)
      } catch (error) {
        await store.unlink(tmpPath).catch(() => undefined)
        throw error
      }
      health.incident('export.completed', `${read.events.length} events`)
      return {
        totalEvents: manifest.totalEvents,
        truncated,
        bytes: zipped.length,
        badLines: read.badLines
      }
    },

    async flushNow(): Promise<void> {
      await flushNowInternal()
    },

    async flushOnQuit(): Promise<void> {
      try {
        await Promise.race([
          flushNowInternal(),
          new Promise<void>((resolve) => clock.setTimeout(resolve, DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS))
        ])
      } catch {
        // 退出 flush 失败：留非完整状态，不阻塞退出。
      }
      await writeSessionState(store, sessionsDir, {
        sessionId,
        startedAt: new Date(clock.nowMs()).toISOString(),
        ended: true,
        endedAt: new Date(clock.nowMs()).toISOString()
      })
    }
  }

  // 初始化目录与会话状态；失败则整个服务降级（调用方回退 electron-log）。
  try {
    await store.mkdir(eventsDir)
    await store.mkdir(sessionsDir)
    await writeSessionState(store, sessionsDir, {
      sessionId,
      startedAt: new Date(clock.nowMs()).toISOString(),
      ended: false,
      ...(options.env ? { env: options.env } : {})
    })
  } catch {
    degraded = true
    health.incident('init.failed', 'diagnostics directory unavailable')
    return makeUnavailableService(sessionId)
  }

  // 启动保留清理（异步，不阻塞启动路径）。
  void enforceRetention(store, eventsDir, { nowMs: clock.nowMs(), currentShard: null }).catch(
    () => undefined
  )

  return service
}

/** data 目录不可用时的降级服务：只计数与汇总，绝不写入业务数据目录之外。 */
function makeUnavailableService(sessionId: string): DiagnosticsService {
  const health = new DiagnosticsHealth()
  health.incident('init.failed', 'diagnostics unavailable')
  return {
    sessionId,
    async ingest(events: unknown[]) {
      for (let index = 0; index < events.length; index += 1) health.countReceived()
      return { accepted: 0, rejected: events.length }
    },
    emit() {
      /* 降级：丢弃 */
    },
    health: () =>
      health.snapshot({
        sessionId,
        degraded: true,
        available: false,
        queueDepth: 0,
        queueBytes: 0
      }),
    async query() {
      return { events: [], truncated: false, badLines: 0, scannedShards: 0 }
    },
    async exportBundle() {
      throw new Error('诊断存储未就绪，无法导出')
    },
    async flushNow() {
      return Promise.resolve()
    },
    async flushOnQuit() {
      return Promise.resolve()
    }
  }
}

/** 启动时检查上次会话是否正常结束（供 app.previous_session_unclean）。 */
export async function checkPreviousSession(
  store: DiagnosticsFileStore,
  sessionsDir: string
): Promise<boolean> {
  const unclean = await findUncleanSessions(store, sessionsDir)
  return unclean.length > 0
}
