// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseVideoFrameConfig,
  parseVideoClipConfig,
  parseVideoAudioConfig,
  parseVocalSeparationConfig,
  serializeVideoFrameConfig,
  serializeVideoClipConfig,
  serializeVideoAudioConfig,
  serializeVocalSeparationConfig
} from '@shared/video-transform'
import {
  videoAudioExecutor,
  videoClipExecutor,
  videoFrameExecutor
} from '@renderer/engine/executors/videoTransforms'
import { parseMediaResultCollection } from '@renderer/nodes/nodeValues'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'

afterEach(() => vi.restoreAllMocks())

describe('视频处理配置 · v2', () => {
  it('取帧：损坏配置回退到安全默认值', () => {
    expect(parseVideoFrameConfig('not-json')).toEqual({
      version: 2,
      mode: 'first',
      timeMs: 0,
      format: 'png'
    })
  })

  it('取帧：序列化后可稳定解析', () => {
    const cfg = { version: 2, mode: 'custom' as const, timeMs: 1234, format: 'jpg' as const }
    expect(parseVideoFrameConfig(serializeVideoFrameConfig(cfg))).toEqual(cfg)
  })

  it('截取：损坏配置回退到安全默认值，区间至少 1ms', () => {
    expect(parseVideoClipConfig('{bad')).toEqual({
      version: 2,
      startMs: 0,
      endMs: 1000,
      includeAudio: true,
      quality: 'balanced'
    })
    // startMs > endMs 时自动纠正
    expect(
      parseVideoClipConfig(JSON.stringify({ startMs: 900, endMs: 100 }))
    ).toEqual({
      version: 2,
      startMs: 900,
      endMs: 901,
      includeAudio: true,
      quality: 'balanced'
    })
  })

  it('截取：序列化后可稳定解析', () => {
    const cfg = {
      version: 2,
      startMs: 400,
      endMs: 2400,
      includeAudio: false,
      quality: 'fast' as const
    }
    expect(parseVideoClipConfig(serializeVideoClipConfig(cfg))).toEqual(cfg)
  })

  it('提音：损坏配置回退到安全默认值', () => {
    expect(parseVideoAudioConfig('not-json')).toEqual({
      version: 2,
      startMs: 0,
      endMs: 1000,
      format: 'm4a',
      sampleRate: 44100
    })
  })

  it('提音：序列化后可稳定解析', () => {
    const cfg = {
      version: 2,
      startMs: 100,
      endMs: 5000,
      format: 'm4a' as const,
      sampleRate: 48000 as const
    }
    expect(parseVideoAudioConfig(serializeVideoAudioConfig(cfg))).toEqual(cfg)
  })

  it('人声分离：损坏配置回退到安全默认值', () => {
    expect(parseVocalSeparationConfig('not-json')).toEqual({
      version: 1,
      mode: 'fast',
      outputAccompaniment: true
    })
  })

  it('人声分离：序列化后可稳定解析', () => {
    const cfg = { version: 1, mode: 'quality' as const, outputAccompaniment: true }
    expect(parseVocalSeparationConfig(serializeVocalSeparationConfig(cfg))).toEqual(cfg)
  })
})

function context(type: 'video-frame' | 'video-clip' | 'video-audio'): {
  ctx: NodeExecutionContext
  props: Record<string, unknown>
  result: { value: string | null }
} {
  const props: Record<string, unknown> = {}
  const result = { value: null as string | null }
  const config =
    type === 'video-frame'
      ? JSON.stringify({ version: 2, mode: 'custom', timeMs: 1200, format: 'png' })
      : type === 'video-clip'
        ? JSON.stringify({ version: 2, startMs: 500, endMs: 1700, includeAudio: true, quality: 'balanced' })
        : JSON.stringify({ version: 2, startMs: 500, endMs: 1700, format: 'wav', sampleRate: 44100 })
  const shape = {
    id: `shape:${type}`,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: type,
      title: type,
      config,
      text: '',
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
        type,
        contractVersion: 2,
        title: type,
        x: 0,
        y: 0,
        w: 340,
        h: 260,
        ports: [],
        params: {},
        content: { kind: 'empty' },
        exec: { status: 'idle' },
        meta: { source: 'derive', createdAt: 0 }
      },
      shape,
      inputs: new Map([
        [
          'in-video',
          [
            {
              type: 'video',
              value: {
                kind: 'video',
                mediaId: 'source-video',
                mediaPath: 'projects/project-a/media/source.mp4',
                mime: 'video/mp4'
              },
              schema: undefined,
              source: { nodeId: 'source-node', portId: 'out-video', runId: 'run-source' },
              createdAt: 0
            }
          ]
        ]
      ]),
      projectId: 'project-a',
      runId: 'run-video-transform',
      providers: [],
      signal: { cancelled: false },
      updateProps: (next) => Object.assign(props, next),
      updateResult: (value) => {
        result.value = value
      }
    }
  }
}

describe('视频处理执行器', () => {
  it.each([
    ['video-frame', videoFrameExecutor, 'extractVideoFrame', 'frame-1', 'image/png'],
    ['video-clip', videoClipExecutor, 'clipVideo', 'clip-1', 'video/mp4'],
    ['video-audio', videoAudioExecutor, 'extractVideoAudio', 'audio-1', 'audio/wav']
  ] as const)(
    '%s 只使用 in-video 的真实资产并记录新结果',
    async (type, executor, apiName, id, mime) => {
      const api = {
        extractVideoFrame: vi.fn(),
        clipVideo: vi.fn(),
        extractVideoAudio: vi.fn()
      }
      api[apiName].mockResolvedValue({
        ok: true,
        data: { id, path: `projects/project-a/media/${id}`, mime, name: id }
      })
      globalThis.window = { api } as unknown as Window & typeof globalThis
      const item = context(type)

      await expect(executor(item.ctx)).resolves.toEqual({ status: 'done' })
      expect(api[apiName]).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-a', sourceMediaId: 'source-video' })
      )
      expect(item.props).toMatchObject({ mediaId: id, mediaMime: mime })
      expect(parseMediaResultCollection(item.result.value ?? '')?.results[0]).toMatchObject({
        mediaId: id,
        runId: 'run-video-transform'
      })
    }
  )

  it('没有真实视频连线时明确跳过', async () => {
    const item = context('video-frame')
    item.ctx.inputs = new Map()
    await expect(videoFrameExecutor(item.ctx)).resolves.toEqual({
      status: 'skipped',
      reason: '请连接一段视频到"源视频"输入'
    })
  })

  it('提音执行器透传 v2 配置（format + sampleRate）给 IPC', async () => {
    const api = { extractVideoAudio: vi.fn() }
    api.extractVideoAudio.mockResolvedValue({
      ok: true,
      data: { id: 'audio-1', path: 'projects/project-a/media/audio-1', mime: 'audio/wav', name: 'audio-1' }
    })
    globalThis.window = { api } as unknown as Window & typeof globalThis
    const item = context('video-audio')
    item.ctx.shape.props.config = JSON.stringify({
      version: 2,
      startMs: 500,
      endMs: 1700,
      format: 'm4a',
      sampleRate: 48000
    })
    await videoAudioExecutor(item.ctx)
    const callArg = api.extractVideoAudio.mock.calls[0][0] as {
      config: { format?: string; sampleRate?: number }
    }
    expect(callArg.config.format).toBe('m4a')
    expect(callArg.config.sampleRate).toBe(48000)
  })
})
