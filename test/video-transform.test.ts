// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseVideoFrameConfig,
  parseVideoRangeConfig,
  serializeVideoConfig
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

describe('视频处理配置', () => {
  it('损坏配置回退到安全默认值，范围始终至少 1ms', () => {
    expect(parseVideoFrameConfig('not-json')).toEqual({ version: 1, timeMs: 0 })
    expect(parseVideoRangeConfig('{bad')).toEqual({ version: 1, startMs: 0, endMs: 1000 })
    expect(parseVideoRangeConfig(JSON.stringify({ startMs: 900, endMs: 100 }))).toEqual({
      version: 1,
      startMs: 900,
      endMs: 901
    })
  })

  it('序列化后的毫秒配置可稳定解析', () => {
    expect(parseVideoFrameConfig(serializeVideoConfig({ version: 1, timeMs: 1234 }))).toEqual({
      version: 1,
      timeMs: 1234
    })
    expect(
      parseVideoRangeConfig(serializeVideoConfig({ version: 1, startMs: 400, endMs: 2400 }))
    ).toEqual({ version: 1, startMs: 400, endMs: 2400 })
  })
})

function context(type: 'video-frame' | 'video-clip' | 'video-audio'): {
  ctx: NodeExecutionContext
  props: Record<string, unknown>
  result: { value: string | null }
} {
  const props: Record<string, unknown> = {}
  const result = { value: null as string | null }
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
      config:
        type === 'video-frame'
          ? JSON.stringify({ version: 1, timeMs: 1200 })
          : JSON.stringify({ version: 1, startMs: 500, endMs: 1700 }),
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
        contractVersion: 1,
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
    ['video-audio', videoAudioExecutor, 'extractVideoAudio', 'audio-1', 'audio/mp4']
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
      reason: '请连接一段视频到“源视频”输入'
    })
  })
})
