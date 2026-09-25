import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSummary } from '@shared/types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { GatewayClient } from '@shared/engine/gateway-client'
import type { NodeValuePacket } from '@renderer/engine/contracts'
import { audioExecutor } from '@renderer/engine/executors/audio'
import { mergeShapeMeta } from '@renderer/engine/executor'
import { speechExecutor } from '@renderer/engine/executors/speech'
import { voiceDesignExecutor } from '@renderer/engine/executors/voiceDesign'
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

const volcSpeechProvider = (): ProviderSummary =>
  ({
    ...provider('audio'),
    specId: 'volc-speech',
    models: [
      { id: 'seed-audio-1.0', name: 'Seed Audio 1.0', modality: 'audio', providerId: 'provider-1' }
    ]
  }) as ProviderSummary

const minimaxSpeechProvider = (): ProviderSummary =>
  ({
    ...provider('audio'),
    specId: 'minimax',
    models: [
      { id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo', modality: 'audio', providerId: 'provider-1' }
    ]
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
  meta: Record<string, unknown>
  artifacts: unknown[]
} {
  const props: Partial<NodeCardShape['props']> = {}
  const result = { value: null as string | null }
  const meta: Record<string, unknown> = {}
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
    meta,
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
      // 与真实运行器同一份合并语义：meta 只能有 JSON 值，undefined/null 是删除键。
      // 早先这里直接 Object.assign，把 `nodeExtra: undefined` 原样抄进 meta，
      // 单测全绿而真机画布被 tldraw 的 schema 校验炸掉（2026-09-19 真机验收）。
      updateMeta: (patch) => {
        const next = mergeShapeMeta(meta, patch)
        for (const key of Object.keys(meta)) delete meta[key]
        Object.assign(meta, next)
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
      JSON.stringify({ modelKey: 'provider-1::image-model' }),
      [provider('image')],
      '角色正面图'
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
      expect.objectContaining({ prompt: '角色正面图', referenceMediaIds: ['a', 'b'] })
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

  it('配音执行器按 config.backend 走模型驱动网关，并记录精确运行来源', async () => {
    const speechGenerate = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        asset: { id: 'speech-1', path: 'projects/p/speech.mp3', mime: 'audio/mpeg', name: '旁白' }
      }
    })
    installGateway({ speechGenerate })
    const { ctx, props, result, meta, artifacts } = makeContext(
      'speech',
      JSON.stringify({ backend: 'minimax', providerId: 'provider-1', modelId: 'speech-2.8-hd' }),
      [provider('audio')],
      '旁白'
    )
    // 上一次运行留下的字幕：本次没有字幕就必须把它清掉，而不是留着过期值。
    meta.nodeExtra = '{"out-subtitle":"stale"}'
    await expect(speechExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(speechGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'provider-1',
        modelId: 'speech-2.8-hd',
        text: '旁白'
      })
    )
    expect(props.mediaId).toBeUndefined()
    expect(artifacts).toContainEqual(
      expect.objectContaining({ kind: 'audio', mediaId: 'speech-1' })
    )
    expect(JSON.parse(result.value ?? '{}').results[0].runId).toBe('run-1')
    // 本次没有字幕，必须清空而不是保留上一次的 nodeExtra。
    expect(meta.nodeExtra).toBeUndefined()
    // 清空只能是「删掉这个键」：meta 里留一个值为 undefined 的键会被 tldraw 的
    // schema 校验整条拒掉（真机验收里配音成功之后画布就是这么炸的）。
    expect('nodeExtra' in meta).toBe(false)
    expect(Object.values(meta).some((v) => v === undefined)).toBe(false)
  })

  // 溯源记的是「实际生效」的音色。用户在节点上留空时，MiniMax 通道会被网关兜底成系统
  // 音色——记输入框里的空值等于什么都没记，两条留空跑出来的音频就又分不开了。
  it('配音执行器记录网关回传的实际音色，而不是节点上的空值', async () => {
    installGateway({
      speechGenerate: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          asset: {
            id: 'speech-1',
            path: 'projects/p/speech.mp3',
            mime: 'audio/mpeg',
            name: '旁白'
          },
          voiceId: 'male-qn-qingse'
        }
      })
    })
    const { ctx, result } = makeContext(
      'speech',
      JSON.stringify({ backend: 'minimax', providerId: 'provider-1', modelId: 'speech-2.8-hd' }),
      [provider('audio')],
      '旁白'
    )
    await expect(speechExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(JSON.parse(result.value ?? '{}').results[0].voiceId).toBe('male-qn-qingse')
  })

  // 火山用户留空时，服务端最终选用了哪个 speaker 未知，因此产物追溯不写 voiceId。
  it('网关无法确定音色时不写 voiceId 键', async () => {
    installGateway({
      speechGenerate: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          asset: { id: 'speech-1', path: 'projects/p/speech.mp3', mime: 'audio/mpeg', name: '旁白' }
        }
      })
    })
    const { ctx, result } = makeContext(
      'speech',
      JSON.stringify({ backend: 'volc', providerId: 'provider-1', modelId: 'seed-audio-1.0' }),
      [volcSpeechProvider()],
      '旁白'
    )
    await expect(speechExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect('voiceId' in JSON.parse(result.value ?? '{}').results[0]).toBe(false)
  })

  it('配音执行器在火山 1.0 开启字幕时写入 out-subtitle 的结构化结果', async () => {
    installGateway({
      speechGenerate: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          asset: {
            id: 'speech-2',
            path: 'projects/p/speech.mp3',
            mime: 'audio/mpeg',
            name: '旁白'
          },
          subtitle: {
            text: '你好世界',
            sentences: [{ start_time: 0, end_time: 1200, text: '你好世界' }]
          }
        }
      })
    })
    const { ctx, meta } = makeContext(
      'speech',
      JSON.stringify({ backend: 'volc', providerId: 'provider-1', modelId: 'seed-audio-1.0' }),
      [volcSpeechProvider()],
      '你好世界'
    )
    await expect(speechExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(JSON.parse(String(meta.nodeExtra))['out-subtitle'].sentences).toHaveLength(1)
  })

  it('配音执行器不猜测供应商：未选模型时跳过而不是发起请求', async () => {
    const speechGenerate = vi.fn()
    installGateway({ speechGenerate })
    const { ctx } = makeContext(
      'speech',
      JSON.stringify({ backend: 'minimax' }),
      [provider('audio')],
      '旁白'
    )
    await expect(speechExecutor(ctx)).resolves.toEqual({
      status: 'skipped',
      reason: '未选择语音模型'
    })
    expect(speechGenerate).not.toHaveBeenCalled()
  })

  it('音色设计执行器产出试听音频与可复用的音色档案', async () => {
    const voiceDesign = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        asset: {
          id: 'voice-1',
          path: 'projects/p/trial.mp3',
          mime: 'audio/mpeg',
          name: '音色试听'
        },
        voiceId: 'CanvasVoice_2026'
      }
    })
    installGateway({ voiceDesign })
    const { ctx, meta, artifacts } = makeContext(
      'voice-design',
      JSON.stringify({ providerId: 'provider-1' }),
      [],
      '清亮温柔的年轻女声'
    )
    await expect(voiceDesignExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(JSON.parse(String(meta.nodeExtra))['out-json'].voice_id).toBe('CanvasVoice_2026')
    expect(artifacts).toContainEqual(
      expect.objectContaining({ kind: 'audio', mediaId: 'voice-1', portId: 'out-audio' })
    )
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

  it('语音克隆执行器从节点正文读取朗读内容，并回写可复用的音色档案', async () => {
    const ttsGenerate = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        asset: { id: 'tts-1', path: 'projects/p/tts.wav', mime: 'audio/wav', name: '复刻旁白' },
        voiceId: 'CanvasVoice_2026'
      }
    })
    installGateway({ ttsGenerate })
    const { ctx, meta, artifacts } = makeContext(
      'tts',
      JSON.stringify({
        backend: 'minimax',
        providerId: 'provider-1',
        modelId: 'speech-2.8-turbo',
        refMediaId: 'reference-audio',
        text: '不应作为当前正文执行'
      }),
      [minimaxSpeechProvider()],
      '当前画布正文'
    )

    await expect(ttsExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(ttsGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ referenceAudioId: 'reference-audio', text: '当前画布正文' })
    )
    expect(artifacts).toContainEqual(expect.objectContaining({ kind: 'audio', mediaId: 'tts-1' }))
    expect(JSON.parse(String(meta.nodeExtra))['out-json'].voice_id).toBe('CanvasVoice_2026')
  })

  it('旧本地 IndexTTS 配置不再走音色克隆请求', async () => {
    const ttsGenerate = vi.fn()
    installGateway({ ttsGenerate })
    const { ctx, meta } = makeContext(
      'tts',
      JSON.stringify({ backend: 'comfyui', refMediaId: 'reference-audio' }),
      [],
      '本地合成'
    )
    await expect(ttsExecutor(ctx)).resolves.toEqual({
      status: 'skipped',
      reason: '语音克隆已统一使用 MiniMax；请在节点内切换旧的本地 IndexTTS 配置'
    })
    expect(ttsGenerate).not.toHaveBeenCalled()
    expect(meta.nodeExtra).toBeUndefined()
  })

  it('video executor submits, polls, and records the completed media result', async () => {
    const videoSubmit = vi.fn().mockResolvedValue({ ok: true, data: { taskId: 'video-task' } })
    installGateway({
      videoSubmit,
      videoTask: vi.fn().mockResolvedValue({
        ok: true,
        data: { status: 'success', mediaId: 'video-1', mediaPath: 'projects/p/video.mp4' }
      }),
      videoCancel: vi.fn()
    })
    const { ctx, props, result, artifacts } = makeContext(
      'video',
      JSON.stringify({ modelKey: 'provider-1::video-model', params: {} }),
      [provider('video')],
      '猫咪挥爪'
    )
    const pending = videoExecutor(ctx)
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toEqual({ status: 'done' })
    expect(videoSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: '猫咪挥爪' }))
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
      JSON.stringify({ modelKey: 'provider-1::MiniMax-H3', params: {} }),
      [minimaxVideoProvider()],
      '跟随人物移动'
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
        modelKey: 'provider-1::MiniMax-H3',
        params: {}
      }),
      [minimaxVideoProvider()],
      '图片 1 中的人物说话'
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
        modelKey: 'provider-1::MiniMax-H3',
        mode: 'text',
        params: {}
      }),
      [minimaxVideoProvider()],
      '人物转身'
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

describe('shape.meta 只能是 JSON 值（2026-09-19 真机验收 P0）', () => {
  it('补丁里的 undefined 与 null 都是删除该键，而不是留下一个非法值', () => {
    expect(mergeShapeMeta({ nodeExtra: '旧字幕', keep: 1 }, { nodeExtra: undefined })).toEqual({
      keep: 1
    })
    expect('nodeExtra' in mergeShapeMeta({ nodeExtra: '旧字幕' }, { nodeExtra: null })).toBe(false)
  })

  it('合法但为假的值必须原样保留，清空语义不能顺手吃掉它们', () => {
    const merged = mergeShapeMeta({}, { a: '', b: 0, c: false, d: null, e: undefined })
    expect(merged).toEqual({ a: '', b: 0, c: false })
  })

  it('合并不改动传进来的 meta（运行器每轮都从文档重新读一份）', () => {
    const current = { nodeRun: { status: 'running' } }
    mergeShapeMeta(current, { nodeRun: { status: 'success' }, nodeExtra: undefined })
    expect(current).toEqual({ nodeRun: { status: 'running' } })
  })
})
