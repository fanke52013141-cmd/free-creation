import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSummary } from '@shared/types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { NodeValuePacket } from '@renderer/engine/contracts'
import { audioExecutor } from '@renderer/engine/executors/audio'
import { chatExecutor } from '@renderer/engine/executors/chat'
import { waitForChat, waitForVideo } from '@renderer/engine/executors/shared'
import { videoExecutor } from '@renderer/engine/executors/video'

const provider = (modality: 'text' | 'audio' | 'video'): ProviderSummary =>
  ({
    id: 'provider-1',
    name: '测试供应商',
    specId: 'relay',
    baseURL: 'https://example.invalid',
    hasApiKey: true,
    createdAt: 0,
    models: [{ id: `${modality}-model`, name: '测试模型', modality, providerId: 'provider-1' }]
  }) as ProviderSummary

function installGateway(gateway: Record<string, unknown>): void {
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
  providers: ProviderSummary[]
): {
  ctx: NodeExecutionContext
  props: Partial<NodeCardShape['props']>
  result: { value: string | null }
} {
  const props: Partial<NodeCardShape['props']> = {}
  const result = { value: null as string | null }
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
      text: config,
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
      updateProps: (patch) => Object.assign(props, patch),
      updateResult: (value) => {
        result.value = value
      }
    }
  }
}

beforeEach(() => vi.useFakeTimers())
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
    const { ctx, props, result } = makeContext(
      'audio',
      JSON.stringify({
        mode: 'generate',
        modelKey: 'provider-1::audio-model',
        text: '旁白',
        voice: 'alloy',
        format: 'mp3'
      }),
      [provider('audio')]
    )
    await expect(audioExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(props.mediaId).toBe('audio-1')
    expect(JSON.parse(result.value ?? '{}').results[0].runId).toBe('run-1')
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
    const { ctx, props, result } = makeContext(
      'video',
      JSON.stringify({ prompt: '猫咪挥爪', modelKey: 'provider-1::video-model', params: {} }),
      [provider('video')]
    )
    const pending = videoExecutor(ctx)
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toEqual({ status: 'done' })
    expect(props.mediaId).toBe('video-1')
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
      JSON.stringify({ prompt: '跟随人物移动', modelKey: 'provider-1::video-model', params: {} }),
      [provider('video')]
    )
    ;(ctx.inputs as Map<string, NodeValuePacket[]>).set('in-reference-video', [
      {
        type: 'video',
        value: {
          kind: 'video',
          mediaId: 'previs-1',
          mediaPath: 'projects/p/previs.webm',
          mime: 'video/webm'
        },
        source: { nodeId: 'director-1', portId: 'out-preview-video', runId: 'run-1' },
        createdAt: Date.now()
      }
    ])

    const pending = videoExecutor(ctx)
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(3_000)
    await pending

    expect(videoSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ referenceVideoMediaId: 'previs-1' })
    )
  })
})
