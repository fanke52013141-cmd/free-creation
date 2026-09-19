import { describe, expect, it } from 'vitest'
import {
  buildMiniMaxH3RequestBody,
  buildSeedanceRequestBody,
  classifyMiniMaxTask,
  minimaxApiUrl,
  seedanceTasksUrl
} from '../src/main/gateway/video'
import type { VideoSubmitInput } from '../src/shared/contracts'
import type { ProviderConfig } from '../src/shared/types'

const input = (patch: Partial<VideoSubmitInput> = {}): VideoSubmitInput => ({
  projectId: 'project-a',
  nodeId: 'node-a',
  providerId: 'provider-a',
  modelId: 'MiniMax-H3',
  prompt: '角色转身，镜头推进',
  ...patch
})

const resolveMedia = async (id: string): Promise<string> => `data:test/${id}`

const seedanceProvider = (baseURL: string): ProviderConfig => ({
  id: 'seedance-a',
  name: 'Seedance',
  specId: 'seedance',
  baseURL,
  apiKey: 'test-key',
  createdAt: 0,
  models: []
})

describe('MiniMax H3 gateway wire payload', () => {
  it('保留首尾帧角色，并让帧图决定画幅', async () => {
    await expect(
      buildMiniMaxH3RequestBody(
        input({
          mode: 'first-last-frame',
          firstFrameMediaId: 'first',
          lastFrameMediaId: 'last',
          params: { ratio: '9:16', duration: 5, resolution: '768P', watermark: false }
        }),
        resolveMedia
      )
    ).resolves.toEqual({
      model: 'MiniMax-H3',
      content: [
        { type: 'text', text: '角色转身，镜头推进' },
        { type: 'image_url', image_url: { url: 'data:test/first' }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: 'data:test/last' }, role: 'last_frame' }
      ],
      duration: 5,
      resolution: '768P',
      aigc_watermark: false
    })
  })

  it('保留多参素材顺序，并在非帧模式发送明确画幅', async () => {
    await expect(
      buildMiniMaxH3RequestBody(
        input({
          mode: 'reference',
          referenceImageMediaIds: ['image-1', 'image-2'],
          referenceVideoMediaIds: ['motion-1'],
          referenceAudioMediaIds: ['audio-1'],
          params: { ratio: '16:9', duration: 8, resolution: '2K' }
        }),
        resolveMedia
      )
    ).resolves.toMatchObject({
      ratio: '16:9',
      duration: 8,
      resolution: '2K',
      content: [
        { type: 'text', text: '角色转身，镜头推进' },
        { type: 'image_url', image_url: { url: 'data:test/image-1' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'data:test/image-2' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'data:test/motion-1' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'data:test/audio-1' }, role: 'reference_audio' }
      ]
    })
  })
})

describe('Seedance gateway wire payload', () => {
  it('官方端点使用角色和结构化参数', async () => {
    await expect(
      buildSeedanceRequestBody(
        seedanceProvider('https://ark.example.com/api/v3'),
        input({
          modelId: 'Seedance-2.0',
          mode: 'reference',
          referenceImageMediaIds: ['image-1'],
          referenceVideoMediaIds: ['video-1'],
          referenceAudioMediaIds: ['audio-1'],
          params: {
            ratio: '16:9',
            duration: 5,
            resolution: '720p',
            generateAudio: true,
            watermark: false
          }
        }),
        resolveMedia
      )
    ).resolves.toMatchObject({
      model: 'Seedance-2.0',
      ratio: '16:9',
      duration: 5,
      resolution: '720p',
      generate_audio: true,
      watermark: false,
      content: [
        { type: 'text', text: '角色转身，镜头推进' },
        { type: 'image_url', image_url: { url: 'data:test/image-1' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'data:test/video-1' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'data:test/audio-1' }, role: 'reference_audio' }
      ]
    })
  })

  it('兼容网关只使用已约定的 prompt 后缀，不发送官方字段或角色', async () => {
    const body = await buildSeedanceRequestBody(
      seedanceProvider('https://gateway.example.com/gateway/ark/v3'),
      input({
        modelId: 'Seedance-2.0',
        mode: 'reference',
        referenceImageMediaIds: ['image-1'],
        params: { ratio: '9:16', duration: 5, resolution: '720p', watermark: false }
      }),
      resolveMedia
    )
    expect(body).toEqual({
      model: 'Seedance-2.0',
      content: [
        { type: 'text', text: '角色转身，镜头推进 --rt 9:16 --rs 720p --dur 5 --wm false' },
        { type: 'image_url', image_url: { url: 'data:test/image-1' } }
      ]
    })
  })
})

const minimaxProvider = (baseURL: string): ProviderConfig => ({
  ...seedanceProvider(baseURL),
  id: 'minimax-a',
  name: 'MiniMax',
  specId: 'minimax'
})

describe('MiniMax v2 端点与任务状态', () => {
  it('BaseURL 的尾斜杠与用户自己写的 /v2 都不会拼出重复版本段', () => {
    expect(minimaxApiUrl(minimaxProvider('https://api.minimaxi.com'), '/v2/video_generation')).toBe(
      'https://api.minimaxi.com/v2/video_generation'
    )
    expect(
      minimaxApiUrl(minimaxProvider('https://api.minimaxi.com///'), '/v2/video_generation')
    ).toBe('https://api.minimaxi.com/v2/video_generation')
    expect(
      minimaxApiUrl(minimaxProvider('https://api.minimaxi.com/v2'), '/v2/video_generation')
    ).toBe('https://api.minimaxi.com/v2/video_generation')
    // 挂载在子路径下的网关同样只保留一个版本段：https://relay/api/v2 → /api/v2/video_generation
    expect(
      minimaxApiUrl(minimaxProvider('https://relay.example.com/api/v2'), '/v2/video_generation')
    ).toBe('https://relay.example.com/api/v2/video_generation')
    expect(
      minimaxApiUrl(
        minimaxProvider('https://relay.example.com/v2/'),
        '/v2/query/video_generation/t-1'
      )
    ).toBe('https://relay.example.com/v2/query/video_generation/t-1')
  })

  it('Seedance 任务地址同样去掉尾斜杠', () => {
    expect(seedanceTasksUrl(seedanceProvider('https://ark.example.com/api/v3/'), 'task-1')).toBe(
      'https://ark.example.com/api/v3/contents/generations/tasks/task-1'
    )
  })

  it('官方状态各自映射到运行中、成功与失败', () => {
    expect(classifyMiniMaxTask({ task: { status: 'queued' } })).toEqual({ status: 'running' })
    expect(classifyMiniMaxTask({ task: { status: 'running' } })).toEqual({ status: 'running' })
    expect(classifyMiniMaxTask({ task: { status: 'succeeded', content: { url: 'u' } } })).toEqual({
      status: 'succeeded',
      url: 'u'
    })
    expect(
      classifyMiniMaxTask({ task: { status: 'failed', error: { message: '内容审核未通过' } } })
    ).toEqual({ status: 'failed', error: '内容审核未通过' })
    // 成功态没带给片地址是协议不符，不能当运行中继续等。
    expect(classifyMiniMaxTask({ task: { status: 'succeeded' } }).status).toBe('failed')
  })

  it('HTTP 200 里的 base_resp 错误按失败收，不再白等到超时', () => {
    expect(
      classifyMiniMaxTask({
        task: { status: 'running' },
        base_resp: { status_code: 1002, status_msg: 'invalid api key' }
      })
    ).toEqual({ status: 'failed', error: 'invalid api key（status_code 1002）' })
    // status_code 为 0 是成功哨兵，不能因为字段存在就判失败。
    expect(
      classifyMiniMaxTask({ task: { status: 'running' }, base_resp: { status_code: 0 } })
    ).toEqual({ status: 'running' })
  })

  it('响应结构根本不是 v2 时立即失败，没见过但存在的状态继续等', () => {
    // v1/中转风格：状态在顶层、没有 task 包装——等下去也永远不会有 task。
    expect(classifyMiniMaxTask({ status: 'Preparing', file_id: 'f-1' })).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('没有 task 字段')
    })
    expect(classifyMiniMaxTask({ task: {} })).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('缺少 status')
    })
    expect(classifyMiniMaxTask({ task: { status: 'inspecting' } })).toEqual({
      status: 'running'
    })
  })
})
