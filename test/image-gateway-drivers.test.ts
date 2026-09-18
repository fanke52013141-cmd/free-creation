// 生图网关三驱动单测：全部外部依赖（fetch / AI SDK / media 仓库 / 供应商仓库）mock 掉，
// 只验证驱动分发的提交体、轮询、解析与落盘契约。
// ToAPIS 任务查询/上传端点的真实路径在验收阶段冒烟确认（docs/IMAGE_PROVIDER_GATEWAY_PLAN.md §10）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageGenerateInput } from '../src/shared/contracts'
import type { ProviderConfig } from '../src/shared/types'

vi.mock('../src/main/store/media.repo', () => ({
  readMediaBuffer: vi.fn(),
  saveBufferAsset: vi.fn()
}))

vi.mock('../src/main/gateway/factory', () => ({
  GatewayError: class GatewayError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  requireProvider: vi.fn(),
  createImageModel: vi.fn()
}))

vi.mock('ai', () => ({
  generateImage: vi.fn()
}))

import { generateImage } from 'ai'
import { generateImageToAsset } from '../src/main/gateway/image'
import { readMediaBuffer, saveBufferAsset } from '../src/main/store/media.repo'
import { requireProvider } from '../src/main/gateway/factory'

const generateImageMock = vi.mocked(generateImage)
const readMediaBufferMock = vi.mocked(readMediaBuffer)
const saveBufferAssetMock = vi.mocked(saveBufferAsset)
const requireProviderMock = vi.mocked(requireProvider)

const OUT_URL = 'https://cdn.example.com/out-1.png'

function makeProvider(specId: ProviderConfig['specId']): ProviderConfig {
  return {
    id: 'p1',
    name: '测试供应商',
    specId,
    baseURL: 'https://gateway.example.com/v1',
    apiKey: 'test-key',
    models: [],
    createdAt: 0
  }
}

function makeInput(overrides: Partial<ImageGenerateInput> = {}): ImageGenerateInput {
  return {
    projectId: 'proj-1',
    providerId: 'p1',
    modelId: 'gpt-image-2',
    prompt: '未来城市夜景海报',
    size: '1:1',
    resolution: '2k',
    ...overrides
  }
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

/** 推进假时钟触发轮询；轮数取富余值，多推无副作用。 */
async function advancePolling(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(2_500)
  }
}

describe('image gateway drivers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    saveBufferAssetMock.mockReset()
    saveBufferAssetMock.mockImplementation(async (_projectId, buf, ext, name) => ({
      id: 'asset-1',
      kind: 'image',
      mime: 'image/png',
      path: `projects/proj-1/media/asset-1${ext}`,
      sizeBytes: buf.length,
      createdAt: 0,
      name
    }))
    readMediaBufferMock.mockReset()
    generateImageMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('toapis-task 驱动', () => {
    it('文生图：提交体只带文档化字段（比例串 size、分辨率、透明背景），轮询完成后下载落盘', async () => {
      const pollResponses = [
        { id: 'task_1', status: 'in_progress', progress: 40 },
        {
          id: 'task_1',
          status: 'completed',
          progress: 100,
          data: [{ url: OUT_URL }]
        }
      ]
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/images/generations') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse({
            id: 'task_1',
            object: 'generation.task',
            status: 'queued',
            progress: 0
          })
        }
        if (url.includes('/images/generations/task_1')) {
          return jsonResponse(
            pollResponses.shift() ?? {
              id: 'task_1',
              status: 'completed',
              progress: 100,
              data: [{ url: OUT_URL }]
            }
          )
        }
        if (url === OUT_URL) {
          return new Response(new Uint8Array([9, 9, 9]), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          })
        }
        return new Response(`unexpected ${url}`, { status: 500 })
      })
      vi.stubGlobal('fetch', fetchMock)
      requireProviderMock.mockReturnValue(makeProvider('toapis'))

      const pending = generateImageToAsset(makeInput({ background: 'transparent' }))
      await advancePolling()
      await pending

      const submitCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith('/images/generations') && init?.method === 'POST'
      )
      expect(submitCall).toBeDefined()
      const submitBody = JSON.parse(String((submitCall![1] as RequestInit).body))
      expect(submitBody).toMatchObject({
        model: 'gpt-image-2',
        prompt: '未来城市夜景海报',
        size: '1:1',
        resolution: '2k',
        background: 'transparent',
        n: 1,
        response_format: 'url'
      })
      // quality 不属于 gpt-image-2 的文档字段；能力表关闭后网关不得再注入。
      expect(submitBody.quality).toBeUndefined()
      expect(submitBody.reference_images).toBeUndefined()
      expect(saveBufferAssetMock).toHaveBeenCalledWith(
        'proj-1',
        expect.any(Buffer),
        '.png',
        '未来城市夜景海报'
      )
    })

    it('图生图：本地图先上传换 URL；任务回显参考图不会被误当结果', async () => {
      const REF_URL = 'https://cdn.example.com/ref-1.png'
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/uploads/images') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse({ url: REF_URL })
        }
        if (url.endsWith('/images/generations') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse({ id: 'task_2', status: 'queued' })
        }
        if (url.includes('/images/generations/task_2')) {
          return jsonResponse({
            id: 'task_2',
            status: 'completed',
            progress: 100,
            input: { reference_images: [REF_URL] },
            data: [{ url: OUT_URL }]
          })
        }
        if (url === OUT_URL) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          })
        }
        return new Response(`unexpected ${url}`, { status: 500 })
      })
      vi.stubGlobal('fetch', fetchMock)
      requireProviderMock.mockReturnValue(makeProvider('toapis'))
      readMediaBufferMock.mockResolvedValue({ buf: Buffer.from('local-ref'), mime: 'image/png' })

      const pending = generateImageToAsset(makeInput({ referenceMediaIds: ['media-1'] }))
      await advancePolling()
      await pending

      const submitCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith('/images/generations') && init?.method === 'POST'
      )
      const submitBody = JSON.parse(String((submitCall![1] as RequestInit).body))
      expect(submitBody.reference_images).toEqual([REF_URL])
      // 结果必须落盘为 out-1 下载内容，而不是参考图
      expect(saveBufferAssetMock).toHaveBeenCalledWith(
        'proj-1',
        expect.toSatisfy((buf: Buffer) => buf.equals(Buffer.from([1, 2, 3]))),
        '.png',
        expect.any(String)
      )
    })

    it('任务失败时抛出带供应商原始信息的错误', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.endsWith('/images/generations')) {
            return jsonResponse({ id: 'task_3', status: 'queued' })
          }
          if (url.includes('/images/generations/task_3')) {
            return jsonResponse({ id: 'task_3', status: 'failed', error: { message: '内容违规' } })
          }
          return new Response(`unexpected ${url} ${String(init?.method)}`, { status: 500 })
        })
      )
      requireProviderMock.mockReturnValue(makeProvider('toapis'))

      const pending = generateImageToAsset(makeInput())
      // 先挂上 catch 再推进时钟，避免 vitest 把异步拒绝记为 unhandled rejection。
      const guarded = pending.catch((e: Error) => e)
      await advancePolling()
      const error = await guarded
      expect((error as Error & { code?: string }).code).toBe('TOAPIS_TASK_FAILED')
      expect(error.message).toContain('内容违规')
    })

    it('中转站直接返回图片 URL 时免轮询直接落盘', async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/images/generations') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse({
            created: Date.now(),
            data: [{ url: OUT_URL }]
          })
        }
        if (url === OUT_URL) {
          return new Response(new Uint8Array([5, 6, 7]), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          })
        }
        return new Response(`unexpected ${url}`, { status: 500 })
      })
      vi.stubGlobal('fetch', fetchMock)
      requireProviderMock.mockReturnValue(makeProvider('relay'))

      await generateImageToAsset(makeInput({ modelId: 'gpt-image-2' }))

      expect(saveBufferAssetMock).toHaveBeenCalledWith(
        'proj-1',
        expect.toSatisfy((buf: Buffer) => buf.equals(Buffer.from([5, 6, 7]))),
        '.png',
        '未来城市夜景海报'
      )
    })

    it('兼容 task_id 字段与 SUCCESS 大写状态', async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/images/generations') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse({ task_id: 'task_custom_1' })
        }
        if (url.includes('/images/generations/task_custom_1')) {
          return jsonResponse({
            id: 'task_custom_1',
            status: 'SUCCESS',
            output: [OUT_URL]
          })
        }
        if (url === OUT_URL) {
          return new Response(new Uint8Array([8, 8, 8]), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          })
        }
        return new Response(`unexpected ${url}`, { status: 500 })
      })
      vi.stubGlobal('fetch', fetchMock)
      requireProviderMock.mockReturnValue(makeProvider('toapis'))

      const pending = generateImageToAsset(makeInput())
      await advancePolling()
      await pending

      expect(saveBufferAssetMock).toHaveBeenCalledWith(
        'proj-1',
        expect.toSatisfy((buf: Buffer) => buf.equals(Buffer.from([8, 8, 8]))),
        '.png',
        '未来城市夜景海报'
      )
    })
  })

  describe('openrouter-chat 驱动', () => {
    it('chat 提交带 modalities 与内联参考图；data URL 结果解码落盘', async () => {
      const dataUrl = `data:image/png;base64,${Buffer.from('openrouter-out').toString('base64')}`
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                images: [{ type: 'image_url', image_url: { url: dataUrl } }]
              }
            }
          ]
        })
      )
      vi.stubGlobal('fetch', fetchMock)
      requireProviderMock.mockReturnValue(makeProvider('openrouter'))
      readMediaBufferMock.mockResolvedValue({ buf: Buffer.from('local-ref'), mime: 'image/png' })

      await generateImageToAsset(
        makeInput({
          modelId: 'google/gemini-2.5-flash-image',
          size: 'auto',
          referenceMediaIds: ['media-1']
        })
      )

      const call = fetchMock.mock.calls[0]
      expect(String(call![0])).toContain('/chat/completions')
      const body = JSON.parse(String((call![1] as RequestInit).body))
      expect(body.modalities).toEqual(['image', 'text'])
      expect(body.model).toBe('google/gemini-2.5-flash-image')
      expect(body.messages[0].content[0]).toEqual({ type: 'text', text: '未来城市夜景海报' })
      expect(String(body.messages[0].content[1].image_url.url)).toMatch(/^data:image\/png;base64,/)
      expect(saveBufferAssetMock).toHaveBeenCalledWith(
        'proj-1',
        expect.toSatisfy((buf: Buffer) => buf.equals(Buffer.from('openrouter-out'))),
        '.png',
        expect.any(String)
      )
    })
  })

  describe('openai-images 驱动（AI SDK 兼容路径）', () => {
    it('OpenAI 官方：只固定带 quality=low，不发 aspectRatio 与 resolution', async () => {
      generateImageMock.mockResolvedValue({
        images: [{ uint8Array: new Uint8Array([1]), mediaType: 'image/png' }]
      } as never)
      requireProviderMock.mockReturnValue(makeProvider('openai'))

      await generateImageToAsset(makeInput({ size: '1536x1024', aspectRatio: '16:9' }))

      expect(generateImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          size: '1536x1024',
          providerOptions: { p1: { quality: 'low' } }
        })
      )
      expect(saveBufferAssetMock).toHaveBeenCalled()
    })

    it('relay 中转站：维持旧行为，仅透传 aspectRatio，不带新字段', async () => {
      generateImageMock.mockResolvedValue({
        images: [{ uint8Array: new Uint8Array([1]), mediaType: 'image/png' }]
      } as never)
      requireProviderMock.mockReturnValue(makeProvider('relay'))

      await generateImageToAsset(
        makeInput({
          modelId: 'custom-image-model',
          size: 'auto',
          aspectRatio: '16:9',
          resolution: '2k'
        })
      )

      expect(generateImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: { p1: { aspectRatio: '16:9' } }
        })
      )
    })
  })
})
