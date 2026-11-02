// 真实 FFmpeg 验收：多素材时间线合成（M4）。
//
// 合成代码的参数错误（concat 流参数不一致、-ss 位置、音频错位、时长累计偏差）只有在真二进制
// 面前才会暴露，所以这里不 mock：素材全部用 lavfi 现场生成，产物时长/流结构由 ffprobe 独立复核。
// 本机缺少 FFmpeg 时整组跳过（PATH 或 CANVAS_STUDIO_FFMPEG_PATH 任一可用即可）。
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { composeTimeline } from '../src/main/media/timeline-compose'

const toolsReady =
  spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0

let root = ''
/** 2 秒 320×240 @30fps，带 440Hz 音轨。 */
let videoWithAudio = ''
/** 2 秒 320×240 @30fps，无音轨（验证 anullsrc 静音补齐）。 */
let videoSilent = ''
/** 单帧 PNG（图片片段）。 */
let stillImage = ''
/** 4 秒 880Hz 音频（音频轨素材）。 */
let toneAudio = ''

function runFfmpegFixture(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8'
  })
  expect(res.status, res.stderr).toBe(0)
}

function probeDurationMs(file: string): number {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' }
  )
  expect(res.status, res.stderr).toBe(0)
  return Math.round(Number(res.stdout.trim()) * 1000)
}

function probeStreams(file: string): {
  width: number
  height: number
  hasAudio: boolean
} {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', file],
    { encoding: 'utf8' }
  )
  expect(res.status, res.stderr).toBe(0)
  const parsed = JSON.parse(res.stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
  return {
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === 'audio'))
  }
}

beforeAll(async () => {
  if (!toolsReady) return
  root = await mkdtemp(join(tmpdir(), 'canvas-studio-timeline-test-'))
  videoWithAudio = join(root, 'clip-audio.mp4')
  videoSilent = join(root, 'clip-silent.mp4')
  stillImage = join(root, 'still.png')
  toneAudio = join(root, 'tone.wav')

  runFfmpegFixture([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    videoWithAudio
  ])
  runFfmpegFixture([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:size=320x240:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    videoSilent
  ])
  runFfmpegFixture([
    '-f',
    'lavfi',
    '-i',
    'color=c=green:size=320x240',
    '-frames:v',
    '1',
    stillImage
  ])
  runFfmpegFixture([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=4',
    '-c:a',
    'pcm_s16le',
    toneAudio
  ])

  for (const file of [videoWithAudio, videoSilent, stillImage, toneAudio]) {
    expect((await stat(file)).size).toBeGreaterThan(0)
  }
}, 60_000)

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

describe.skipIf(!toolsReady)('composeTimeline 真实 FFmpeg 合成', () => {
  it(
    '两段视频首尾相接，并混入一条音频轨',
    async () => {
      const outputPath = join(root, 'join.mp4')
      const stages = new Set<string>()
      const result = await composeTimeline({
        outputPath,
        width: 320,
        height: 240,
        frameRate: 30,
        clips: [
          {
            kind: 'video',
            sourcePath: videoWithAudio,
            startMs: 0,
            durationMs: 2000,
            inMs: 0,
            sourceDurationMs: 2000
          },
          {
            kind: 'video',
            sourcePath: videoSilent,
            startMs: 2000,
            durationMs: 2000,
            inMs: 0,
            sourceDurationMs: 2000
          }
        ],
        audioClips: [
          {
            kind: 'audio',
            sourcePath: toneAudio,
            startMs: 0,
            durationMs: 2000,
            inMs: 0,
            sourceDurationMs: 4000,
            volume: 0.5
          }
        ],
        onProgress: (progress) => stages.add(progress.stage)
      })
      expect(result.ok, result.ok ? '' : result.reason).toBe(true)
      if (!result.ok) return

      const info = await stat(outputPath)
      expect(info.isFile()).toBe(true)
      expect(info.size).toBeGreaterThan(0)

      const duration = probeDurationMs(outputPath)
      expect(Math.abs(duration - 4000)).toBeLessThanOrEqual(400)
      expect(Math.abs(result.durationMs - duration)).toBeLessThanOrEqual(64)

      const streams = probeStreams(outputPath)
      expect(streams.hasAudio).toBe(true)
      expect(streams.width).toBe(320)
      expect(streams.height).toBe(240)
      expect(stages.has('prepare')).toBe(true)
      expect(stages.has('mux')).toBe(true)
    },
    120_000
  )

  it(
    '图片片段插在两段视频中间时总时长正确',
    async () => {
      const outputPath = join(root, 'with-image.mp4')
      const result = await composeTimeline({
        outputPath,
        width: 320,
        height: 240,
        frameRate: 30,
        clips: [
          {
            kind: 'video',
            sourcePath: videoWithAudio,
            startMs: 0,
            durationMs: 2000,
            inMs: 0,
            sourceDurationMs: 2000
          },
          {
            kind: 'image',
            sourcePath: stillImage,
            startMs: 2000,
            durationMs: 1500
          },
          {
            kind: 'video',
            sourcePath: videoSilent,
            startMs: 3500,
            durationMs: 2000,
            inMs: 0,
            sourceDurationMs: 2000
          }
        ]
      })
      expect(result.ok, result.ok ? '' : result.reason).toBe(true)
      if (!result.ok) return

      const duration = probeDurationMs(outputPath)
      expect(Math.abs(duration - 5500)).toBeLessThanOrEqual(400)
      expect(Math.abs(result.durationMs - duration)).toBeLessThanOrEqual(64)
      expect(probeStreams(outputPath).hasAudio).toBe(true)
    },
    120_000
  )

  it(
    'inMs + durationMs 超过源时长时截断且不报错',
    async () => {
      const outputPath = join(root, 'truncated.mp4')
      const result = await composeTimeline({
        outputPath,
        width: 320,
        height: 240,
        frameRate: 30,
        clips: [
          {
            kind: 'video',
            sourcePath: videoWithAudio,
            // 源只有 2 秒：从 1 秒起声明 5 秒，按源尾截断成 1 秒。
            startMs: 0,
            durationMs: 5000,
            inMs: 1000,
            sourceDurationMs: 2000
          },
          {
            kind: 'video',
            sourcePath: videoSilent,
            startMs: 1000,
            durationMs: 2000,
            inMs: 0,
            sourceDurationMs: 2000
          }
        ]
      })
      expect(result.ok, result.ok ? '' : result.reason).toBe(true)
      if (!result.ok) return

      const duration = probeDurationMs(outputPath)
      expect(Math.abs(duration - 3000)).toBeLessThanOrEqual(400)
      expect(duration).toBeLessThan(4000)
    },
    120_000
  )

  it(
    '时间线空档用黑帧补齐，startMs 真实生效',
    async () => {
      const outputPath = join(root, 'gap.mp4')
      const result = await composeTimeline({
        outputPath,
        width: 320,
        height: 240,
        frameRate: 30,
        clips: [
          {
            kind: 'video',
            sourcePath: videoWithAudio,
            startMs: 1000,
            durationMs: 2000,
            inMs: 0,
            sourceDurationMs: 2000
          }
        ]
      })
      expect(result.ok, result.ok ? '' : result.reason).toBe(true)
      if (!result.ok) return

      const duration = probeDurationMs(outputPath)
      expect(Math.abs(duration - 3000)).toBeLessThanOrEqual(400)
    },
    120_000
  )

  it(
    '本机缺少 FFmpeg 时返回 missingTool，而不是向调用方抛错',
    async () => {
      const missingBinary = join(root, 'no-such-ffmpeg.exe')
      vi.stubEnv('CANVAS_STUDIO_FFMPEG_PATH', missingBinary)
      try {
        const result = await composeTimeline({
          outputPath: join(root, 'missing.mp4'),
          width: 320,
          height: 240,
          frameRate: 30,
          clips: [
            {
              kind: 'video',
              sourcePath: videoWithAudio,
              startMs: 0,
              durationMs: 1000,
              inMs: 0,
              sourceDurationMs: 2000
            }
          ]
        })
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.missingTool).toBe(true)
        expect(result.reason).toContain('FFmpeg')
      } finally {
        vi.unstubAllEnvs()
      }
    },
    60_000
  )
})
