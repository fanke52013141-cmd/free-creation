import { beforeEach, expect, it, vi } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { startChat } from '../src/main/gateway/chat'
import { generateImageToAsset } from '../src/main/gateway/image'
import type { GatewayEvent } from '../src/shared/contracts'

const fixture = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[], plain: false }))
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))
vi.mock('../src/main/gateway/image', () => ({ generateImageToAsset: vi.fn() }))
vi.mock('../src/main/gateway/factory', () => ({
  GatewayError: class extends Error {},
  requireProvider: () => ({
    specId: 'toapis',
    models: [{ id: 'gpt-image-2-vip', modality: 'image', operations: ['image.generate'] }]
  }),
  createChatModel: () =>
    createOpenAICompatible({
      name: 'fixture',
      baseURL: 'https://example.invalid/v1',
      fetch: async (_url, init) => {
        fixture.requests.push(JSON.parse(String(init?.body)))
        const useTool = !fixture.plain && fixture.requests.length === 1
        const delta = useTool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-image',
                  type: 'function',
                  function: {
                    name: 'generate_image',
                    arguments: JSON.stringify({ prompt: '画一个蓝色圆形' })
                  }
                }
              ]
            }
          : { content: fixture.plain ? '你好。' : '已生成图片。' }
        const chunks = [
          {
            id: 'completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta, finish_reason: null }]
          },
          {
            id: 'completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }]
          }
        ]
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    }).chatModel('fixture')
}))

beforeEach(() => {
  fixture.requests.length = 0
  fixture.plain = false
  vi.clearAllMocks()
  vi.mocked(generateImageToAsset).mockResolvedValue({
    id: 'image-1',
    path: 'projects/p/media/image.png',
    name: '图片',
    mime: 'image/png'
  } as never)
})

async function run(): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = []
  startChat((event) => events.push(event), {
    providerId: 'text',
    modelId: 'fixture',
    messages: [{ role: 'user', content: '请生成图片' }],
    imageSkill: {
      projectId: 'p',
      providerId: 'images',
      modelId: 'gpt-image-2-vip',
      resolution: '1k'
    }
  })
  await vi.waitFor(() =>
    expect(events.some((event) => ['chat-done', 'chat-error'].includes(event.kind))).toBe(true)
  )
  return events
}

it('真实 AI SDK 多步工具链：文本工具调用→图片附件→最终回复，只提交一次图片', async () => {
  const events = await run()
  expect(events.at(-1)?.kind).toBe('chat-done')
  expect(fixture.requests).toHaveLength(2)
  expect(JSON.stringify(fixture.requests[1])).toContain('"role":"tool"')
  expect(generateImageToAsset).toHaveBeenCalledOnce()
  expect(generateImageToAsset).toHaveBeenCalledWith(
    expect.objectContaining({ resolution: '1k', prompt: '画一个蓝色圆形' })
  )
  expect(events.find((event) => event.kind === 'chat-image')).toMatchObject({
    image: { mediaId: 'image-1' }
  })
  expect(events.findIndex((event) => event.kind === 'chat-image')).toBeLessThan(
    events.findIndex((event) => event.kind === 'chat-done')
  )
})

it('普通文字回复不生成图片', async () => {
  fixture.plain = true
  const events = await run()
  expect(events.at(-1)?.kind).toBe('chat-done')
  expect(generateImageToAsset).not.toHaveBeenCalled()
})

it('工具失败上报 chat-error，不重发图片请求', async () => {
  vi.mocked(generateImageToAsset).mockRejectedValue(new Error('供应商返回失败'))
  const events = await run()
  expect(events.at(-1)?.kind).toBe('chat-error')
  expect(generateImageToAsset).toHaveBeenCalledOnce()
  expect(events.some((event) => event.kind === 'chat-image')).toBe(false)
})
