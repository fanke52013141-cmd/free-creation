// L04 视频链路事件测试：重启恢复（A09）与 429 退避重试（A03）。
// DB / 供应商仓库 / 媒体入库全部 mock；上游响应用确定性 fetch fixture。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DiagnosticsEventInput } from '../../src/shared/observability'
import { setGatewayEventSink } from '../../src/main/diagnostics/gateway-events'

// better-sqlite3 为 Electron ABI 编译：db/providers.repo 必须整体 mock。
vi.mock('../../src/main/store/db', () => ({
  getDataDir: () => process.env.CANVAS_DATA_DIR ?? tmpdir(),
  getDb: () => fakeDb()
}))
vi.mock('../../src/main/store/media.repo', () => ({
  readMediaBuffer: vi.fn(async () => null),
  saveFileAsset: vi.fn(async () => ({
    id: 'media-1',
    path: 'projects/media-1.mp4',
    mime: 'video/mp4',
    name: 'v'
  }))
}))
vi.mock('../../src/main/gateway/factory', () => {
  class GatewayError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return { GatewayError }
})
vi.mock('../../src/main/gateway/providers.repo', () => ({
  getProvider: vi.fn(() => ({
    id: 'provider-seedance',
    name: 'S1',
    specId: 'seedance',
    baseURL: 'https://seedance.example',
    apiKey: 'sk-faketestkey1234567890',
    models: [],
    createdAt: 0
  }))
}))

const TASK_ROW = {
  id: 'task-local-1',
  provider_id: 'provider-seedance',
  model_id: 'seedance-model',
  node_id: 'shape:video-1',
  project_id: 'project-1',
  kind: 'video',
  status: 'running',
  input: JSON.stringify({ prompt: '假提示词', upstreamTaskId: 'up-1' }),
  attempts: 0,
  created_at: 0,
  updated_at: 0,
  error: null,
  output: null
}

let runningRows: Array<Record<string, unknown>> = []

function fakeDb(): {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown; all: () => unknown[]; run: (...args: unknown[]) => unknown }
} {
  return {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.includes('SELECT input FROM tasks')) {
          const row = runningRows.find((item) => item.id === args[0])
          return row ? { input: row.input } : undefined
        }
        if (sql.includes('SELECT status FROM tasks')) {
          const row = runningRows.find((item) => item.id === args[0])
          return row ? { status: row.status } : undefined
        }
        return undefined
      },
      all: () => (sql.includes("status IN ('submitted', 'running')") ? [...runningRows] : []),
      run: (...args: unknown[]) => {
        if (sql.includes("UPDATE tasks SET status = 'failed'") || sql.includes("status = 'success'")) {
          const id = args[args.length - 1] as string
          const row = runningRows.find((item) => item.id === id)
          if (row) row.status = sql.includes('failed') ? 'failed' : 'success'
        }
        return undefined
      }
    })
  }
}

function webBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
}

describe('L04 视频链路结构化事件', () => {
  let events: DiagnosticsEventInput[] = []
  const sendEvents: unknown[] = []
  let tempDir: string

  beforeEach(() => {
    events = []
    sendEvents.length = 0
    tempDir = mkdtempSync(join(tmpdir(), 'video-diag-'))
    process.env.CANVAS_DATA_DIR = tempDir
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
  })

  afterEach(() => {
    setGatewayEventSink(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    runningRows = []
  })

  it('A09 · 重启恢复：resume_started → 恢复轮询 → 下载入库，绝不重复提交', async () => {
    runningRows = [TASK_ROW]
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      if (href.includes('/contents/generations/tasks/up-1')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => '',
          json: async () => ({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
        } as unknown as Response
      }
      if (href.startsWith('https://cdn.example/')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'video/mp4' }),
          body: webBody(new Uint8Array([1, 2, 3]))
        } as unknown as Response
      }
      throw new Error(`unexpected fetch ${href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { resumePendingVideoTasks } = await import('../../src/main/gateway/video')
    resumePendingVideoTasks((event: unknown) => sendEvents.push(event))
    await new Promise((resolve) => setTimeout(resolve, 120))

    const names = events.map((event) => event.event)
    expect(names).toContain('task.resume_started')
    expect(names).toContain('task.state_changed')
    expect(names).toContain('media.download_completed')
    expect(names).toContain('media.persist_completed')

    // A09 关键断言：恢复过程中没有向下游供应商提交任何新任务（无 POST）。
    const postCalls = fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(postCalls).toHaveLength(0)
    // 恢复事件携带稳定本地 taskId；旧 trace 未知 → 显式 correlationMissing。
    const resumed = events.find((event) => event.event === 'task.state_changed')
    expect(resumed?.taskId).toBe('task-local-1')
    expect(resumed?.upstreamTaskId).toBe('up-1')
    expect(resumed?.correlationMissing).toBe(true)
    expect(resumed?.traceId).toBeTruthy()
    // 业务回执照常发出（日志不改变恢复行为）。
    expect(
      sendEvents.some((event) => (event as { kind?: string; mediaId?: string }).kind === 'video-done')
    ).toBe(true)
  })

  it('A09 · 缺 upstreamTaskId 的任务恢复被阻断并记录原因', async () => {
    runningRows = [{ ...TASK_ROW, id: 'task-broken', input: JSON.stringify({ prompt: 'x' }) }]
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { resumePendingVideoTasks } = await import('../../src/main/gateway/video')
    resumePendingVideoTasks((event: unknown) => sendEvents.push(event))
    await new Promise((resolve) => setTimeout(resolve, 30))

    const blocked = events.filter((event) => event.event === 'task.resume_blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0].attributes?.reason).toBe('missing_upstream_task')
    expect(blocked[0].taskId).toBe('task-broken')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('A03 · 提交被 429 限流：同 requestId 下 attempt 递增、等待被记录，重试后成功', async () => {
    // 直接驱动 submitWithBackoff 同款语义：用 submitVideoTask + 恢复型轮询太重，
    // 这里对准事件契约本身：429 → attempt_failed(RATE_LIMITED) → retry_scheduled(waitMs) → 成功。
    vi.useFakeTimers()
    let calls = 0
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/contents/generations/tasks') && init?.method === 'POST') {
        calls += 1
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: new Headers(),
            text: async () => 'rate limited',
            json: async () => ({})
          } as unknown as Response
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => '',
          json: async () => ({ id: 'up-9' })
        } as unknown as Response
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { submitVideoTask } = await import('../../src/main/gateway/video')
    // 规避在途去重与参考资源校验：直接走 submitWithBackoff 的公开入口不可行，
    // 使用 submitVideoTask（mock DB 无在途任务、无参考图）。
    const result = submitVideoTask((event: unknown) => sendEvents.push(event), {
      projectId: 'project-1',
      nodeId: 'shape:video-9',
      providerId: 'provider-seedance',
      modelId: 'seedance-model',
      prompt: '假提示词',
      diagnostics: { traceId: 'trace-video-1', requestId: 'req-video-1' }
    })
    expect(result.taskId).toBeTruthy()
    // 第一次提交已被 429 拒绝；驱动退避等待（5s/15s）后第二次提交成功。
    await vi.advanceTimersByTimeAsync(5_100)
    // 停止轮询循环继续 sleep：清空 runningRows 让 pollLoop 快速失败退出。
    runningRows = []
    await vi.advanceTimersByTimeAsync(30_000)

    const attemptFailed = events.find((event) => event.event === 'model.request.attempt_failed')
    expect(attemptFailed).toBeTruthy()
    expect(attemptFailed!.error?.code).toBe('RATE_LIMITED')
    expect(attemptFailed!.requestId).toBe('req-video-1')
    const retry = events.find((event) => event.event === 'model.request.retry_scheduled')
    expect(retry?.attempt).toBe(attemptFailed!.attempt! + 1)
    expect(retry?.attributes?.waitMs).toBeGreaterThan(0)
    // 第二次提交发生在退避之后；两次提交共用同一逻辑请求 ID。
    expect(calls).toBe(2)
    vi.useRealTimers()
  })
})
