// 时间线执行器集成测试（M4）
//
// 覆盖「节点数据 → 预检 → 主进程合成 → 成片登记为独立资产」这条真实链路：
// 用真实 FFmpeg 合成两段视频 + 一段音频，只把 IPC 换成进程内直调，
// 其余（时间线解析、能力预检、取消竞速、nodeResult 与 emitArtifact 契约）都是生产代码。
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IpcEnvelope, LocalMediaCapabilities } from '@shared/contracts'
import type { NodeExecutionContext } from '@shared/engine/executor-types'
import { timelineExecutor } from '@shared/engine/executors/timeline'
import {
  addClip,
  clipsOfTrack,
  createEmptyTimeline,
  serializeTimeline,
  type TimelineData
} from '@shared/timeline'
import { composeTimeline } from '../src/main/media/timeline-compose'

const hasFfmpeg = ((): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const CAPABILITIES: LocalMediaCapabilities = {
  ffmpeg: { available: true, message: '已就绪' },
  ffprobe: { available: true, message: '已就绪' },
  audioSeparator: { available: false, message: '未安装' }
}

let workDir = ''
const mediaPaths = new Map<string, string>()

function makeMedia(name: string, args: string[]): string {
  const target = join(workDir, name)
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, target], {
    stdio: 'ignore'
  })
  return target
}

beforeAll(async () => {
  if (!hasFfmpeg) return
  workDir = await mkdtemp(join(tmpdir(), 'canvas-studio-timeline-exec-'))
  mediaPaths.set(
    'vid1',
    makeMedia('a.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', '-pix_fmt', 'yuv420p'])
  )
  mediaPaths.set(
    'vid2',
    makeMedia('b.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:size=320x240:rate=30:duration=2', '-pix_fmt', 'yuv420p'])
  )
  mediaPaths.set(
    'aud1',
    makeMedia('c.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac'])
  )
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
})

interface Harness {
  ctx: NodeExecutionContext
  result: string[]
  artifacts: Array<{ kind: string; portId: string; mediaId: string }>
  traces: string[]
}

/** 只把 gateway 换成本进程直调，其余上下文按执行器真实读写的字段提供。 */
function createHarness(
  text: string,
  options: { cancelled?: boolean; ffmpegAvailable?: boolean } = {}
): Harness {
  const result: string[] = []
  const artifacts: Harness['artifacts'] = []
  const traces: string[] = []
  const gateway = {
    getLocalMediaCapabilities: async (): Promise<IpcEnvelope<LocalMediaCapabilities>> => ({
      ok: true,
      data: {
        ...CAPABILITIES,
        ffmpeg: {
          available: options.ffmpegAvailable !== false,
          message: options.ffmpegAvailable === false ? '未找到本机 FFmpeg' : '已就绪'
        }
      }
    }),
    composeTimeline: async (input: {
      projectId: string
      nodeId: string
      width: number
      height: number
      frameRate: number
      clips: Array<{ kind: string; mediaId: string; startMs: number; durationMs: number }>
      audioClips?: Array<{ kind: string; mediaId: string; startMs: number; durationMs: number }>
    }): Promise<IpcEnvelope<{ id: string; path: string; mime: string }>> => {
      const toComposeClip = (clip: {
        kind: string
        mediaId: string
        startMs: number
        durationMs: number
      }): { kind: 'video' | 'image' | 'audio'; sourcePath: string; startMs: number; durationMs: number } => {
        const sourcePath = mediaPaths.get(clip.mediaId)
        if (!sourcePath) throw new Error(`测试素材缺失：${clip.mediaId}`)
        return {
          kind: clip.kind as 'video' | 'image' | 'audio',
          sourcePath,
          startMs: clip.startMs,
          durationMs: clip.durationMs
        }
      }
      const outputPath = join(workDir, `out-${Date.now()}.mp4`)
      const composed = await composeTimeline({
        outputPath,
        width: input.width,
        height: input.height,
        frameRate: input.frameRate,
        clips: input.clips.map(toComposeClip),
        audioClips: (input.audioClips ?? []).map(toComposeClip)
      })
      if (!composed.ok) {
        return { ok: false, error: { code: 'TIMELINE_COMPOSE_FAILED', message: composed.reason } }
      }
      return { ok: true, data: { id: 'composed', path: outputPath, mime: 'video/mp4' } }
    },
    cancelMediaTransforms: async () => ({ ok: true, data: { cancelled: 0 } })
  }
  const ctx = {
    node: { id: 'node-1' },
    shape: {
      id: 'shape-1',
      props: { text, config: '', nodeType: 'timeline' },
      meta: {}
    },
    inputs: {},
    projectId: 'project-1',
    runId: 'run-1',
    signal: {
      cancelled: options.cancelled === true,
      onCancel: () => () => undefined
    },
    gateway,
    providers: [],
    updateProps: () => undefined,
    updateResult: (value: string | null) => {
      result.push(value ?? '')
    },
    updateMeta: () => undefined,
    emitArtifact: (artifact: Harness['artifacts'][number]) => {
      artifacts.push({ kind: artifact.kind, portId: artifact.portId, mediaId: artifact.mediaId })
    },
    trace: (_phase: string, _level: string, message: string) => {
      traces.push(message)
    }
  } as unknown as NodeExecutionContext
  return { ctx, result, artifacts, traces }
}

function timelineWithClips(): TimelineData {
  const data = createEmptyTimeline()
  // 轨道通用：同一条轨道放画面，另一条放音频，合成时按片段 kind 分流。
  const [videoTrack, audioTrack] = data.tracks
  let next = data
  for (const mediaId of ['vid1', 'vid2']) {
    const added = addClip(next, {
      trackId: videoTrack.id,
      kind: 'video',
      mediaId,
      mediaPath: `projects/p/media/${mediaId}.mp4`,
      name: mediaId,
      sourceDurationMs: 2000
    })
    if (!added.ok) throw new Error(added.reason)
    next = added.data
  }
  const audioAdded = addClip(next, {
    trackId: audioTrack.id,
    kind: 'audio',
    mediaId: 'aud1',
    mediaPath: 'projects/p/media/aud1.m4a',
    name: 'bgm',
    sourceDurationMs: 3000,
    startMs: 0,
    durationMs: 2000
  })
  if (!audioAdded.ok) throw new Error(audioAdded.reason)
  return audioAdded.data
}

describe.skipIf(!hasFfmpeg)('时间线执行器 · 真实合成链路', () => {
  it('两段视频 + 一段音频合成成功，成片经 emitArtifact 落为独立视频资产', async () => {
    const data = timelineWithClips()
    expect(clipsOfTrack(data, data.tracks[0].id)).toHaveLength(2)
    const harness = createHarness(serializeTimeline(data))
    const outcome = await timelineExecutor(harness.ctx)
    expect(outcome).toEqual({ status: 'done' })
    expect(harness.result).toHaveLength(1)
    expect(harness.result[0]).toContain('composed')
    expect(harness.artifacts).toEqual([
      { kind: 'video', portId: 'out-video', mediaId: 'composed' }
    ])
    // 阶段日志只记形状，不记素材路径/文件名（LOGGING_SPEC 脱敏要求）。
    expect(harness.traces.join('\n')).not.toContain(workDir)
    expect(harness.traces.join('\n')).not.toContain('vid1')
  }, 60_000)

  it('空时间线跳过运行，不报失败', async () => {
    const harness = createHarness(serializeTimeline(createEmptyTimeline()))
    await expect(timelineExecutor(harness.ctx)).resolves.toMatchObject({ status: 'skipped' })
    expect(harness.artifacts).toHaveLength(0)
  })

  it('坏 JSON 明确失败，不产出半截资产', async () => {
    const harness = createHarness('{ broken')
    const outcome = await timelineExecutor(harness.ctx)
    expect(outcome.status).toBe('failed')
    expect(harness.artifacts).toHaveLength(0)
  })

  it('缺少 FFmpeg 时是显式失败原因（阻塞态），不进入合成', async () => {
    const harness = createHarness(serializeTimeline(timelineWithClips()), {
      ffmpegAvailable: false
    })
    const outcome = await timelineExecutor(harness.ctx)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('FFmpeg')
    expect(harness.result).toHaveLength(0)
  })

  it('已取消的运行直接跳过', async () => {
    const harness = createHarness(serializeTimeline(timelineWithClips()), { cancelled: true })
    await expect(timelineExecutor(harness.ctx)).resolves.toMatchObject({ status: 'skipped' })
    expect(harness.result).toHaveLength(0)
  })
})
