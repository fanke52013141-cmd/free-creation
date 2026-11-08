// F9（三）外部接入测试：诊断查询 + 项目节点可见集读写。
//
// 覆盖：
// - diagnostics.query 复用真实 DiagnosticsService（内存文件系统 + 手动时钟），分页/过滤、
//   二次脱敏（假密钥、私有提示词、未登记 attributes、safeStack 不出现在输出）、
//   服务不可用/降级时如实报码而不是空成功、非法参数拒绝；
// - project.nodeVisibility.get 新项目=全部可创建类型、旧项目=legacy-all-visible（不伪造 general）；
// - project.nodeVisibility.set 走 projects.repo.saveWorkspaceProfile 正式保存并读回、差异回执、
//   未知/重复/空集/非法参数拒绝、跨项目隔离、幂等重放不产生第二次写。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ACTIVE_NODE_TYPE_IDS } from '../src/shared/types'
import { allWorkspaceProfile } from '../src/shared/workspace-profile'
import { DiagnosticsProducer } from '../src/shared/observability'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, projectJsonPath } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { initDiagnosticsService, type DiagnosticsService } from '../src/main/diagnostics/service'
import { memoryFsStore } from '../src/main/diagnostics/fs-types'

let directory: string
let service: LocalAccessService
let active: string | null
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`
const BASE_TIME = Date.parse('2026-11-08T08:00:00.000Z')

function call(operationId: string, input: unknown = {}, idempotencyKey?: string) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey ? { idempotencyKey } : {})
  })
}

function withDiagnostics(diagnostics: DiagnosticsService | null): void {
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active,
    diagnostics
  })
}

/** 受控时钟的生产者：事件 timestamp 由测试指定，便于时间窗过滤断言。 */
function productionEvent(
  atMs: number,
  name: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, unknown>,
  options: Record<string, unknown> = {}
) {
  const producer = new DiagnosticsProducer({
    process: 'main',
    producerId: 'main-test',
    now: () => atMs
  })
  const built = producer.build(name, level, message, context, options)
  if (!built) throw new Error(`EVENT_BUILD_FAILED:${name}`)
  return built
}

async function seededDiagnostics(eventsToIngest: unknown[]): Promise<DiagnosticsService> {
  const diagnostics = await initDiagnosticsService({
    dataDir: directory,
    store: memoryFsStore(),
    disableTimers: true
  })
  const ingested = await diagnostics.ingest(eventsToIngest)
  expect(ingested.rejected).toBe(0)
  await diagnostics.flushNow()
  return diagnostics
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-diagnostics-visibility-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  withDiagnostics(null)
})

afterEach(() => {
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-diagnostics-visibility-test-')
  )
    throw new Error('DIAGNOSTICS_VISIBILITY_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('diagnostics.query', () => {
  it('pages and filters the same diagnostics store the GUI reads', async () => {
    const diagnostics = await seededDiagnostics([
      productionEvent(BASE_TIME, 'model.request.started', 'info', '准备提交生图请求', {
        traceId: 'trace-a',
        nodeId: 'shape:img',
        projectId: 'project-1'
      }, { attributes: { operation: 'image.generate', modelId: 'm-1', providerId: 'p-1' } }),
      productionEvent(BASE_TIME + 1000, 'node.completed', 'info', '节点执行完成', {
        traceId: 'trace-a',
        nodeId: 'shape:img'
      }, { attributes: { portCount: 1 }, status: 'success' }),
      productionEvent(BASE_TIME + 2000, 'node.failed', 'error', '节点执行失败', {
        traceId: 'trace-b',
        nodeId: 'shape:txt'
      }, {
        status: 'failed',
        error: { code: 'UPSTREAM_FAILED', category: 'upstream', retryable: false }
      })
    ])
    withDiagnostics(diagnostics)

    const first = await call('diagnostics.query', { traceId: 'trace-a', limit: 1 })
    expect(first.status).toBe('completed')
    const page1 = first.data as any
    expect(page1).toMatchObject({
      returned: 1,
      offset: 0,
      limit: 1,
      source: 'diagnostics-store',
      redaction: 'event-whitelist@1'
    })
    expect(page1.events).toHaveLength(1)
    expect(page1.events[0]).toMatchObject({
      event: 'model.request.started',
      traceId: 'trace-a',
      nodeId: 'shape:img',
      projectId: 'project-1',
      attributes: { operation: 'image.generate', modelId: 'm-1', providerId: 'p-1' }
    })
    expect(page1.truncated).toBe(true)
    expect(page1.nextOffset).toBe(1)

    const second = await call('diagnostics.query', { traceId: 'trace-a', offset: 1, limit: 5 })
    const page2 = second.data as any
    expect(page2.events.map((event: any) => event.event)).toEqual(['node.completed'])
    expect(page2.events[0].status).toBe('success')
    expect(page2.nextOffset).toBeNull()

    // 级别过滤 + 错误字段投影（producer 会把投递的 error 对象归一化为稳定 code/retryable）
    const errors = (await call('diagnostics.query', { level: 'error' })).data as any
    expect(errors.events).toHaveLength(1)
    expect(errors.events[0]).toMatchObject({
      event: 'node.failed',
      level: 'error',
      status: 'failed',
      error: {
        code: 'UPSTREAM_FAILED',
        category: 'upstream',
        retryable: true,
        sourceCode: 'UPSTREAM_FAILED'
      }
    })
    // 节点过滤
    expect(
      ((await call('diagnostics.query', { nodeId: 'shape:txt' })).data as any).events
    ).toHaveLength(1)
    // 时间窗过滤（since 用事件发生时间）
    const since = (await call('diagnostics.query', { since: BASE_TIME + 1000 })).data as any
    expect(since.events.map((event: any) => event.event)).toEqual([
      'node.completed',
      'node.failed'
    ])
    const window = (
      await call('diagnostics.query', { since: BASE_TIME, until: BASE_TIME + 500 })
    ).data as any
    expect(window.events.map((event: any) => event.event)).toEqual(['model.request.started'])
    // 未命中：成功的空结果（与"服务不可用"区分）
    const empty = await call('diagnostics.query', { traceId: 'trace-missing' })
    expect(empty.status).toBe('completed')
    expect(empty.data).toMatchObject({ returned: 0, events: [], nextOffset: null })
  })

  it('re-redacts credentials and never returns prompts, unregistered attributes or safeStack', async () => {
    const diagnostics = await seededDiagnostics([
      // 生产者路径：privateValues 中的用户正文在写日志前就被替换掉。
      productionEvent(BASE_TIME, 'node.started', 'info', '用户正文：私有提示词正文', {
        traceId: 'trace-p'
      }, { privateValues: ['私有提示词正文'] }),
      // 历史行/旧版本可能带未登记 attributes 与 safeStack：查询投影必须再收口。
      {
        event: 'model.request.started',
        level: 'info',
        message: '请求头 apiKey=sk-abcdefghijklmnopqrstuv 已脱敏检查',
        timestamp: new Date(BASE_TIME + 10).toISOString(),
        traceId: 'trace-p',
        attributes: {
          operation: 'image.generate',
          promptText: '未登记属性里的私有提示词',
          rawBody: '{"messages":[{"content":"原始请求体"}]}'
        },
        error: {
          code: 'RESPONSE_INVALID',
          category: 'upstream',
          retryable: true,
          safeStack: 'at secret-project/D:/private/path/file.ts:1:1'
        }
      }
    ])
    withDiagnostics(diagnostics)

    const response = await call('diagnostics.query', { traceId: 'trace-p', limit: 10 })
    expect(response.status).toBe('completed')
    const serialized = JSON.stringify(response)
    // 凭证与未登记属性不出现
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuv')
    expect(serialized).not.toContain('promptText')
    expect(serialized).not.toContain('rawBody')
    expect(serialized).not.toContain('原始请求体')
    // safeStack 与私有路径不出现
    expect(serialized).not.toContain('safeStack')
    expect(serialized).not.toContain('D:/private/path')
    // 生产者路径下的用户正文被替换成占位符
    expect(serialized).not.toContain('私有提示词正文')
    const projected = (response.data as any).events
    const started = projected.find((event: any) => event.event === 'model.request.started')
    expect(started.attributes).toEqual({ operation: 'image.generate' })
    expect(started.error).toEqual({
      code: 'RESPONSE_INVALID',
      category: 'upstream',
      retryable: true
    })
    expect(started.message).not.toContain('sk-abcdefghijklmnopqrstuv')
  })

  it('reports DIAGNOSTICS_UNAVAILABLE instead of an empty success when storage is missing', async () => {
    // 未注入诊断服务（未初始化 / 启动失败）
    const missing = await call('diagnostics.query', {})
    expect(missing.status).toBe('failed')
    expect(missing.error?.code).toBe('DIAGNOSTICS_UNAVAILABLE')
    expect(missing.data).toBeUndefined()

    // 降级服务：数据目录不可用 → health.available=false，query 返回空数组也必须按不可用处理
    const brokenStore = memoryFsStore()
    brokenStore.mkdir = async () => {
      throw new Error('EACCES: 诊断目录不可写')
    }
    const degraded = await initDiagnosticsService({
      dataDir: directory,
      store: brokenStore,
      disableTimers: true
    })
    expect(degraded.health().available).toBe(false)
    withDiagnostics(degraded)
    const response = await call('diagnostics.query', { traceId: 'trace-a' })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('DIAGNOSTICS_UNAVAILABLE')
  })

  it('rejects unbounded or invalid query input', async () => {
    const diagnostics = await seededDiagnostics([])
    withDiagnostics(diagnostics)
    expect((await call('diagnostics.query', { level: 'trace' })).error?.code).toBe('INVALID_INPUT')
    expect((await call('diagnostics.query', { limit: 0 })).error?.code).toBe('INVALID_INPUT')
    expect((await call('diagnostics.query', { limit: 201 })).error?.code).toBe('INVALID_INPUT')
    expect((await call('diagnostics.query', { offset: 5001 })).error?.code).toBe('INVALID_INPUT')
    expect((await call('diagnostics.query', { since: -1 })).error?.code).toBe('INVALID_INPUT')
    expect(
      (await call('diagnostics.query', { traceId: 'trace a', limit: 10 })).error?.code
    ).toBe('INVALID_INPUT')
    expect(
      (await call('diagnostics.query', { traceId: 'trace-a', extra: true })).error?.code
    ).toBe('INVALID_INPUT')
  })
})

describe('project.nodeVisibility', () => {
  it('reports all creatable types for new projects and legacy-all-visible for old ones', async () => {
    const created = await call('project.create', { name: '可见集项目' }, key())
    expect(created.status).toBe('completed')
    const projectId = (created.data as any).meta.id as string
    const creatable = allWorkspaceProfile().visibleNodeTypeIds
    expect(creatable).toEqual([...ACTIVE_NODE_TYPE_IDS])

    const got = await call('project.nodeVisibility.get', { projectId })
    expect(got.status).toBe('completed')
    const data = got.data as any
    expect(data).toMatchObject({
      projectId,
      source: 'saved-profile',
      profile: { presetId: 'all', nodeSetRevision: expect.any(Number) },
      visibleCount: ACTIVE_NODE_TYPE_IDS.length,
      creatableCount: ACTIVE_NODE_TYPE_IDS.length,
      savedButNotCreatable: []
    })
    expect(data.effectiveVisibleNodeTypeIds).toEqual([...ACTIVE_NODE_TYPE_IDS])
    // 台账 34 的 8 类高级节点必须默认可见（外部建项目不得再"少节点"）
    for (const type of [
      'image-crop',
      'image-split',
      'video-clip',
      'video-depth',
      'video-clay',
      'voice-design',
      'director',
      'ai-process'
    ])
      expect(data.effectiveVisibleNodeTypeIds).toContain(type)

    // 旧项目：文件里没有 workspaceProfile（模拟历史项目），按"全部可创建节点"如实表达
    const legacy = createProject('旧项目')
    const rawPath = projectJsonPath(legacy.id)
    const raw = JSON.parse(readFileSync(rawPath, 'utf8'))
    delete raw.workspaceProfile
    writeFileSync(rawPath, JSON.stringify(raw, null, 2), 'utf8')
    const legacyData = (await call('project.nodeVisibility.get', { projectId: legacy.id }))
      .data as any
    expect(legacyData.profile).toBeNull()
    expect(legacyData.source).toBe('legacy-all-visible')
    expect(legacyData.effectiveVisibleNodeTypeIds).toEqual([...ACTIVE_NODE_TYPE_IDS])
    expect(legacyData.visibleCount).toBe(ACTIVE_NODE_TYPE_IDS.length)
  })

  it('writes a subset through the formal save path and reads it back', async () => {
    const project = createProject('可见集写入')
    const before = openProject(project.id)!
    const versionBefore = before.meta.graphVersion
    const requested = ['text', 'image', 'image-crop']
    const written = await call(
      'project.nodeVisibility.set',
      { projectId: project.id, visibleNodeTypeIds: [...requested, 'text'] },
      key()
    )
    // 重复项显式拒绝（不是静默去重）
    expect(written.status).toBe('failed')
    expect(written.error?.code).toBe('DUPLICATE_NODE_TYPE')

    const set = await call(
      'project.nodeVisibility.set',
      { projectId: project.id, visibleNodeTypeIds: requested },
      key()
    )
    expect(set.status).toBe('completed')
    const receipt = set.data as any
    expect(receipt).toMatchObject({
      projectId: project.id,
      saved: true,
      profile: { presetId: 'custom' },
      visibleCount: requested.length,
      desktopReloadRequired: false
    })
    expect(receipt.added).toEqual([])
    expect(receipt.removed).toEqual(
      ACTIVE_NODE_TYPE_IDS.filter((type) => !requested.includes(type))
    )
    // 正式保存机制落盘：重新 openProject 读回一致，图版本不因可见集推进
    const after = openProject(project.id)!
    expect(after.meta.graphVersion).toBe(versionBefore)
    expect(after.workspaceProfile?.visibleNodeTypeIds).toEqual(requested)
    expect(after.workspaceProfile?.presetId).toBe('custom')
    const reread = (await call('project.nodeVisibility.get', { projectId: project.id }))
      .data as any
    expect(reread.profile.visibleNodeTypeIds).toEqual(requested)
    expect(reread.visibleCount).toBe(requested.length)
    // 画布打开时明确告知需要重开项目
    active = project.id
    const activeSet = await call(
      'project.nodeVisibility.set',
      { projectId: project.id, visibleNodeTypeIds: [...ACTIVE_NODE_TYPE_IDS] },
      key()
    )
    expect(activeSet.data).toMatchObject({
      desktopReloadRequired: true,
      profile: { presetId: 'all' },
      visibleCount: ACTIVE_NODE_TYPE_IDS.length
    })
    active = null
  })

  it('rejects empty, unknown, retired and malformed visibility input', async () => {
    const project = createProject('可见集校验')
    expect(
      (
        await call(
          'project.nodeVisibility.set',
          { projectId: project.id, visibleNodeTypeIds: [] },
          key()
        )
      ).error?.code
    ).toBe('EMPTY_NODE_VISIBILITY')
    // 退役/未登记类型（group 属 Legacy 清单）
    expect(
      (
        await call(
          'project.nodeVisibility.set',
          { projectId: project.id, visibleNodeTypeIds: ['group'] },
          key()
        )
      ).error?.code
    ).toBe('UNKNOWN_NODE_TYPE')
    expect(
      (
        await call(
          'project.nodeVisibility.set',
          { projectId: project.id, visibleNodeTypeIds: ['text', 'not-a-real-node'] },
          key()
        )
      ).error?.code
    ).toBe('UNKNOWN_NODE_TYPE')
    // Schema 级拒绝
    expect(
      (
        await call(
          'project.nodeVisibility.set',
          { projectId: project.id, visibleNodeTypeIds: 'text' },
          key()
        )
      ).error?.code
    ).toBe('INVALID_INPUT')
    expect(
      (
        await call(
          'project.nodeVisibility.set',
          { projectId: project.id, visibleNodeTypeIds: ['TEXT!'] },
          key()
        )
      ).error?.code
    ).toBe('INVALID_INPUT')
    expect(
      (
        await call(
          'project.nodeVisibility.set',
          { projectId: project.id, visibleNodeTypeIds: ['text'], extra: 1 },
          key()
        )
      ).error?.code
    ).toBe('INVALID_INPUT')
    // 写入必须有幂等键（与全部写操作一致）
    expect(
      (
        await call('project.nodeVisibility.set', {
          projectId: project.id,
          visibleNodeTypeIds: ['text']
        })
      ).error?.code
    ).toBe('IDEMPOTENCY_REQUIRED')
    // 项目不存在
    expect(
      (await call('project.nodeVisibility.get', { projectId: 'missing-project' })).error?.code
    ).toBe('NOT_FOUND')
    expect(
      (
        await call(
          'project.nodeVisibility.set',
          { projectId: 'missing-project', visibleNodeTypeIds: ['text'] },
          key()
        )
      ).error?.code
    ).toBe('NOT_FOUND')
    // 被拒绝的写入没有留下半配置
    const file = openProject(project.id)!
    expect(file.workspaceProfile?.presetId).toBe('all')
  })

  it('keeps projects isolated and never rewrites another project', async () => {
    const a = createProject('项目A')
    const b = createProject('项目B')
    const bytesA = readFileSync(projectJsonPath(a.id), 'utf8')
    const set = await call(
      'project.nodeVisibility.set',
      { projectId: b.id, visibleNodeTypeIds: ['text', 'json'] },
      key()
    )
    expect(set.status).toBe('completed')
    // A 文件逐字节未变；B 写入不影响 A 的可见集
    expect(readFileSync(projectJsonPath(a.id), 'utf8')).toBe(bytesA)
    const aData = (await call('project.nodeVisibility.get', { projectId: a.id })).data as any
    expect(aData.profile.presetId).toBe('all')
    const bData = (await call('project.nodeVisibility.get', { projectId: b.id })).data as any
    expect(bData.profile.visibleNodeTypeIds).toEqual(['text', 'json'])
  })

  it('replays an idempotent write without a second save', async () => {
    const project = createProject('幂等写入')
    const writeKey = key()
    const first = await call(
      'project.nodeVisibility.set',
      { projectId: project.id, visibleNodeTypeIds: ['text', 'chat'] },
      writeKey
    )
    expect(first.status).toBe('completed')
    const bytesAfterFirst = readFileSync(projectJsonPath(project.id), 'utf8')
    const metaAfterFirst = openProject(project.id)!.meta
    const replay = await call(
      'project.nodeVisibility.set',
      { projectId: project.id, visibleNodeTypeIds: ['text', 'chat'] },
      writeKey
    )
    expect(replay.data).toEqual(first.data)
    // 重放不产生第二次写：项目文件逐字节一致，updatedAt 未再变化
    expect(readFileSync(projectJsonPath(project.id), 'utf8')).toBe(bytesAfterFirst)
    expect(openProject(project.id)!.meta.updatedAt).toBe(metaAfterFirst.updatedAt)
    // 不同意图复用同一幂等键被拒绝
    const conflict = await call(
      'project.nodeVisibility.set',
      { projectId: project.id, visibleNodeTypeIds: ['text'] },
      writeKey
    )
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT')
  })
})
