import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSummary } from '@shared/types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { GatewayClient } from '@shared/engine/gateway-client'
import type { NodeValuePacket } from '@renderer/engine/contracts'
import { audioExecutor } from '@renderer/engine/executors/audio'
import { chatExecutor } from '@renderer/engine/executors/chat'
import { imageGenExecutor } from '@renderer/engine/executors/imageGen'
import { ttsExecutor } from '@renderer/engine/executors/tts'
import { waitForChat, waitForVideo } from '@renderer/engine/executors/shared'
import { videoExecutor } from '@renderer/engine/executors/video'

const provider = (modality: 'text' | 'audio' | 'video' | 'image'): ProviderSummary =>
  ({
    id: 'provider-1',
    name: '测试供应商',
    specId: 'relay',
    baseURL: 'https://example.invalid',
    hasApiKey: true,
    createdAt: 0,
    models: [{ id: `${modality}-model`, name: '测试模型', modality, providerId: 'provider-1' }]
  }) as ProviderSummary

const minimaxVideoProvider = (): ProviderSummary =>
  ({
    ...provider('video'),
    specId: 'minimax',
    models: [
      {
        id: 'MiniMax-H3',
        name: 'MiniMax H3',
        modality: 'video',
        providerId: 'provider-1'
      }
    ]
  }) as ProviderSummary

let currentGateway: Record<string, unknown> = {}

function installGateway(gateway: Record<string, unknown>): void {
  currentGateway = gateway
  globalThis.window = {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    api: { gateway }
  } as unknown as Window & typeof globalThis
}

function makeContext(
  nodeType: string,
  config: string,
  providers: ProviderSummary[],
  text = config
): {
  ctx: NodeExecutionContext
  props: Partial<NodeCardShape['props']>
  result: { value: string | null }
  artifacts: unknown[]
} {
  const props: Partial<NodeCardShape['props']> = {}
  const result = { value: null as string | null }
  const artifacts: unknown[] = []
  const shape = {
    id: `shape:${nodeType}`,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType,
      title: nodeType,
      config,
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  } as unknown as NodeCardShape
  return {
    props,
    result,
    ctx: {
      node: {
        id: shape.id,
        type: nodeType,
        contractVersion: 1,
        title: nodeType,
        x: 0,
        y: 0,
        w: 340,
        h: 260,
        ports: [],
        params: {},
        content: { kind: 'empty' },
        exec: { status: 'idle' },
        meta: { source: 'input', createdAt: 0 }
      },
      shape,
      inputs: new Map(),
      projectId: 'project-1',
      runId: 'run-1',
      providers,
      signal: { cancelled: false },
      gateway: currentGateway as unknown as GatewayClient,
      updateProps: (patch) => Object.assign(props, patch),
      updateResult: (value) => {
        result.value = value
      },
      emitArtifact: (artifact) => artifacts.push(artifact)
    },
    artifacts
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  currentGateway = {}
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('异步网关等待器', () => {
  it('waitForChat waits for the matching task and releases its listener after completion', async () => {
    let eventListener: ((event: Record<string, string>) => void) | undefined
    const off = vi.fn()
    installGateway({
      chatStart: vi.fn().mockResolvedValue({ ok: true, data: { taskId: 'chat-1' } }),
      chatCancel: vi.fn(),
      onEvent: vi.fn((listener) => {
        eventListener = listener
        return off
      })
    })

    const reply = waitForChat(
      {
        providerId: 'provider-1',
        modelId: 'text-model',
        messages: [{ role: 'user', content: '你好' }]
      },
      { cancelled: false }
    )
    await vi.runAllTicks()
    eventListener?.({ kind: 'chat-delta', taskId: 'other', text: '忽略' })
    eventListener?.({ kind: 'chat-delta', taskId: 'chat-1', text: '正确回复' })
    eventListener?.({ kind: 'chat-done', taskId: 'chat-1' })
    await expect(reply).resolves.toBe('正确回复')
    expect(off).toHaveBeenCalledOnce()
  })

  it('waitForVideo resolves only after the gateway publishes a media path', async () => {
    const videoTask = vi.fn().mockResolvedValue({
      ok: true,
      data: { status: 'success', mediaId: 'video-1', mediaPath: 'projects/p/video.mp4' }
    })
    installGateway({ videoTask, videoCancel: vi.fn() })

    const pending = waitForVideo('task-1', { cancelled: false })
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toEqual({
      mediaId: 'video-1',
      mediaPath: 'projects/p/video.mp4',
      name: 'video',
      mime: 'video/mp4'
    })
  })

  it('waitForVideo cancels the gateway task instead of leaving a polling timer behind', async () => {
    const signal = { cancelled: true }
    const videoCancel = vi.fn().mockResolvedValue({ ok: true })
    installGateway({ videoTask: vi.fn(), videoCancel })
    const pending = waitForVideo('task-cancel', signal)
    const rejected = expect(pending).rejects.toThrow('已取消')
    await vi.advanceTimersByTimeAsync(3_000)
    await rejected
    expect(videoCancel).toHaveBeenCalledWith('task-cancel')
  })
})

describe('chat / audio / video executors with a mocked gateway', () => {
  it('image generator submits ordered real multi-reference inputs instead of prompt-only mentions', async () => {
    const imageGenerate = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'image-1', path: 'projects/p/image.png', mime: 'image/png', name: '结果' }
    })
    installGateway({ imageGenerate })
    const { ctx } = makeContext(
      'image-gen',
      JSON.stringify({ modelKey: 'provider-1::image-model', prompt: '角色正面图' }),
      [provider('image')]
    )
    ctx.inputs = new Map([
      [
        'in-images',
        [
          {
            type: 'image',
            value: { kind: 'image', mediaId: 'a', mediaPath: 'a.png', mime: 'image/png' },
            source: { nodeId: 'a', portId: 'out-image', runId: 'run-a' },
            createdAt: 0
          },
          {
            type: 'image',
            value: { kind: 'image', mediaId: 'b', mediaPath: 'b.png', mime: 'image/png' },
            source: { nodeId: 'b', portId: 'out-image', runId: 'run-b' },
            createdAt: 0
          }
        ]
      ]
    ])
    await expect(imageGenExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(imageGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ referenceMediaIds: ['a', 'b'] })
    )
  })

  it('chat executor persists the completed assistant message through its controlled write API', async () => {
    let eventListener: ((event: Record<string, string>) => void) | undefined
    installGateway({
      chatStart: vi.fn().mockResolvedValue({ ok: true, data: { taskId: 'chat-1' } }),
      chatCancel: vi.fn(),
      onEvent: vi.fn((listener) => {
        eventListener = listener
        return () => undefined
      })
    })
    const config = JSON.stringify({
      modelKey: 'provider-1::text-model',
      messages: [{ role: 'user', content: '问题' }]
    })
    const { ctx, props } = makeContext('chat', config, [provider('text')])
    const pending = chatExecutor(ctx)
    await vi.runAllTicks()
    eventListener?.({ kind: 'chat-delta', taskId: 'chat-1', text: '回答' })
    eventListener?.({ kind: 'chat-done', taskId: 'chat-1' })
    await expect(pending).resolves.toEqual({ status: 'done' })
    expect(JSON.parse(props.text ?? '{}').messages.at(-1)).toEqual({
      role: 'assistant',
      content: '回答'
    })
  })

  it('audio executor records a generated result with its precise run provenance', async () => {
    installGateway({
      audioGenerate: vi.fn().mockResolvedValue({
        ok: true,
        data: { id: 'audio-1', path: 'projects/p/audio.mp3', mime: 'audio/mpeg', name: '旁白' }
      })
    })
    const { ctx, props, result, artifacts } = makeContext(
      'speech',
      JSON.stringify({
        mode: 'generate',
        modelKey: 'provider-1::audio-model',
        voice: 'alloy',
        format: 'mp3'
      }),
      [provider('audio')],
      '旁白'
    )
    await expect(audioExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(props.mediaId).toBeUndefined()
    expect(artifacts).toContainEqual(expect.objectContaining({ kind: 'audio', mediaId: 'audio-1' }))
    expect(JSON.parse(result.value ?? '{}').results[0].runId).toBe('run-1')
  })

  it('audio asset executor only publishes its own imported media and never makes a remote speech request', async () => {
    const audioGenerate = vi.fn()
    installGateway({ audioGenerate })
    const { ctx } = makeContext(
      'audio',
      JSON.stringify({ mode: 'generate', modelKey: 'provider-1::audio-model', text: '不应执行' }),
      [provider('audio')]
    )
    await expect(audioExecutor(ctx)).resolves.toEqual({
      status: 'skipped',
      reason: '未导入音频资产'
    })
    expect(audioGenerate).not.toHaveBeenCalled()

    ctx.shape.props.mediaPath = 'projects/p/imported.wav'
    await expect(audioExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(audioGenerate).not.toHaveBeenCalled()
  })

  it('语音克隆执行器从节点正文读取朗读内容，而不读取配置中的遗留 text', async () => {
    const ttsGenerate = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'tts-1', path: 'projects/p/tts.wav', mime: 'audio/wav', name: '复刻旁白' }
    })
    installGateway({ ttsGenerate })
    const { ctx, artifacts } = makeContext(
      'tts',
      JSON.stringify({ refMediaId: 'reference-audio', text: '不应作为当前正文执行' }),
      [],
      '当前画布正文'
    )

    await expect(ttsExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(ttsGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ referenceAudioId: 'reference-audio', text: '当前画布正文' })
    )
    expect(artifacts).toContainEqual(expect.objectContaining({ kind: 'audio', mediaId: 'tts-1' }))
  })

  it('video executor submits, polls, and records the completed media result', async () => {
    installGateway({
      videoSubmit: vi.fn().mockResolvedValue({ ok: true, data: { taskId: 'video-task' } }),
      videoTask: vi.fn().mockResolvedValue({
        ok: true,
        data: { status: 'success', mediaId: 'video-1', mediaPath: 'projects/p/video.mp4' }
      }),
      videoCancel: vi.fn()
    })
    const { ctx, props, result, artifacts } = makeContext(
      'video',
      JSON.stringify({ prompt: '猫咪挥爪', modelKey: 'provider-1::video-model', params: {} }),
      [provider('video')]
    )
    const pending = videoExecutor(ctx)
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toEqual({ status: 'done' })
    expect(props.mediaId).toBeUndefined()
    expect(artifacts).toContainEqual(expect.objectContaining({ kind: 'video', mediaId: 'video-1' }))
    expect(JSON.parse(result.value ?? '{}').results[0].runId).toBe('run-1')
  })

  it('video executor forwards a connected motion reference to the gateway', async () => {
    const videoSubmit = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { taskId: 'video-reference-task' } })
    installGateway({
      videoSubmit,
      videoTask: vi.fn().mockResolvedValue({
        ok: true,
        data: { status: 'success', mediaId: 'video-2', mediaPath: 'projects/p/video-2.mp4' }
      }),
      videoCancel: vi.fn()
    })
    const { ctx } = makeContext(
      'video',
      JSON.stringify({ prompt: '跟随人物移动', modelKey: 'provider-1::MiniMax-H3', params: {} }),
      [minimaxVideoProvider()]
    )
    ;(ctx.inputs as Map<string, NodeValuePacket[]>).set(
      'in-reference-video',
      ['previs-1', 'previs-2'].map((mediaId) => ({
        type: 'video' as const,
        value: {
          kind: 'video' as const,
          mediaId,
          mediaPath: `projects/p/${mediaId}.webm`,
          mime: 'video/webm'
        },
        source: { nodeId: 'director-1', portId: 'out-preview-video', runId: 'run-1' },
        createdAt: Date.now()
      }))
    )

    const pending = videoExecutor(ctx)
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(3_000)
    await pending

    expect(videoSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ referenceVideoMediaIds: ['previs-1', 'previs-2'] })
    )
  })

  it('video executor 将多张统一图片端口按参考模式完整、稳定地提交，并保留音频参考', async () => {
    const videoSubmit = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { taskId: 'video-multimodal-task' } })
    installGateway({
      videoSubmit,
      videoTask: vi.fn().mockResolvedValue({
        ok: true,
        data: { status: 'success', mediaId: 'video-3', mediaPath: 'projects/p/video-3.mp4' }
      }),
      videoCancel: vi.fn()
    })
    const { ctx } = makeContext(
      'video',
      JSON.stringify({
        prompt: '图片 1 中的人物说话',
        modelKey: 'provider-1::MiniMax-H3',
        params: {}
      }),
      [minimaxVideoProvider()]
    )
    const mediaPacket = (kind: 'image' | 'audio', mediaId: string): NodeValuePacket => ({
      type: kind,
      value: { kind, mediaId, mediaPath: `projects/p/${mediaId}`, mime: `${kind}/test` },
      source: { nodeId: `${kind}-node`, portId: `out-${kind}`, runId: 'run-1' },
      createdAt: Date.now()
    })
    ;(ctx.inputs as Map<string, NodeValuePacket[]>).set('in-images', [
      mediaPacket('image', 'first'),
      mediaPacket('image', 'ref-1'),
      mediaPacket('image', 'ref-2')
    ])
    ;(ctx.inputs as Map<string, NodeValuePacket[]>).set('in-reference-audio', [
      mediaPacket('audio', 'audio-1')
    ])

    const pending = videoExecutor(ctx)
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(3_000)
    await pending

    expect(videoSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'reference',
        referenceImageMediaIds: ['first', 'ref-1', 'ref-2'],
        referenceAudioMediaIds: ['audio-1']
      })
    )
  })

  it('视频执行器不会把历史遗留的文生模式带入已连接图片的请求', async () => {
    const videoSubmit = vi.fn().mockResolvedValue({ ok: true, data: { taskId: 'video-mode-task' } })
    installGateway({
      videoSubmit,
      videoTask: vi.fn().mockResolvedValue({
        ok: true,
        data: { status: 'success', mediaId: 'video-4', mediaPath: 'projects/p/video-4.mp4' }
      }),
      videoCancel: vi.fn()
    })
    const { ctx } = makeContext(
      'video',
      JSON.stringify({
        prompt: '人物转身',
        modelKey: 'provider-1::MiniMax-H3',
        mode: 'text',
        params: {}
      }),
      [minimaxVideoProvider()]
    )
    ;(ctx.inputs as Map<string, NodeValuePacket[]>).set('in-images', [
      {
        type: 'image',
        value: {
          kind: 'image',
          mediaId: 'connected-image',
          mediaPath: 'projects/p/image.png',
          mime: 'image/png'
        },
        source: { nodeId: 'image-1', portId: 'out-image', runId: 'run-1' },
        createdAt: Date.now()
      }
    ])

    const pending = videoExecutor(ctx)
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(3_000)
    await pending

    expect(videoSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'reference', referenceImageMediaIds: ['connected-image'] })
    )
  })
})
