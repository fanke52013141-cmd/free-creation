import { beforeEach, expect, it, vi } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { GatewayEvent } from '../src/shared/contracts'

const fixture = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  enabled: true,
  vision: true,
  verified: true,
  owner: true
}))
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))
vi.mock('../src/main/store/db', () => ({ getDb: () => ({}) }))
vi.mock('../src/main/store/media.repo', () => ({
  listMedia: () =>
    fixture.owner
      ? [{ id: 'media-1', path: 'projects/p/media/image.png', mime: 'image/png', sizeBytes: 4 }]
      : [],
  readMediaBuffer: async () => ({ buf: Buffer.from([1, 2, 3, 4]), mime: 'image/png' })
}))
vi.mock('../src/main/model-host/sqlite-model-host', () => ({
  SqliteModelHost: class {
    listConnections() {
      return [{ id: 'provider', enabled: fixture.enabled }]
    }
    listModels() {
      return [
        {
          modelId: 'model',
          enabled: true,
          capabilities: [
            { operation: 'text.generate', acceptedAssetKinds: fixture.vision ? ['image'] : [] }
          ],
          validation: { 'text.generate': { status: fixture.verified ? 'verified' : 'unverified' } }
        }
      ]
    }
  }
}))
vi.mock('../src/main/gateway/factory', () => ({
  GatewayError: class extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message)
    }
  },
  createChatModel: () =>
    createOpenAICompatible({
      name: 'fixture',
      baseURL: 'https://example.invalid/v1',
      fetch: async (_url, init) => {
        fixture.requests.push(JSON.parse(String(init?.body)))
        return new Response(
          'data: ' +
            JSON.stringify({
              id: '1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'model',
              choices: [{ index: 0, delta: { content: '看到了' }, finish_reason: null }]
            }) +
            '\n\ndata: ' +
            JSON.stringify({
              id: '1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            }) +
            '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    }).chatModel('model')
}))
import { startChat } from '../src/main/gateway/chat'
import { parseChat, serializeChat } from '../src/shared/engine/chat-data'
import { remapMediaReferences } from '../src/shared/media-reference-remap'

const attachment = {
  mediaId: 'media-1',
  mediaPath: 'projects/p/media/image.png',
  name: '图片.png',
  mime: 'image/png'
}
beforeEach(() => {
  fixture.requests.length = 0
  fixture.enabled = fixture.vision = fixture.verified = fixture.owner = true
})
async function run() {
  const events: GatewayEvent[] = []
  startChat((event) => events.push(event), {
    providerId: 'provider',
    modelId: 'model',
    projectId: 'p',
    messages: [{ role: 'user', content: '图片是什么？', images: [attachment] }]
  })
  await vi.waitFor(() =>
    expect(events.some((event) => event.kind === 'chat-done' || event.kind === 'chat-error')).toBe(
      true
    )
  )
  return events
}
it('已验证视觉模型收到真正的图片内容', async () => {
  const events = await run()
  expect(events.at(-1)?.kind).toBe('chat-done')
  expect(JSON.stringify(fixture.requests[0])).toContain('data:image/png;base64,AQIDBA==')
  expect(JSON.stringify(fixture.requests[0])).toContain('图片是什么')
})
it.each(['vision', 'verified', 'enabled', 'owner'] as const)(
  '不支持、未验证或不属于项目时阻止提交：%s',
  async (key) => {
    fixture[key] = false
    const events = await run()
    expect(events.at(-1)?.kind).toBe('chat-error')
    expect(fixture.requests).toHaveLength(0)
  }
)
it('用户图片附件可持久化并随项目导入重映射', () => {
  const text = JSON.stringify({
    messages: [{ role: 'user', content: '分析', images: [attachment] }]
  })
  expect(parseChat(text).messages[0].images).toEqual([attachment])
  const imported = remapMediaReferences(serializeChat(parseChat(text)), {
    ids: new Map([['media-1', 'media-2']]),
    paths: new Map([['projects/p/media/image.png', 'projects/q/media/new.png']])
  })
  expect(parseChat(imported).messages[0].images?.[0]).toMatchObject({
    mediaId: 'media-2',
    mediaPath: 'projects/q/media/new.png'
  })
})
