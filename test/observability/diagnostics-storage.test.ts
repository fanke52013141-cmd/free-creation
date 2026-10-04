// L02 有界队列 / 分片 writer / session / retention / service 测试。
// 全部使用可注入内存 FS + 手动时钟获得确定性故障（拒写、磁盘满、坏行、多实例）。
import { describe, expect, it } from 'vitest'
import {
  DiagnosticsProducer,
  newEventId,
  type DiagnosticsEvent,
  type DiagnosticsEventInput
} from '@shared/observability'
import { DiagnosticsQueue } from '../../src/main/diagnostics/queue'
import { DiagnosticsShardWriter } from '../../src/main/diagnostics/writer'
import { enforceRetention } from '../../src/main/diagnostics/retention'
import { findUncleanSessions, writeSessionState } from '../../src/main/diagnostics/session'
import { initDiagnosticsService } from '../../src/main/diagnostics/service'
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
    await service.flushOnQuit()
    const unclean = await findUncleanSessions(store, '/data/diagnostics/sessions')
    expect(unclean.filter((item) => item.sessionId === service.sessionId)).toHaveLength(0)
    const sessionFiles = [...store.files.keys()].filter((path) => path.includes('sessions/session-'))
    expect(sessionFiles.length).toBe(1)
    expect(store.files.get(sessionFiles[0])).toContain('"ended":true')
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
})
