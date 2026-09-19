// 供应商协议自检的门禁。它守的是三件事：
//   1. 自检用的请求体必须由真实构造器产出（预览的和发出去的是同一份数据）；
//   2. 计费探测的时长/参数一律取能力表的最短值，不许在自检里写死秒数；
//   3. 真实调用只能由显式 allowCost 触发，且没有只读端点的协议不许谎报「已验证」。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../src/shared/types'
import { videoCapabilitiesFor } from '../src/shared/video-capabilities'
import { driverForSpec } from '../src/shared/provider-driver'
import {
  PROBE_UPSTREAM_TASK_ID,
  buildProbeSpecs,
  probeProvider
} from '../src/main/gateway/provider-check'

const read = (relative: string) =>
  readFileSync(join(__dirname, '..', relative), 'utf8').replace(/\r\n/g, '\n')

const draftProvider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'draft',
  name: '自检用供应商',
  specId: 'minimax',
  baseURL: 'https://api.minimaxi.com',
  apiKey: 'sk-secret-value-1234567890',
  models: [
    { id: 'MiniMax-H3', modality: 'video' },
    { id: 'speech-2.8-hd', modality: 'audio' }
  ],
  createdAt: 0,
  ...overrides
})

const itemOf = (
  specs: Awaited<ReturnType<typeof buildProbeSpecs>>,
  id: string
): (typeof specs)[number] => {
  const found = specs.find((spec) => spec.item.id === id)
  if (!found) throw new Error(`自检项缺失：${id}`)
  return found
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('§16.21 协议自检的请求构造', () => {
  it('视频探测项复用真实构造器，且时长取能力表的最短值', async () => {
    const specs = await buildProbeSpecs(draftProvider())
    const body = itemOf(specs, 'video-submit').body as { duration?: number; model?: string }
    const capabilities = videoCapabilitiesFor('minimax', 'MiniMax-H3')
    expect(body.model).toBe('MiniMax-H3')
    expect(body.duration).toBe(capabilities.defaultDuration)
    // 默认值必须确实是该模型允许的最短时长，而不是一个恰好便宜的常量。
    expect(capabilities.defaultDuration).toBe(Math.min(...capabilities.durations))
  })

  it('MiniMax 与 Seedance 各自打到自己文档化的任务端点，网关代理走兼容路径', async () => {
    const minimax = await buildProbeSpecs(draftProvider())
    expect(itemOf(minimax, 'video-submit').item.url).toBe(
      'https://api.minimaxi.com/v2/video_generation'
    )
    expect(itemOf(minimax, 'video-query').item.url).toContain(
      `/v2/query/video_generation/${PROBE_UPSTREAM_TASK_ID}`
    )

    const official = await buildProbeSpecs(
      draftProvider({
        specId: 'seedance',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        models: [{ id: 'doubao-seedance-2-0-260128', modality: 'video' }]
      })
    )
    expect(itemOf(official, 'video-submit').item.url).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks'
    )
    // 官方端点把参数放在顶层字段里。
    expect((itemOf(official, 'video-submit').body as { duration?: number }).duration).toBe(
      videoCapabilitiesFor('seedance', 'doubao-seedance-2-0-260128').defaultDuration
    )

    const proxied = await buildProbeSpecs(
      draftProvider({
        specId: 'seedance',
        baseURL: 'https://gateway.example.com/gateway/ark/v3',
        models: [{ id: 'doubao-seedance-2-0-fast-260128', modality: 'video' }]
      })
    )
    expect(itemOf(proxied, 'video-submit').item.url).toBe(
      'https://gateway.example.com/gateway/ark/v3/generations/tasks'
    )
    // 兼容网关的参数写在提示词尾巴上，顶层不该出现 duration。
    const proxyBody = itemOf(proxied, 'video-submit').body as {
      duration?: number
      content: Array<{ type: string; text?: string }>
    }
    expect(proxyBody.duration).toBeUndefined()
    expect(proxyBody.content[0]?.text ?? '').toContain('--dur')
  })

  it('预览文本里绝不出现明文密钥，火山 1.0 的 token 字段同样被掩码', async () => {
    const minimax = await buildProbeSpecs(draftProvider())
    for (const spec of minimax) {
      expect(spec.item.body ?? '').not.toContain('sk-secret-value-1234567890')
    }
    const volc = await buildProbeSpecs(
      draftProvider({
        specId: 'doubao-speech',
        baseURL: 'https://openspeech.bytedance.com',
        models: [{ id: 'seed-audio-1.0', modality: 'audio' }]
      })
    )
    const volcItem = itemOf(volc, 'volc-tts').item
    // 构造出来的真实请求体带 token，掩码只发生在展示层。
    expect(JSON.stringify(itemOf(volc, 'volc-tts').body)).toContain('sk-secret-value-1234567890')
    expect(volcItem.body ?? '').not.toContain('sk-secret-value-1234567890')
    expect(volcItem.body ?? '').toContain('***已掩码***')
  })

  it('缺必填项时列出来，而不是发一个看起来成功的半成品', async () => {
    const noVideoModel = await buildProbeSpecs(
      draftProvider({ models: [{ id: 'speech-2.8-hd', modality: 'audio' }] })
    )
    expect(itemOf(noVideoModel, 'video-submit').item.missing.join()).toContain('视频模型')

    const unknownModel = await buildProbeSpecs(
      draftProvider({ models: [{ id: 'minimax-h4-turbo', modality: 'video' }] })
    )
    expect(itemOf(unknownModel, 'video-submit').item.missing.join()).toContain('未命中能力表')

    // 豆包语音：AppID/音色在配音节点里，供应商面板拿不到，因此永远不算就绪。
    const doubao = await buildProbeSpecs(
      draftProvider({
        specId: 'doubao-speech',
        baseURL: 'https://openspeech.bytedance.com',
        models: [{ id: 'seed-audio-1.0', modality: 'audio' }]
      })
    )
    expect(itemOf(doubao, 'volc-tts').item.missing.join()).toContain('AppID')
    expect(itemOf(doubao, 'doubao-tts').item.missing).toEqual([])
    // 克隆要上传素材，语音克隆节点才拥有它。
    const clone = itemOf(await buildProbeSpecs(draftProvider()), 'minimax-voice-clone').item
    expect(clone.missing.join()).toContain('语音克隆')
  })

  it('只读探测项存在且标成 free；没有只读端点的协议不许有 free 项', async () => {
    const minimax = await buildProbeSpecs(draftProvider())
    expect(minimax.filter((spec) => spec.item.cost === 'free').map((spec) => spec.item.id)).toEqual(
      ['video-query', 'minimax-tts-query']
    )
    const doubao = await buildProbeSpecs(
      draftProvider({
        specId: 'doubao-speech',
        baseURL: 'https://openspeech.bytedance.com',
        models: [{ id: 'seed-audio-1.0', modality: 'audio' }]
      })
    )
    expect(doubao.every((spec) => spec.item.cost === 'paid')).toBe(true)
  })
})

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal('fetch', vi.fn(impl))
}

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

describe('§16.21 计费边界与回执判定', () => {
  const probeInput = {
    name: 'MiniMax',
    specId: 'minimax' as const,
    baseURL: 'https://api.minimaxi.com',
    apiKey: 'sk-secret-value-1234567890',
    models: [
      { id: 'MiniMax-H3', modality: 'video' as const },
      { id: 'speech-2.8-hd', modality: 'audio' as const }
    ]
  }

  it('没给 allowCost 时一个计费请求都不发', async () => {
    let posted = 0
    stubFetch(async (url, init) => {
      if (init?.method === 'POST') posted += 1
      return jsonResponse(200, {})
    })
    await expect(probeProvider({ ...probeInput, runItemId: 'video-submit' })).rejects.toMatchObject(
      { code: 'COST_CONFIRM_REQUIRED' }
    )
    expect(posted).toBe(0)
  })

  it('必填项没齐就不允许计费调用', async () => {
    stubFetch(async () => jsonResponse(200, {}))
    await expect(
      probeProvider({
        ...probeInput,
        models: [{ id: 'speech-2.8-hd', modality: 'audio' }],
        runItemId: 'video-submit',
        allowCost: true
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('确认后只提交一次，并把上游受理号回传给用户', async () => {
    const urls: string[] = []
    stubFetch(async (url, init) => {
      urls.push(url)
      if (init?.method === 'POST')
        return jsonResponse(200, { task_id: 'up-777', base_resp: { status_code: 0 } })
      return jsonResponse(200, { base_resp: { status_code: 2013, status_msg: 'task not found' } })
    })
    const result = await probeProvider({
      ...probeInput,
      runItemId: 'video-submit',
      allowCost: true
    })
    expect(urls.filter((url) => url.endsWith('/v2/video_generation'))).toHaveLength(1)
    const submit = result.items.find((item) => item.id === 'video-submit')
    expect(submit?.probe?.status).toBe('pass')
    expect(submit?.probe?.detail).toContain('up-777')
    expect(submit?.probe?.detail).toContain('计费')
  })

  it('判定保守：401 算失败，非鉴权业务码只算未判定', async () => {
    const outcomes: Record<string, string> = {}
    stubFetch(async (url) => {
      return url.includes('/v2/query/')
        ? jsonResponse(401, { base_resp: { status_code: 1004, status_msg: 'invalid api key' } })
        : jsonResponse(200, { base_resp: { status_code: 2013, status_msg: 'invalid params' } })
    })
    const result = await probeProvider(probeInput)
    for (const item of result.items) if (item.probe) outcomes[item.id] = item.probe.status
    expect(outcomes['video-query']).toBe('fail')
    expect(outcomes['minimax-tts-query']).toBe('unknown')
    expect(result.summary).toContain('自检失败')
  })

  // 下面两份回执是 2026-09-19 拿真实 MiniMax 密钥打真端点抄回来的原文（假密钥那份是控制组）。
  // 为什么要抄下来：MiniMax 对「任务不存在」不给 404，而是 HTTP 500 / HTTP 200 里塞业务码，
  // 按状态码判会把一把刚填对的密钥报成「上游服务异常，无法判定」。
  it('真实 MiniMax 回执：密钥可用但查不到探测任务，判为通过', async () => {
    stubFetch(async (url) =>
      url.includes('/v2/query/video_generation/')
        ? jsonResponse(500, {
            type: 'error',
            error: { type: 'server_error', message: 'record not found (1000)', http_code: '500' }
          })
        : jsonResponse(200, {
            status: '',
            task_id: 0,
            file_id: 0,
            base_resp: { status_code: 2013, status_msg: 'invalid params, task not found' }
          })
    )
    const result = await probeProvider(probeInput)
    const free = result.items.filter((item) => item.cost === 'free')
    expect(free.map((item) => item.probe?.status)).toEqual(['pass', 'pass'])
    expect(free.map((item) => item.probe?.detail)).toEqual([
      expect.stringContaining('record not found (1000)'),
      expect.stringContaining('task not found')
    ])
    expect(result.summary).toContain('免费自检通过')
    // 语音查询必须用数字 task_id：非数字会先被参数校验挡住，探测结论就退化成了「参数错」。
    expect(free[1]?.url).toMatch(/t2a_async_query_v2\?task_id=\d+$/)
  })

  it('同一份判定遇到假密钥必须翻成失败，不许把 login fail 说成通过', async () => {
    stubFetch(async (url) =>
      url.includes('/v2/query/video_generation/')
        ? jsonResponse(401, {
            type: 'error',
            error: {
              type: 'authorized_error',
              message:
                "login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)",
              http_code: '401'
            }
          })
        : jsonResponse(200, {
            base_resp: {
              status_code: 1004,
              status_msg:
                "login fail: Please carry the API secret key in the 'Authorization' field of the request header"
            }
          })
    )
    const result = await probeProvider(probeInput)
    const free = result.items.filter((item) => item.cost === 'free')
    expect(free.map((item) => item.probe?.status)).toEqual(['fail', 'fail'])
    expect(result.summary).toContain('自检失败')
  })

  it('Base URL 填错的 404 page not found 不许被「not found」规则误判成通过', async () => {
    stubFetch(async () => new Response('404 page not found', { status: 404 }))
    const result = await probeProvider(probeInput)
    const free = result.items.filter((item) => item.cost === 'free')
    expect(free.map((item) => item.probe?.status)).toEqual(['unknown', 'unknown'])
    expect(free.map((item) => item.probe?.detail).join()).not.toContain('密钥被接受')
  })

  it('网络失败不冒充成上游结论', async () => {
    stubFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.minimaxi.com')
    })
    const result = await probeProvider(probeInput)
    expect(result.items.find((item) => item.id === 'video-query')?.probe?.status).toBe('unknown')
    expect(result.items.find((item) => item.id === 'video-query')?.probe?.detail).toContain(
      'ENOTFOUND'
    )
  })
})

describe('§16.21 自检接线（源码门禁）', () => {
  it('协议驱动只有一份判定，主进程与渲染层共用', () => {
    expect(driverForSpec('minimax')).toBe('video')
    expect(driverForSpec('seedance')).toBe('video')
    expect(driverForSpec('doubao-speech')).toBe('native-speech')
    expect(driverForSpec('toapis')).toBe('openai-compatible')
    const factory = read('src/main/gateway/factory.ts')
    expect(factory).not.toContain('function driverForSpec')
    expect(read('src/renderer/src/gateway/ProviderSettingsPanel.tsx')).toContain(
      "from '@shared/provider-driver'"
    )
  })

  it('testProvider 不再用「首次生成时验证」搪塞原生协议', () => {
    const factory = read('src/main/gateway/factory.ts')
    expect(factory).not.toContain('首次生成时验证')
    const ipc = read('src/main/ipc/gateway.ipc.ts')
    expect(ipc).toMatch(/driverForSpec\(input\.specId\)[\s\S]{0,200}freeConnectionMessage/)
  })

  it('计费项必须逐条二次确认，且面板里没有任何自动计费路径', () => {
    const panel = read('src/renderer/src/gateway/ProviderSettingsPanel.tsx')
    expect(panel).toContain('runPaidProbe')
    expect(panel).toMatch(
      /runPaidProbe[\s\S]{0,400}useConfirmStore\.getState\(\)\.confirm\(\{[\s\S]{0,400}danger: true/
    )
    // 整个面板里只有一处会放行计费，而且它紧跟在确认框后面。
    expect(panel.match(/probeInput\([^)]*true\)/g)).toHaveLength(1)
    expect(panel).toMatch(/confirm\(\{[\s\S]{0,600}\}\)\)[\s\S]{0,300}probeInput\(item\.id, true\)/)
    // 「测试并拉取模型」这条老路径不许变成计费调用。
    expect(panel).toMatch(/const test = async[\s\S]{0,900}window\.api\.gateway\.testProvider\(/)
  })

  it('自检请求体来自既有构造器，不另起一份 wire 定义', () => {
    const check = read('src/main/gateway/provider-check.ts')
    for (const builder of [
      'buildMiniMaxH3RequestBody',
      'buildSeedanceRequestBody',
      'buildMiniMaxAsyncTtsBody',
      'buildDoubaoSpeechBody',
      'buildVolcTtsBody',
      'buildVoiceDesignBody'
    ]) {
      expect(check).toContain(builder)
    }
    // 自检不许自带秒数字面量。
    expect(check).not.toMatch(/duration:\s*\d/)
    expect(check).toContain('normalizeVideoGenParams(videoCapabilitiesFor(')
  })
})
