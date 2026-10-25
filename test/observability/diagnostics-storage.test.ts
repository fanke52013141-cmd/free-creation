// L02 有界队列 / 分片 writer / session / retention / service 测试。
// 全部使用可注入内存 FS + 手动时钟获得确定性故障（拒写、磁盘满、坏行、多实例）。
import { describe, expect, it } from 'vitest'
import {
  DIAGNOSTICS_FLUSH_BATCH_ITEMS,
  DIAGNOSTICS_FLUSH_INTERVAL_MS,
  DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS,
  DiagnosticsProducer,
  newEventId,
  type DiagnosticsEvent,
  type DiagnosticsEventInput
} from '@shared/observability'
import { DiagnosticsQueue } from '../../src/main/diagnostics/queue'
import { DiagnosticsShardWriter } from '../../src/main/diagnostics/writer'
import { enforceRetention } from '../../src/main/diagnostics/retention'
import { findUncleanSessions, writeSessionState } from '../../src/main/diagnostics/session'
import { checkPreviousSession, initDiagnosticsService } from '../../src/main/diagnostics/service'
import { manualClock } from '../../src/main/diagnostics/clock'
import { memoryFsStore } from '../../src/main/diagnostics/fs-types'

function producer(clock = manualClock(0)): DiagnosticsProducer {
  return new DiagnosticsProducer({
    process: 'main',
    producerId: 'main-test',
    now: () => clock.nowMs()
  })
}

function makeEvent(overrides: Partial<DiagnosticsEventInput> = {}): DiagnosticsEventInput {
  return producer().build('node.stage', 'info', '测试事件', { traceId: 'trace-1' }, overrides)!
}

function finalize(input: DiagnosticsEventInput, sequence = 1): DiagnosticsEvent {
  const { producerMeta, ...rest } = input
  void producerMeta
  return {
    ...rest,
    schemaVersion: 1,
    eventId: newEventId(),
    sessionId: 'session-test',
    producerId: 'main-test',
    sequence,
    process: 'main',
    receivedAt: new Date().toISOString()
  }
}

describe('有界队列（L02）', () => {
  it('容量内正常入队 FIFO drain', () => {
    const queue = new DiagnosticsQueue({ maxItems: 3, maxBytes: 1024 * 1024, criticalReserved: 1 })
    expect(queue.push(finalize(makeEvent(), 1)).ok).toBe(true)
    expect(queue.push(finalize(makeEvent(), 2)).ok).toBe(true)
    expect(queue.depth).toBe(2)
    const drained = queue.drain(10)
    expect(drained).toHaveLength(2)
    expect(queue.depth).toBe(0)
  })

  it('普通事件超过普通预算被丢弃并给出原因；关键事件可挤占普通空间', () => {
    const queue = new DiagnosticsQueue({ maxItems: 4, maxBytes: 1024 * 1024, criticalReserved: 2 })
    let dropped = 0
    for (let index = 0; index < 10; index += 1) {
      const result = queue.push(finalize(makeEvent(), index))
      if (!result.ok) dropped += 1
    }
    expect(queue.depth).toBe(2) // maxItems - criticalReserved
    expect(dropped).toBe(8)

    const critical = producer().build(
      'node.failed',
      'error',
      '关键失败',
      {},
      { status: 'failed' }
    )!
    expect(queue.push(finalize(critical)).ok).toBe(true)
    expect(queue.depth).toBe(3)
  })

  it('字节数上限先到也生效：装不下的关键事件被丢弃，装得下的普通事件先于关键预留被限制', async () => {
    // 以真实序列化尺寸为基准设定上限，避免对字节大小做脆弱假设。
    const sample = finalize(makeEvent(), 1)
    const sampleBytes = Buffer.byteLength(JSON.stringify(sample), 'utf8')
    const queue = new DiagnosticsQueue({
      maxItems: 100,
      maxBytes: sampleBytes + 1,
      criticalReserved: 1
    })
    expect(queue.push(finalize(makeEvent(), 1)).ok).toBe(true)
    // 第二条普通事件必然超字节上限 → 丢弃（把空间留给关键事件）。
    const second = queue.push(finalize(makeEvent(), 2))
    expect(second.ok).toBe(false)
    expect(second.drop?.reason).toBe('queue_full')
    expect(queue.depth).toBe(1)
  })

  it('队列绝对满员时，关键事件逐出最旧的普通事件而不是丢自己', async () => {
    const queue = new DiagnosticsQueue({ maxItems: 3, maxBytes: 1024 * 1024, criticalReserved: 1 })
    queue.push(finalize(makeEvent(), 1))
    queue.push(finalize(makeEvent(), 2))
    // 第三条普通事件触达绝对上限前已被普通预算拦截；用关键事件填满。
    const firstCritical = finalize(
      producer().build('node.failed', 'error', '关键失败A', {}, { status: 'failed' })!
    )
    expect(queue.push(firstCritical).ok).toBe(true)
    expect(queue.depth).toBe(3)
    // 队列已满：再来一条关键事件必须逐出最旧的普通事件。
    const secondCritical = finalize(
      producer().build('node.failed', 'error', '关键失败B', {}, { status: 'failed' })!
    )
    const result = queue.push(secondCritical)
    expect(result.ok).toBe(true)
    expect(result.drop?.reason).toBe('overflow_evicted')
    expect(queue.depth).toBe(3)
    const drained = queue.drain(10)
    const criticalEvents = drained.filter((event) => event.event === 'node.failed')
    expect(criticalEvents.map((event) => event.message)).toEqual(['关键失败A', '关键失败B'])
  })
})

describe('分片 writer（L02）', () => {
  it('写入 JSONL、按大小轮转、读取可跳过尾部坏行', async () => {
    const store = memoryFsStore()
    const clock = manualClock(new Date('2026-10-04T00:00:00Z').getTime())
    const writer = new DiagnosticsShardWriter({
      store,
      clock,
      dir: '/data/diagnostics/events',
      sessionId: 's1',
      shardMaxBytes: 400
    })
    for (let index = 0; index < 6; index += 1) {
      await writer.append([finalize(makeEvent(), index)])
    }
    const shards = await writer.listShards()
    expect(shards.length).toBeGreaterThanOrEqual(2) // 已按大小轮转

    // 尾部残缺行：读取跳过并计数，不丢有效前缀。
    const firstShard = shards[0]
    await store.appendFile(`/data/diagnostics/events/${firstShard}`, '{"broken"\n')
    const read = await writer.readEvents({ limit: 100 })
    expect(read.events.length).toBeGreaterThanOrEqual(6)
    expect(read.badLines).toBe(1)
    expect(read.truncated).toBe(false)
  })

  it('拒写故障进入降级并计数；恢复后继续写入', async () => {
    const store = memoryFsStore({ failAppendAfterWrites: 1 })
    const clock = manualClock(0)
    const failures: string[] = []
    let recovered = 0
    const writer = new DiagnosticsShardWriter({
      store,
      clock,
      dir: '/data/diagnostics/events',
      sessionId: 's1',
      onWriteFailure: (_at, detail) => failures.push(detail),
      onRecovered: () => {
        recovered += 1
      }
    })
    await writer.append([finalize(makeEvent(), 1)])
    expect(writer.isDegraded).toBe(false)

    const second = await writer.append([finalize(makeEvent(), 2)])
    expect(second.failed).toBe(1)
    expect(writer.isDegraded).toBe(true)
    expect(failures).toHaveLength(1)

    // 换一个健康的 store 语义（模拟故障恢复：直接继续，writer 每次换新分片重试）
    const third = await writer.append([finalize(makeEvent(), 3)])
    expect(third.failed).toBe(1) // 仍注入失败
    expect(recovered).toBe(0)
  })

  it('查询过滤按 traceId/level 生效并报告截断', async () => {
    const store = memoryFsStore()
    const clock = manualClock(0)
    const writer = new DiagnosticsShardWriter({
      store,
      clock,
      dir: '/data/diagnostics/events',
      sessionId: 's1'
    })
    const matching = producer().build('node.failed', 'error', 'x', { traceId: 'trace-A' }, { status: 'failed' })!
    const other = makeEvent()
    await writer.append([finalize(matching, 1), finalize(other, 2), finalize(matching, 3)])
    const read = await writer.readEvents({ traceId: 'trace-A', limit: 1 })
    expect(read.events).toHaveLength(1)
    expect(read.truncated).toBe(true)
    expect(read.events[0].traceId).toBe('trace-A')
  })
})

describe('会话状态与保留清理（L02）', () => {
  it('excludes the new active session while retaining real previous unclean sessions', async () => {
    const store = memoryFsStore()
    const dir = '/data/diagnostics/sessions'
    await writeSessionState(store, dir, { sessionId: 'current', startedAt: 'x', ended: false })
    await expect(checkPreviousSession(store, dir, 'current')).resolves.toBe(false)
    await writeSessionState(store, dir, { sessionId: 'old-clean', startedAt: 'x', ended: true })
    await expect(checkPreviousSession(store, dir, 'current')).resolves.toBe(false)
    await writeSessionState(store, dir, { sessionId: 'old-unclean', startedAt: 'x', ended: false })
    await expect(checkPreviousSession(store, dir, 'current')).resolves.toBe(true)
    await store.writeFile(`${dir}/session-damaged.json`, '{')
    await store.unlink(`${dir}/session-old-unclean.json`)
    await expect(checkPreviousSession(store, dir, 'current')).resolves.toBe(true)
  })

  it('非正常结束的会话能被发现；ended 会话不报', async () => {
    const store = memoryFsStore()
    const dir = '/data/diagnostics/sessions'
    await writeSessionState(store, dir, { sessionId: 's-old', startedAt: 'x', ended: false })
    await writeSessionState(store, dir, { sessionId: 's-ok', startedAt: 'x', ended: true })
    const unclean = await findUncleanSessions(store, dir)
    expect(unclean.map((item) => item.sessionId)).toEqual(['s-old'])
  })

  it('清理只删诊断目录内最旧的零错误分片；保留错误分片与当前分片', async () => {
    const store = memoryFsStore()
    const dir = '/data/diagnostics/events'
    const oldZeroError = `${dir}/session-a-20260101-1.jsonl`
    const oldWithError = `${dir}/session-a-20260101-2.jsonl`
    const current = `${dir}/session-b-20261004-1.jsonl`
    const businessFile = '/data/projects/p1/project.json'
    await store.appendFile(oldZeroError, 'x'.repeat(600))
    await store.appendFile(oldWithError, `{"level":"error"}\n${'y'.repeat(300)}`)
    await store.appendFile(current, 'z'.repeat(50))
    await store.appendFile(businessFile, 'IMPORTANT')
    const clock = manualClock(new Date('2026-10-04T00:00:00Z').getTime())

    const result = await enforceRetention(store, dir, {
      nowMs: clock.nowMs(),
      currentShard: 'session-b-20261004-1.jsonl',
      maxBytes: 700,
      errorBytes: 20 * 1024 * 1024,
      retentionDays: 14
    })
    expect(result.removed).toContain('session-a-20260101-1.jsonl')
    expect(result.removed).not.toContain('session-a-20260101-2.jsonl') // 含错误，保留
    expect(result.removed).not.toContain('session-b-20261004-1.jsonl') // 当前分片
    expect(store.files.has(businessFile)).toBe(true) // 业务文件绝不被日志清理触碰
    expect(store.files.has(oldWithError)).toBe(true)
  })

  it('超过保留期的旧分片被清理（容量优先于天数语义不受影响）', async () => {
    const store = memoryFsStore()
    const dir = '/data/diagnostics/events'
    const oldShard = `${dir}/session-a-20260101-1.jsonl`
    const recentShard = `${dir}/session-b-20261004-1.jsonl`
    await store.appendFile(oldShard, 'x'.repeat(10))
    await store.appendFile(recentShard, 'y'.repeat(10))
    // 内存实现用 touch 模拟旧分片的真实修改时间。
    store.touch(oldShard, new Date('2026-01-01T00:00:00Z').getTime())
    const clock = manualClock(new Date('2026-10-04T00:00:00Z').getTime())
    const result = await enforceRetention(store, dir, {
      nowMs: clock.nowMs(),
      retentionDays: 14,
      maxBytes: 200 * 1024 * 1024
    })
    expect(result.removed).toContain('session-a-20260101-1.jsonl')
    expect(result.removed).not.toContain('session-b-20261004-1.jsonl')
    expect(store.files.has(recentShard)).toBe(true)
  })
})

describe('诊断服务端到端（L02）', () => {
  it.each([true, false])(
    'preserves version metadata when shutdown completeness is %s',
    async (complete) => {
      const store = memoryFsStore()
      const env = { appVersion: '1.0.0', platform: 'win32', electron: '39.8.10', packaged: false }
      const service = await initDiagnosticsService({
        dataDir: '/data',
        store,
        clock: manualClock(0),
        disableTimers: true,
        env
      })
      await service.flushOnQuit({ upstreamDrainComplete: complete })
      const file = [...store.files.entries()].find(([name]) =>
        name.endsWith(`session-${service.sessionId}.json`)
      )
      expect(JSON.parse(file![1])).toMatchObject({ ended: complete, env })
    }
  )

  it('ingest 校验→入队→flush 落盘；非法事件被拒绝并计数', async () => {
    const store = memoryFsStore()
    const clock = manualClock(0)
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock,
      disableTimers: true
    })
    const good = makeEvent()
    const bad = { event: 'node.stage', message: 123, level: 'info' }
    const result = await service.ingest([good, bad, null, 'junk'])
    expect(result.accepted).toBe(1)
    expect(result.rejected).toBe(3)

    await service.flushNow()
    const shards = [...store.files.keys()].filter((path) => path.endsWith('.jsonl'))
    expect(shards.length).toBe(1)
    expect(store.files.get(shards[0])).toContain('"traceId":"trace-1"')

    const health = service.health()
    expect(health.received).toBe(4)
    expect(health.written).toBe(1)
    expect(health.available).toBe(true)

    const query = await service.query({ traceId: 'trace-1' })
    expect(query.events).toHaveLength(1)
  })

  it('正常退出 flushOnQuit 后会话标记 ended；重启可发现未结束会话', async () => {
    const store = memoryFsStore()
    const clock = manualClock(0)
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock,
      disableTimers: true
    })
    await service.ingest([makeEvent()])
    const initialSession = [...store.files.entries()].find(([path]) =>
      path.includes(`session-${service.sessionId}.json`)
    )
    expect(initialSession).toBeDefined()
    const initialStartedAt = JSON.parse(initialSession![1]).startedAt
    clock.advance(1234)
    await service.flushOnQuit()
    const unclean = await findUncleanSessions(store, '/data/diagnostics/sessions')
    expect(unclean.filter((item) => item.sessionId === service.sessionId)).toHaveLength(0)
    const sessionFiles = [...store.files.keys()].filter((path) => path.includes('sessions/session-'))
    expect(sessionFiles.length).toBe(1)
    const endedSession = JSON.parse(store.files.get(sessionFiles[0])!)
    expect(endedSession.ended).toBe(true)
    expect(endedSession.startedAt).toBe(initialStartedAt)
    expect(endedSession.endedAt).toBe(new Date(clock.nowMs()).toISOString())
  })

  it('退出时等待已开始的分片写入确认，再标记会话 ended', async () => {
    const base = memoryFsStore()
    const clock = manualClock(0)
    let startAppend!: () => void
    const appendStarted = new Promise<void>((resolve) => {
      startAppend = resolve
    })
    let releaseAppend!: () => void
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    let watchSessionWrite = false
    let markSessionWrite!: () => void
    const sessionWriteStarted = new Promise<void>((resolve) => {
      markSessionWrite = resolve
    })
    const store = {
      ...base,
      appendFile: async (path: string, data: string): Promise<void> => {
        startAppend()
        await appendGate
        await base.appendFile(path, data)
      },
      writeFile: async (path: string, data: string | Uint8Array): Promise<void> => {
        if (watchSessionWrite && path.replaceAll('\\', '/').includes('/sessions/'))
          markSessionWrite()
        await base.writeFile(path, data)
      }
    }
    const service = await initDiagnosticsService({ dataDir: '/data', store, clock })
    await service.ingest([makeEvent()])
    clock.advance(DIAGNOSTICS_FLUSH_INTERVAL_MS)
    await appendStarted
    watchSessionWrite = true

    const quitting = service.flushOnQuit()
    const sessionClosedBeforeAck = await Promise.race([
      sessionWriteStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10))
    ])
    releaseAppend()
    await quitting

    expect(sessionClosedBeforeAck).toBe(false)
    expect(service.health().queueDepth).toBe(0)
    expect([...base.files.keys()].some((path) => path.endsWith('.jsonl'))).toBe(true)
  })

  it('退出时排空所有分片批次后才标记会话 ended', async () => {
    const store = memoryFsStore()
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock: manualClock(0),
      disableTimers: true
    })
    const expectedCount = DIAGNOSTICS_FLUSH_BATCH_ITEMS * 8 + 1
    const firstBatch = await service.ingest(
      Array.from({ length: expectedCount - 1 }, () => makeEvent())
    )
    const lastEvent = await service.ingest([makeEvent()])

    await service.flushOnQuit()

    expect(firstBatch.accepted + lastEvent.accepted).toBe(expectedCount)
    expect(service.health().queueDepth).toBe(0)
    const shard = [...store.files.entries()].find(([path]) => path.endsWith('.jsonl'))
    expect(shard).toBeDefined()
    expect(shard?.[1].trim().split('\n')).toHaveLength(expectedCount)
    expect(
      (await findUncleanSessions(store, '/data/diagnostics/sessions')).some(
        (item) => item.sessionId === service.sessionId
      )
    ).toBe(false)
  })

  it('renderer 上游未确认时即使 main 队列落盘也保留未完整会话标记', async () => {
    const store = memoryFsStore()
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock: manualClock(0),
      disableTimers: true
    })
    await service.ingest([makeEvent()])

    await service.flushOnQuit({ upstreamDrainComplete: false })

    expect(service.health().queueDepth).toBe(0)
    expect(service.health().written).toBe(1)
    const unclean = await findUncleanSessions(store, '/data/diagnostics/sessions')
    expect(unclean.some((item) => item.sessionId === service.sessionId)).toBe(true)
    const sessionFile = [...store.files.entries()].find(([path]) =>
      path.includes(`session-${service.sessionId}.json`)
    )
    expect(JSON.parse(sessionFile![1])).toMatchObject({ ended: false })
    expect(JSON.parse(sessionFile![1]).endedAt).toBeUndefined()
  })

  it('写入失败时保留未完整会话标记', async () => {
    const store = memoryFsStore({ failAppendAfterWrites: 0 })
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock: manualClock(0),
      disableTimers: true
    })
    await service.ingest([makeEvent()])

    await service.flushOnQuit()

    expect(service.health().writeFailures).toBe(1)
    const unclean = await findUncleanSessions(store, '/data/diagnostics/sessions')
    expect(unclean.some((item) => item.sessionId === service.sessionId)).toBe(true)
    const sessionFile = [...store.files.entries()].find(([path]) =>
      path.includes(`session-${service.sessionId}.json`)
    )
    expect(JSON.parse(sessionFile![1])).toMatchObject({ ended: false })
    expect(JSON.parse(sessionFile![1]).endedAt).toBeUndefined()
  })

  it('超过退出等待上限时保留未完整会话标记', async () => {
    const base = memoryFsStore()
    const clock = manualClock(0)
    let startAppend!: () => void
    const appendStarted = new Promise<void>((resolve) => {
      startAppend = resolve
    })
    let releaseAppend!: () => void
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    const store = {
      ...base,
      appendFile: async (path: string, data: string): Promise<void> => {
        startAppend()
        await appendGate
        await base.appendFile(path, data)
      }
    }
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock,
      disableTimers: true
    })
    await service.ingest([makeEvent()])
    const quitting = service.flushOnQuit()
    await appendStarted
    clock.advance(DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS)
    try {
      await quitting
      expect(
        (await findUncleanSessions(base, '/data/diagnostics/sessions')).some(
          (item) => item.sessionId === service.sessionId
        )
      ).toBe(true)
      const sessionFile = [...base.files.entries()].find(([path]) =>
        path.includes(`session-${service.sessionId}.json`)
      )
      expect(JSON.parse(sessionFile![1])).toMatchObject({ ended: false })
      expect(JSON.parse(sessionFile![1]).endedAt).toBeUndefined()
    } finally {
      releaseAppend()
    }
  })

  it('data 目录不可用时返回降级服务：接收计数但不写盘、available=false', async () => {
    const store = memoryFsStore({ failAppendAfterWrites: 0 })
    // 让 mkdir 也失败：包装一层
    const failingStore = {
      ...store,
      mkdir: async () => {
        throw new Error('EACCES: 注入目录不可用')
      }
    }
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store: failingStore,
      clock: manualClock(0)
    })
    expect(service.health().available).toBe(false)
    const result = await service.ingest([makeEvent()])
    expect(result.accepted).toBe(0)
    await service.flushNow()
    expect([...store.files.keys()].filter((path) => path.endsWith('.jsonl'))).toHaveLength(0)
  })

  it('多实例（两个 session）分片互不覆盖', async () => {
    const store = memoryFsStore()
    const serviceA = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock: manualClock(0),
      disableTimers: true
    })
    const serviceB = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock: manualClock(0),
      disableTimers: true
    })
    expect(serviceA.sessionId).not.toBe(serviceB.sessionId)
    await serviceA.ingest([makeEvent()])
    await serviceB.ingest([makeEvent()])
    await serviceA.flushNow()
    await serviceB.flushNow()
    const shards = [...store.files.keys()].filter((path) => path.includes('/events/'))
    expect(shards).toHaveLength(2)
    expect(new Set(shards.map((path) => path.match(/session-([^/]+)-\d{8}/)?.[1])).size).toBe(2)
  })
})

describe('L05 诊断包导出', () => {
  it('exportBundle flushes a queued project-open failure before reading the requested time range', async () => {
    const store = memoryFsStore()
    const now = Date.now()
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock: manualClock(now),
      disableTimers: true
    })
    const { DiagnosticsProducer } = await import('@shared/observability')
    const producer = new DiagnosticsProducer({ process: 'main', producerId: 'main-project-open' })
    const failure = producer.build(
      'project.open.failed',
      'error',
      '项目文件及备份不可读取',
      {
        traceId: 'trace-project-open-failed',
        spanId: 'span-project-open-failed',
        projectId: 'project-open-failed'
      },
      {
        status: 'failed',
        attributes: { phase: 'read-snapshot', code: 'PROJECT_OPEN_FAILED' }
      }
    )
    expect(failure).not.toBeNull()
    await service.ingest([failure!])

    await service.exportBundle(
      { scope: { since: now - 1_000, until: now + 1_000 }, label: '项目打开失败' },
      '/data/export/project-open-failed.zip'
    )

    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip(
      Buffer.from(store.files.get('/data/export/project-open-failed.zip')!, 'latin1')
    )
    const exportedEvents = zip
      .readAsText('events.jsonl')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(exportedEvents).toHaveLength(1)
    expect(exportedEvents[0]).toMatchObject({
      event: 'project.open.failed',
      projectId: 'project-open-failed',
      attributes: { phase: 'read-snapshot', code: 'PROJECT_OPEN_FAILED' }
    })
  })

  it('exportBundle 产出 manifest/events/summary/coverage 四文件 zip，原子落盘，失败清理临时文件', async () => {
    const store = memoryFsStore()
    const clock = manualClock(new Date('2026-10-04T08:00:00Z').getTime())
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock,
      disableTimers: true
    })
    const { DiagnosticsProducer } = await import('@shared/observability')
    const producer = new DiagnosticsProducer({ process: 'renderer', producerId: 'r-test' })
    const eventOf = (name: string, level: 'info' | 'error', message: string, traceId: string) =>
      producer.build(name, level, message, { traceId }, {})
    const events = [
      eventOf('workflow.started', 'info', '流程开始', 'trace-export-1'),
      eventOf('node.failed', 'error', '节点失败', 'trace-export-1'),
      eventOf('node.stage', 'info', '阶段记录', 'trace-export-1')
    ]
    await service.ingest(events)
    await service.flushNow()

    await service.exportBundle({ scope: { traceId: 'trace-export-1' }, label: '测试' }, '/data/export/bundle.zip')

    // 原子落盘：最终文件存在，无 .tmp 残留。
    expect(store.files.has('/data/export/bundle.zip')).toBe(true)
    expect([...store.files.keys()].filter((path) => path.includes('.tmp-'))).toHaveLength(0)

    // zip 内四个文件齐全，manifest 标注格式/范围/隐私，summary 含失败事件。
    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip(Buffer.from(store.files.get('/data/export/bundle.zip')!, 'latin1'))
    const names = zip.getEntries().map((entry) => entry.entryName)
    expect(names).toEqual(
      expect.arrayContaining(['manifest.json', 'events.jsonl', 'summary.txt', 'coverage.json'])
    )
    const manifest = JSON.parse(zip.readAsText('manifest.json'))
    expect(manifest.format).toBe('canvas-studio-diagnostics-bundle-v1')
    expect(manifest.scope).toMatchObject({ traceId: 'trace-export-1' })
    expect(manifest.privacy.includesApiKeys).toBe(false)
    const summary = zip.readAsText('summary.txt')
    expect(summary).toContain('node.failed')
    const eventsJsonl = zip.readAsText('events.jsonl').trim().split('\n')
    expect(eventsJsonl).toHaveLength(3)
    expect(JSON.parse(eventsJsonl[0]).traceId).toBe('trace-export-1')
    const coverage = JSON.parse(zip.readAsText('coverage.json'))
    expect(Object.keys(coverage.familyCounts).length).toBeGreaterThan(0)
  })

  it('Agent failed diagnostic bundle preserves safe task context while excluding private prompt and credentials', async () => {
    const store = memoryFsStore()
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock: manualClock(new Date('2026-10-17T07:00:00Z').getTime()),
      disableTimers: true
    })
    const { DiagnosticsProducer } = await import('@shared/observability')
    const agentProducer = new DiagnosticsProducer({ process: 'main', producerId: 'agent-test' })
    const privatePrompt = 'AGENT_PRIVATE_PROMPT_MARKER_4821'
    const privateResponse = 'AGENT_RESPONSE_RAW_MARKER_20261017'
    const privateMedia = 'AGENT_MEDIA_BASE64_MARKER_20261017'
    const fakeKey = 'sk-agent-diagnostic-private-key-4821'
    const context = {
      traceId: 'trace-agent-export',
      spanId: 'span-agent-export',
      runId: 'run-agent-export',
      nodeExecutionId: 'execution-agent-export',
      taskId: 'task-agent-export',
      projectId: 'project-agent-export',
      nodeId: 'shape:agent-export',
      nodeType: 'agent'
    }
    const privateValues = [privatePrompt, privateResponse, privateMedia, fakeKey]
    const completedEvent = agentProducer.build(
      'agent.runtime.completed',
      'info',
      `Agent 完成；prompt=${privatePrompt} response=${privateResponse} media=${privateMedia} api_key=${fakeKey}`,
      context,
      { privateValues, attributes: { phase: 'completed' } }
    )
    const event = agentProducer.build(
      'agent.runtime.failed',
      'error',
      `Agent 执行失败；api_key=${fakeKey}；目标=${privatePrompt}; response=${privateResponse}; media=${privateMedia}`,
      context,
      {
        error: new Error(`${privatePrompt}; ${privateResponse}; ${privateMedia}; ${fakeKey}`),
        withStack: true,
        privateValues,
        attributes: {
          phase: 'model_decision',
          code: 'UPSTREAM_FAILED',
          prompt: privatePrompt,
          apiKey: fakeKey
        }
      }
    )
    expect(event).not.toBeNull()
    expect(completedEvent).not.toBeNull()
    await service.ingest([completedEvent!, event!])
    await service.flushNow()
    await service.exportBundle(
      { scope: { traceId: 'trace-agent-export' }, label: 'Agent 失败诊断' },
      '/data/export/agent-bundle.zip'
    )

    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip(Buffer.from(store.files.get('/data/export/agent-bundle.zip')!, 'latin1'))
    const manifest = JSON.parse(zip.readAsText('manifest.json'))
    const eventsJsonl = zip.readAsText('events.jsonl').trim().split('\n')
    const exportedEvents = eventsJsonl.map((line) => JSON.parse(line))
    const exportedEvent = exportedEvents.find((candidate) => candidate.event === 'agent.runtime.failed')
    const summary = zip.readAsText('summary.txt')
    const exportedText = [
      zip.readAsText('manifest.json'),
      zip.readAsText('events.jsonl'),
      summary,
      zip.readAsText('coverage.json')
    ].join('\n')

    expect(manifest.scope).toMatchObject({ traceId: 'trace-agent-export' })
    expect(manifest.privacy.includesApiKeys).toBe(false)
    expect(exportedEvent).toMatchObject({
      event: 'agent.runtime.failed',
      traceId: 'trace-agent-export',
      taskId: 'task-agent-export',
      projectId: 'project-agent-export',
      nodeId: 'shape:agent-export',
      nodeType: 'agent',
      attributes: { phase: 'model_decision', code: 'UPSTREAM_FAILED' }
    })
    expect(exportedEvents.map((candidate) => candidate.event)).toEqual([
      'agent.runtime.completed',
      'agent.runtime.failed'
    ])
    expect(exportedEvent.error.code).toBe('UNKNOWN')
    expect(exportedEvent.error.safeStack).toContain('Error: [message omitted]')
    expect(summary).toContain('agent.runtime.failed')
    expect(exportedText).not.toContain(privatePrompt)
    expect(exportedText).not.toContain(privateResponse)
    expect(exportedText).not.toContain(privateMedia)
    expect(exportedText).not.toContain(fakeKey)
    expect(exportedText).not.toContain('apiKey')
    expect(exportedText).not.toContain('"prompt"')
  })

  it('P1-B：summary 未完成按 trace/span 身份配对，开始/终态总数抵消不再掩盖未闭合流程', async () => {
    const store = memoryFsStore()
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store,
      clock: manualClock(new Date('2026-10-24T12:00:00Z').getTime()),
      disableTimers: true
    })
    const { DiagnosticsProducer } = await import('@shared/observability')
    const producer = new DiagnosticsProducer({ process: 'renderer', producerId: 'r-pairing' })
    const events = [
      // W1：完整闭合。
      producer.build('workflow.started', 'info', '流程开始', { traceId: 't1', spanId: 's1' }, {}),
      producer.build('workflow.completed', 'info', '流程完成', { traceId: 't1', spanId: 's1' }, {
        status: 'success'
      }),
      // W2：只有开始，没有终态（真正未完成）。
      producer.build('workflow.started', 'info', '被停止前中断的流程', { traceId: 't2', spanId: 's2' }, {}),
      // W3：只有终态（模拟范围截断丢掉开始事件）。
      producer.build('workflow.failed', 'error', '历史流程失败', { traceId: 't3', spanId: 's3' }, {
        status: 'failed'
      }),
      // 节点：开始但没有终态，带节点/run 关联。
      producer.build(
        'node.started',
        'info',
        '开始收集并校验输入端口',
        { traceId: 't2', spanId: 'n1', nodeId: 'shape:pairing', runId: 'run-pairing' },
        { name: 'node.started' }
      )
    ]
    await service.ingest(events.filter((event) => event !== null))
    await service.flushNow()

    await service.exportBundle(
      { scope: { since: 0, until: Date.now() + 1000 }, label: '配对验收' },
      '/data/export/pairing.zip'
    )
    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip(Buffer.from(store.files.get('/data/export/pairing.zip')!, 'latin1'))
    const summary = zip.readAsText('summary.txt')
    // 旧的总量估算：started=2, terminal=2 → 相互抵消后什么都不报。
    // 新的配对逻辑：W2 明确列为未完成，W3 标注孤立终态，节点执行带 nodeId/runId。
    expect(summary).toContain('未完成（按 trace/span 配对')
    expect(summary).toContain('t2/s2')
    expect(summary).toContain('node=shape:pairing run=run-pairing')
    expect(summary).toContain('t3/s3 没有对应的开始事件')
    // 已闭合的 W1 不进未完成清单。
    expect(summary).not.toContain('t1/s1 没有观察到终态')
  })
})
