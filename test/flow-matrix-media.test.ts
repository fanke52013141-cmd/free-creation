// @vitest-environment jsdom
// 节点流测试矩阵 · G 本地媒体链（真实 FFmpeg 全链，2026-11-17）。
// 引擎→执行器→rendererGateway→(window.api 桩=真实主进程处理器)→真实 ffmpeg；
// 只 mock 持久层（db + media.repo），产物真实落盘并用 ffprobe 独立复核。
import { copyFile, mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorkflow } from '@renderer/engine/executor'
import { registerAllNodeTypes } from './helpers/registerNodes'
import {
  approveAllConfirms,
  bindSaveCoordinator,
  buildFlowEditor,
  installWindowApi,
  resetEnginePhase,
  runStateOf
} from './helpers/flowHarness'

const h = vi.hoisted(() => ({
  dataDir: '',
  saved: [] as Array<{ path: string; name: string; ext: string }>,
  byId: new Map<
    string,
    { abs: string; rel: string; kind: 'video' | 'audio' | 'image'; mime: string }
  >(),
  byRel: new Map<string, string>(),
  timelineOutputs: [] as string[],
  /** 与真实仓库同形的 MediaAsset（mime 必有——媒体结果集合解析器强制校验），并回注媒体库供下游消费。 */
  registerAsset: (
    path: string,
    ext: string,
    name: string,
    index: number
  ): Record<string, unknown> => {
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.mp4'
          ? 'video/mp4'
          : ext === '.m4a'
            ? 'audio/mp4'
            : ext === '.mp3'
              ? 'audio/mpeg'
              : 'application/octet-stream'
    const kind: 'video' | 'audio' | 'image' = mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'image'
    const id = `asset-${index}`
    h.byId.set(id, { abs: path, rel: path, kind, mime })
    h.byRel.set(path, path)
    return { id, kind, mime, path, name, sizeBytes: 1, createdAt: Date.now() }
  }
}))

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (mediaId: string) => {
        const item = h.byId.get(mediaId)
        if (!item) return undefined
        return { path: item.rel, mime: item.mime, kind: item.kind, size_bytes: 1 }
      }
    })
  })
}))

vi.mock('../src/main/store/media.repo', () => ({
  getMediaAbsPath: (relPath: string) => h.byRel.get(relPath),
  saveFileAsset: async (_projectId: string, srcAbs: string, ext: string, name: string) => {
    const dest = join(h.dataDir, `${h.saved.length}${ext}`)
    await copyFile(srcAbs, dest)
    h.saved.push({ path: dest, name, ext })
    return h.registerAsset(dest, ext, name, h.saved.length)
  },
  saveBufferAsset: async (_projectId: string, buffer: Buffer, ext: string, name: string) => {
    const dest = join(h.dataDir, `${h.saved.length}${ext}`)
    await writeFile(dest, buffer)
    h.saved.push({ path: dest, name, ext })
    return h.registerAsset(dest, ext, name, h.saved.length)
  },
  deleteMedia: () => undefined
}))

import { transformImageCrop, transformImageSplit } from '../src/main/media/image-transform'
import {
  getLocalMediaCapabilities,
  transformSoundAdjust,
  transformVideoClip,
  transformVideoFrame
} from '../src/main/media/video-transform'
import { composeTimeline } from '../src/main/media/timeline-compose'

const toolsReady = (() => {
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  const ffprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' })
  return ffmpeg.status === 0 && ffprobe.status === 0
})()

function makeFixture(
  name: string,
  args: string[],
  kind: 'video' | 'audio' | 'image',
  mime: string
): void {
  const abs = join(h.dataDir, name)
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, abs], {
    stdio: 'ignore'
  })
  expect(res.status, `生成素材 ${name} 失败`).toBe(0)
  const id = name.replace(/\.[^.]+$/, '')
  h.byId.set(id, { abs, rel: abs, kind, mime })
  h.byRel.set(abs, abs)
}

function durationMs(file: string): number {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' }
  )
  expect(res.status, res.stderr).toBe(0)
  return Math.round(Number(res.stdout.trim()) * 1000)
}

let restoreApi: (() => void) | null = null

beforeAll(async () => {
  registerAllNodeTypes()
  bindSaveCoordinator()
  if (!toolsReady) return
  h.dataDir = await mkdtemp(join(tmpdir(), 'canvas-flow-matrix-media-'))
  makeFixture(
    'src-video.mp4',
    ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', '-pix_fmt', 'yuv420p'],
    'video',
    'video/mp4'
  )
  makeFixture(
    'src-audio.m4a',
    ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac'],
    'audio',
    'audio/m4a'
  )
  makeFixture(
    'src-image.png',
    ['-f', 'lavfi', '-i', 'color=c=red:size=320x240', '-frames:v', '1'],
    'image',
    'image/png'
  )

  restoreApi = installWindowApi({
    getLocalMediaCapabilities: async () => ({ ok: true, data: await getLocalMediaCapabilities() }),
    deleteMedia: async () => undefined,
    cancelMediaTransforms: async () => ({ ok: true, data: { cancelled: 0 } }),
    cropImage: async (input: { projectId: string; sourceMediaId: string; config: unknown }) => ({
      ok: true,
      data: await transformImageCrop(input as never)
    }),
    splitImageGrid: async (input: {
      projectId: string
      sourceMediaId: string
      config: unknown
    }) => ({
      ok: true,
      data: await transformImageSplit(input as never)
    }),
    extractVideoFrame: async (input: {
      projectId: string
      sourceMediaId: string
      config: unknown
    }) => ({
      ok: true,
      data: await transformVideoFrame(input as never)
    }),
    clipVideo: async (input: { projectId: string; sourceMediaId: string; config: unknown }) => {
      const asset = await transformVideoClip(input as never)
      return { ok: true, data: asset }
    },
    soundAdjust: async (input: { projectId: string; sourceMediaId: string; config: unknown }) => ({
      ok: true,
      data: await transformSoundAdjust(input as never)
    }),
    composeTimeline: async (input: {
      width: number
      height: number
      frameRate: number
      clips: Array<{ kind: string; mediaId: string; startMs: number; durationMs: number }>
      audioClips?: Array<{ kind: string; mediaId: string; startMs: number; durationMs: number }>
    }) => {
      const toCompose = (clip: {
        kind: string
        mediaId: string
        startMs: number
        durationMs: number
      }) => ({
        kind: clip.kind as 'video' | 'image' | 'audio',
        sourcePath: h.byId.get(clip.mediaId)?.abs ?? '',
        startMs: clip.startMs,
        durationMs: clip.durationMs
      })
      const outputPath = join(h.dataDir, `timeline-out-${Date.now()}.mp4`)
      h.timelineOutputs.push(outputPath)
      const composed = await composeTimeline({
        outputPath,
        width: input.width,
        height: input.height,
        frameRate: input.frameRate,
        clips: input.clips.map(toCompose),
        audioClips: (input.audioClips ?? []).map(toCompose)
      } as never)
      if (!composed.ok)
        return { ok: false, error: { code: 'TIMELINE_COMPOSE_FAILED', message: composed.reason } }
      return {
        ok: true,
        data: { id: `timeline-${h.saved.length}`, path: outputPath, mime: 'video/mp4' }
      }
    }
  })
})

beforeEach(() => {
  resetEnginePhase()
  return approveAllConfirms()
})

afterAll(async () => {
  restoreApi?.()
  if (h.dataDir) await rm(h.dataDir, { recursive: true, force: true }).catch(() => undefined)
})

;(toolsReady ? describe : describe.skip)('G · 本地媒体链（真实 FFmpeg）', () => {
  it('G1 image→image-crop→image-split：裁剪后拆分，产物真实落盘', async () => {
    const savedBefore = h.saved.length
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'src',
          nodeType: 'image',
          mediaId: 'src-image',
          mediaPath: h.byId.get('src-image')?.abs ?? '',
          mediaMime: 'image/png'
        },
        {
          id: 'crop',
          nodeType: 'image-crop',
          config: { mode: 'rect', rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }
        },
        { id: 'split', nodeType: 'image-split', config: { rows: 1, cols: 2 } }
      ],
      [
        { from: 'src', to: 'crop', fromPort: 'out-image', toPort: 'in-image' },
        { from: 'crop', to: 'split', fromPort: 'out-image', toPort: 'in-image' }
      ]
    )
    await runWorkflow(editor, 'p-g1', [])
    expect(runStateOf(node('crop')).run).toBe('success')
    const split = runStateOf(node('split'))
    expect(split.run).toBe('success')
    // 裁剪 1 张 + 拆分 2 格 = 至少 3 个真实新文件。
    expect(h.saved.length - savedBefore).toBeGreaterThanOrEqual(3)
    for (const item of h.saved.slice(savedBefore)) {
      const info = await stat(item.path)
      expect(info.size).toBeGreaterThan(0)
    }
  }, 30000)

  it('G2 video-asset→video-frame：500ms 抽帧产出真实 PNG', async () => {
    const savedBefore = h.saved.length
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'src',
          nodeType: 'video-asset',
          mediaId: 'src-video',
          mediaPath: h.byId.get('src-video')?.abs ?? '',
          mediaMime: 'video/mp4'
        },
        {
          id: 'frame',
          nodeType: 'video-frame',
          config: { version: 2, mode: 'time', timeMs: 500, format: 'png' }
        }
      ],
      [{ from: 'src', to: 'frame', fromPort: 'out-video', toPort: 'in-video' }]
    )
    await runWorkflow(editor, 'p-g2', [])
    const state = runStateOf(node('frame'))
    expect(state.run).toBe('success')
    expect(h.saved.length - savedBefore).toBeGreaterThanOrEqual(1)
    expect(h.saved[h.saved.length - 1]?.ext).toBe('.png')
  }, 30000)

  it('G3 video-asset→video-clip：截取 1s，ffprobe 复核时长', async () => {
    const savedBefore = h.saved.length
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'src',
          nodeType: 'video-asset',
          mediaId: 'src-video',
          mediaPath: h.byId.get('src-video')?.abs ?? '',
          mediaMime: 'video/mp4'
        },
        {
          id: 'clip',
          nodeType: 'video-clip',
          config: { version: 3, startMs: 0, endMs: 1000, keepVideo: true, keepAudio: false }
        }
      ],
      [{ from: 'src', to: 'clip', fromPort: 'out-video', toPort: 'in-video' }]
    )
    await runWorkflow(editor, 'p-g3', [])
    const state = runStateOf(node('clip'))
    expect(state.run).toBe('success')
    expect(h.saved.length - savedBefore).toBeGreaterThanOrEqual(1)
    const output = h.saved[h.saved.length - 1]
    expect(Math.abs(durationMs(output.path) - 1000)).toBeLessThan(200)
  }, 30000)

  it('G4 audio→sound-adjust：变速/音量调整产出真实音频', async () => {
    const savedBefore = h.saved.length
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'src',
          nodeType: 'audio',
          mediaId: 'src-audio',
          mediaPath: h.byId.get('src-audio')?.abs ?? '',
          mediaMime: 'audio/m4a'
        },
        {
          id: 'adjust',
          nodeType: 'sound-adjust',
          config: { mode: 'rate', rate: 1, volumePercent: 120 }
        }
      ],
      [{ from: 'src', to: 'adjust', fromPort: 'out-audio', toPort: 'in-audio' }]
    )
    await runWorkflow(editor, 'p-g4', [])
    const state = runStateOf(node('adjust'))
    expect(state.run).toBe('success')
    expect(h.saved.length - savedBefore).toBeGreaterThanOrEqual(1)
    const info = await stat(h.saved[h.saved.length - 1]!.path)
    expect(info.size).toBeGreaterThan(0)
  }, 30000)

  it('G5 timeline：两段视频 + 一段音频真实合成', async () => {
    const savedBefore = h.saved.length
    const timeline = await import('@shared/timeline')
    let data = timeline.createEmptyTimeline()
    const [videoTrack, audioTrack] = data.tracks
    for (const mediaId of ['src-video', 'src-video']) {
      const added = timeline.addClip(data, {
        trackId: videoTrack.id,
        kind: 'video',
        mediaId,
        mediaPath: h.byId.get(mediaId)?.abs ?? '',
        name: mediaId,
        sourceDurationMs: 2000
      })
      if (!added.ok) throw new Error(added.reason)
      data = added.data
    }
    const audioAdded = timeline.addClip(data, {
      trackId: audioTrack.id,
      kind: 'audio',
      mediaId: 'src-audio',
      mediaPath: h.byId.get('src-audio')?.abs ?? '',
      name: 'bgm',
      sourceDurationMs: 3000
    })
    if (!audioAdded.ok) throw new Error(audioAdded.reason)
    data = audioAdded.data

    const { editor, node } = buildFlowEditor([
      { id: 'tl', nodeType: 'timeline', text: timeline.serializeTimeline(data) }
    ])
    await runWorkflow(editor, 'p-g5', [])
    const state = runStateOf(node('tl'))
    expect(state.run).toBe('success')
    const out = h.timelineOutputs[h.timelineOutputs.length - 1]
    expect(out).toBeTruthy()
    expect(Math.abs(durationMs(out) - 4000)).toBeLessThan(500)
  }, 60000)
})
