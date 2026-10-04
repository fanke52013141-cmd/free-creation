// L03 网关链路结构化事件测试：对话（mock AI SDK）与生图 TOAPIS（mock fetch）。
// 故障全部用确定性 fixture（401/流中断/取消竞争/下载失败），不发真实请求。
// 验收：A04（HTTP 错误码归一化）、A05（首片统计/正文不落日志）、A06（取消与迟到回包）、
// A07（远端成功但下载失败可区分，不误导为需要重新提交）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayEvent } from '../../src/shared/contracts'
import type { DiagnosticsEventInput } from '../../src/shared/observability'
import { setGatewayEventSink } from '../../src/main/diagnostics/gateway-events'
import { startChat, cancelChat } from '../../src/main/gateway/chat'

vi.mock('ai', () => ({
  streamText: vi.fn()
}))

// 不用 importOriginal：真实 factory 会拉起 providers.repo→db（better-sqlite3 为
// Electron ABI 编译，vitest 的 Node 无法加载）。GatewayError 用行为等价的替身。
vi.mock('../../src/main/gateway/factory', () => {
  class GatewayError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return {
    GatewayError,
    requireProvider: vi.fn(() => ({
      id: 'provider-toapis',
      name: 'P1',
      specId: 'toapis',
      baseURL: 'https://toapis.example',
      apiKey: 'sk-faketestkey1234567890',
      models: [],
      createdAt: 0
    })),
    createImageModel: vi.fn(() => ({})),
    createChatModel: vi.fn(() => ({}))
  }
})

vi.mock('../../src/main/store/media.repo', () => ({
  saveBufferAsset: vi.fn(),
  readMediaBuffer: vi.fn(async () => null)
}))

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), initialize: vi.fn() }
}))

describe('对话链路 model.request.* 事件（L03）', () => {
  let events: DiagnosticsEventInput[] = []
  const sendEvents: GatewayEvent[] = []

  beforeEach(() => {
    events = []
    sendEvents.length = 0
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
  })

  afterEach(() => {
    setGatewayEventSink(null)
    vi.restoreAllMocks()
  })

  const chatInput = (diagnostics?: Record<string, unknown>) => ({
    providerId: 'provider-a',
    modelId: 'model-a',
    messages: [{ role: 'user' as const, content: 'SECRET-PROMPT-CONTENT 请忽略' }],
    diagnostics: diagnostics as never
  })

  it('成功路径：started → first_chunk（首片耗时）→ completed（outputChars），正文不进入事件', async () => {
    const { streamText } = await import('ai')
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '你好' }
        yield { type: 'text-delta', text: '，世界' }
      })()
    } as never)

    const taskId = startChat((event) => sendEvents.push(event), chatInput({
      traceId: 'trace-chat-1',
      requestId: 'req-chat-1',
      nodeExecutionId: 'nexec-1'
    }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const names = events.map((event) => event.event)
    expect(names).toEqual([
      'model.request.started',
      'model.request.first_chunk',
      'model.request.completed'
    ])
    const completed = events[2]
    expect(completed.status).toBe('success')
    expect(completed.requestId).toBe('req-chat-1')
    expect(completed.traceId).toBe('trace-chat-1')
    expect(completed.attributes).toMatchObject({ outputChars: 5 })
    expect(completed.durationMs).toBeGreaterThanOrEqual(0)
    const dumped = JSON.stringify(events)
    expect(dumped).not.toContain('SECRET-PROMPT-CONTENT')
    expect(dumped).not.toContain('你好')
    expect(sendEvents.some((event) => event.kind === 'chat-done')).toBe(true)
    void taskId
  })

  it('HTTP 401：failed 事件携带稳定错误码 AUTH_FAILED 且不可重试（A04）', async () => {
    const { streamText } = await import('ai')
    vi.mocked(streamText).mockImplementation(() => {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    })

    startChat((event) => sendEvents.push(event), chatInput())
    await new Promise((resolve) => setTimeout(resolve, 20))

    const failed = events.find((event) => event.event === 'model.request.failed')
    expect(failed).toBeTruthy()
    expect(failed!.status).toBe('failed')
    expect(failed!.error?.code).toBe('AUTH_FAILED')
    expect(failed!.error?.retryable).toBe(false)
    expect(failed!.error?.httpStatus).toBe(401)
  })

  it('首片后流中断：first_chunk 与 failed 都存在，失败不丢首片统计（A05）', async () => {
    const { streamText } = await import('ai')
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '部分内容' }
        throw Object.assign(new Error('network reset'), { statusCode: 502 })
      })()
    } as never)

    startChat((event) => sendEvents.push(event), chatInput())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events.map((event) => event.event)).toEqual([
      'model.request.started',
      'model.request.first_chunk',
      'model.request.failed'
    ])
    expect(events[2].error?.code).toBe('UPSTREAM_FAILED')
    expect(events[2].error?.retryable).toBe(true)
  })

  it('用户取消与迟到回包竞争：cancelled 事件，远端结果未知（A06）', async () => {
    const { streamText } = await import('ai')
    vi.mocked(streamText).mockImplementation((options: { abortSignal?: AbortSignal }) => ({
      fullStream: (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 40))
        if (options.abortSignal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        yield { type: 'text-delta', text: '迟到的回复' }
      })()
    } as never))

    const taskId = startChat((event) => sendEvents.push(event), chatInput())
    expect(cancelChat(taskId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 80))

    const cancelled = events.find((event) => event.event === 'model.request.cancelled')
    expect(cancelled).toBeTruthy()
    expect(cancelled!.status).toBe('cancelled')
    // 不声称已远端取消：message 固定模板说明远端结果未知。
    expect(cancelled!.message).toContain('远端结果未知')
    expect(events.some((event) => event.event === 'model.request.failed')).toBe(false)
  })

  it('缺 trace 的调用方（旧路径）标记 correlationMissing，不伪造关联', async () => {
    const { streamText } = await import('ai')
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'ok' }
      })()
    } as never)

    startChat((event) => sendEvents.push(event), chatInput())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events[0].correlationMissing).toBe(true)
    expect(events[0].traceId).toBeUndefined()
  })
})

describe('生图 TOAPIS 链路 task/media 事件（L03）', () => {
  let events: DiagnosticsEventInput[] = []

  beforeEach(async () => {
    events = []
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
    const mediaRepo = await import('../../src/main/store/media.repo')
    vi.mocked(mediaRepo.saveBufferAsset).mockResolvedValue({
      id: 'media-1',
      path: 'projects/media-1.png',
      mime: 'image/png',
      name: 'x'
    } as never)
  })

  afterEach(() => {
    setGatewayEventSink(null)
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const imageInput = () => ({
    projectId: 'project-1',
    providerId: 'provider-toapis',
    modelId: 'gpt-image-2',
    prompt: 'SECRET-IMAGE-PROMPT 一只假想的猫',
    size: 'auto',
    diagnostics: {
      traceId: 'trace-img-1',
      runId: 'run-1',
      nodeExecutionId: 'nexec-img-1',
      requestId: 'req-img-1'
    } as never
  })

  function jsonResponse(status: number, body: string): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => JSON.parse(body),
      text: async () => body
    } as unknown as Response
  }

  it('完整成功路径：accepted → state_changed → task.completed → download → persist（同一 requestId）', async () => {
    const { generateImageToAsset } = await import('../../src/main/gateway/image')
    let pollCall = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/images/generations')) {
        return jsonResponse(200, JSON.stringify({ id: 'task-1', status: 'queued' }))
      }
      if (href.includes('/images/generations/task-1')) {
        pollCall += 1
        const status = pollCall === 1 ? 'processing' : 'completed'
        const payload =
          status === 'completed'
            ? { status, url: 'https://cdn.example/result.png' }
            : { status }
        return jsonResponse(200, JSON.stringify(payload))
      }
      if (href.startsWith('https://cdn.example/')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'image/png' }),
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
        } as unknown as Response
      }
      throw new Error(`unexpected fetch ${href}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const promise = generateImageToAsset(imageInput())
    await vi.advanceTimersByTimeAsync(2600)
    await vi.advanceTimersByTimeAsync(2600)
    const asset = await promise

    expect(asset.id).toBe('media-1')
    const names = events.map((event) => event.event)
    expect(names).toContain('model.request.started')
    expect(names).toContain('model.request.accepted')
    expect(names).toContain('task.state_changed')
    expect(names).toContain('task.completed')
    expect(names).toContain('media.download_completed')
    expect(names).toContain('media.persist_completed')
    expect(names).toContain('model.request.completed')

    // 全链路同一 requestId/traceId 串联。
    const requestIds = new Set(events.map((event) => event.requestId))
    expect(requestIds).toEqual(new Set(['req-img-1']))
    expect(new Set(events.map((event) => event.traceId))).toEqual(new Set(['trace-img-1']))
    // 事件带上游任务 ID，下载/入库阶段可追溯到远端任务。
    const download = events.find((event) => event.event === 'media.download_completed')
    expect(download?.upstreamTaskId).toBe('task-1')
    // 提示词正文绝不进入事件。
    expect(JSON.stringify(events)).not.toContain('SECRET-IMAGE-PROMPT')
    void pollCall
    void fetchMock
  })

  it('远端成功但下载失败：task.completed 与 media.download_failed 同时存在，不误导重新提交（A07）', async () => {
    const { generateImageToAsset } = await import('../../src/main/gateway/image')
    let pollCall = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/images/generations')) {
        return jsonResponse(200, JSON.stringify({ id: 'task-1', status: 'queued' }))
      }
      if (href.includes('/images/generations/task-1')) {
        pollCall += 1
        const status = pollCall === 1 ? 'processing' : 'completed'
        const payload =
          status === 'completed'
            ? { status, url: 'https://cdn.example/result.png' }
            : { status }
        return jsonResponse(200, JSON.stringify(payload))
      }
      // 下载返回 500
      return { ok: false, status: 500, headers: new Headers() } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const promise = generateImageToAsset(imageInput())
    const settled = promise.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2600)
    await vi.advanceTimersByTimeAsync(2600)
    const error = (await settled) as Error

    expect(error.message).toContain('下载失败')
    const completedIndex = events.findIndex((event) => event.event === 'task.completed')
    const downloadFailedIndex = events.findIndex((event) => event.event === 'media.download_failed')
    expect(completedIndex).toBeGreaterThanOrEqual(0)
    expect(downloadFailedIndex).toBeGreaterThan(completedIndex)
    expect(events.find((event) => event.event === 'media.download_failed')!.error?.code).toBe(
      'MEDIA_DOWNLOAD_FAILED'
    )
    // 关键断言：远端任务确实完成过（task.completed 存在），操作者据此知道结果已产生、
    // 只是本地下载失败——不是需要重新提交生成的信号。
    expect(events.find((event) => event.event === 'task.completed')!.status).toBe('success')
    // 提交只发生一次：不得因下载失败而重复请求上游。
    const submitCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/images/generations'))
    expect(submitCalls).toHaveLength(1)
  })

  it('提交 429：attempt_failed 带稳定错误码 RATE_LIMITED（A04）', async () => {
    const { generateImageToAsset } = await import('../../src/main/gateway/image')
    const fetchMock = vi.fn(async () => jsonResponse(429, '{"error":"rate limited"}'))
    vi.stubGlobal('fetch', fetchMock)
    const settled = generateImageToAsset(imageInput()).catch((error: unknown) => error)
    const error = (await settled) as Error

    expect(error).toBeInstanceOf(Error)
    const attemptFailed = events.find((event) => event.event === 'model.request.attempt_failed')
    expect(attemptFailed).toBeTruthy()
    expect(attemptFailed!.error?.code).toBe('RATE_LIMITED')
    expect(attemptFailed!.error?.retryable).toBe(true)
    expect(attemptFailed!.error?.httpStatus).toBe(429)
    const failed = events.find((event) => event.event === 'model.request.failed')
    // 根因（RATE_LIMITED）由 attempt_failed 携带；请求级终态引用上游失败类，可重试。
    expect(failed!.error?.code).toBe('UPSTREAM_FAILED')
    expect(failed!.error?.retryable).toBe(true)
  })
})
