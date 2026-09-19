// 真实 FFmpeg / FFprobe 验收。
//
// 已有的 test/video-transform.test.ts 全部 mock 掉 window.api，证明的是「执行器把参数拼对、
// 产物记账正确」；主进程那批真正调 FFmpeg 的处理器（transformVideoFrame / transformVideoClip /
// transformVideoAudio / probeVideo）此前一次都没有真跑过。参数顺序、-ss 位置、尾帧越界、
// 无音轨源这类问题只在真二进制面前才会暴露，所以这里用合成测试片驱动真实代码。
//
// 只 mock 持久层（media.repo 落盘 + db 查询），FFmpeg 与文件都是真的：产物会被复制进临时
// 数据目录，再用 ffprobe 独立复核时长，避免「ffmpeg 自己产的文件自己说没问题」。
import { copyFile, mkdtemp, readFile, rm, stat } from 'fs/promises'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from '@shared/types'

const h = vi.hoisted(() => ({
  dataDir: '',
  sourceAbs: '',
  silentAbs: '',
  saved: [] as Array<{ path: string; name: string; ext: string }>
}))

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (mediaId: string) => {
        if (mediaId === 'source-video')
          return h.sourceAbs
            ? {
                path: 'projects/p1/media/source.mp4',
                mime: 'video/mp4',
                kind: 'video',
                size_bytes: 1
              }
            : undefined
        if (mediaId === 'silent-video')
          return {
            path: 'projects/p1/media/silent.mp4',
            mime: 'video/mp4',
            kind: 'video',
            size_bytes: 1
          }
        return undefined
      }
    })
  })
}))

vi.mock('../src/main/store/media.repo', () => ({
  getMediaAbsPath: (relPath: string) =>
    relPath.endsWith('silent.mp4') ? h.silentAbs : h.sourceAbs,
  saveFileAsset: async (_projectId: string, srcAbs: string, ext: string, name: string) => {
    const dest = join(h.dataDir, `${h.saved.length}${ext}`)
    await copyFile(srcAbs, dest)
    h.saved.push({ path: dest, name, ext })
    return {
      id: `asset-${h.saved.length}`,
      path: `projects/p1/media/asset${ext}`,
      name
    } as MediaAsset
  },
  deleteMedia: () => undefined
}))

const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
const ffprobe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' })
const toolsReady = ffmpeg.status === 0 && ffprobe.status === 0

/** 产物时长：由 ffprobe 独立读取，不复用被测代码的解析结果。 */
function durationMs(file: string): number {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' }
  )
  expect(res.status, res.stderr).toBe(0)
  return Math.round(Number(res.stdout.trim()) * 1000)
}

function streamFields(file: string): string {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  )
  expect(res.status, res.stderr).toBe(0)
  return res.stdout
}

function runFfmpegOrThrow(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8'
  })
  expect(res.status, res.stderr).toBe(0)
}

async function bytes(file: string): Promise<Buffer> {
  return readFile(file)
}

beforeAll(async () => {
  h.dataDir = await mkdtemp(join(tmpdir(), 'canvas-studio-real-media-'))
  h.sourceAbs = join(h.dataDir, 'source.mp4')
  h.silentAbs = join(h.dataDir, 'silent.mp4')
  if (!toolsReady) return
  // 2 秒 320×240、10fps、带 440Hz 音轨；另一份完全静音，用来复现「无声视频提音」。
  runFfmpegOrThrow([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=10:duration=2',
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
    h.sourceAbs
  ])
  runFfmpegOrThrow([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=10:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    h.silentAbs
  ])
  expect((await stat(h.sourceAbs)).size).toBeGreaterThan(0)
})

afterAll(async () => {
  await rm(h.dataDir, { recursive: true, force: true }).catch(() => undefined)
})

describe.skipIf(!toolsReady)('真实 FFmpeg 媒体处理器', () => {
  it('probeVideo 读出真实时长、帧率与音轨存在性', async () => {
    const { probeVideo } = await import('../src/main/media/video-transform')
    const meta = await probeVideo({ projectId: 'p1', sourceMediaId: 'source-video' })
    expect(meta.durationMs).toBeGreaterThan(1500)
    expect(meta.durationMs).toBeLessThan(2600)
    expect(meta.hasAudio).toBe(true)
    expect(meta.fps).toBeCloseTo(10, 0)
  })

  it('取帧：首帧、自定义时间与尾帧都产出可读图片，尾帧不越界成空文件', async () => {
    const { transformVideoFrame } = await import('../src/main/media/video-transform')
    for (const config of [
      { version: 2, mode: 'first', timeMs: 0, format: 'png' },
      { version: 2, mode: 'custom', timeMs: 1200, format: 'jpg' },
      { version: 2, mode: 'last', timeMs: 0, format: 'png' }
    ] as const) {
      const before = h.saved.length
      await transformVideoFrame({
        projectId: 'p1',
        sourceMediaId: 'source-video',
        config: config as never
      })
      const produced = h.saved[before]
      const head = (await bytes(produced.path)).subarray(0, 8)
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e
      const isJpg = head[0] === 0xff && head[1] === 0xd8
      expect(
        isPng || isJpg,
        `${config.mode} 模式产物既不是 PNG 也不是 JPEG：${head.toString('hex')}`
      ).toBe(true)
    }
  })

  it('截取（精确重编码）：产物时长就是用户选的区间', async () => {
    const { transformVideoClip } = await import('../src/main/media/video-transform')
    const before = h.saved.length
    await transformVideoClip({
      projectId: 'p1',
      sourceMediaId: 'source-video',
      config: {
        version: 3,
        startMs: 500,
        endMs: 1500,
        keepVideo: true,
        keepAudio: true,
        includeAudio: true,
        quality: 'balanced',
        audioFormat: 'wav',
        audioSampleRate: 44100
      } as never
    })
    const clip = h.saved[before]
    const ms = durationMs(clip.path)
    expect(ms, `截 500–1500ms 实得 ${ms}ms`).toBeGreaterThanOrEqual(900)
    expect(ms, `截 500–1500ms 实得 ${ms}ms`).toBeLessThanOrEqual(1600)
    expect(streamFields(clip.path)).toContain('aac')
  })

  it('截取（快速流复制）：关键帧对齐，产物仍是可解码的完整视频', async () => {
    const { transformVideoClip } = await import('../src/main/media/video-transform')
    const before = h.saved.length
    await transformVideoClip({
      projectId: 'p1',
      sourceMediaId: 'source-video',
      config: {
        version: 3,
        startMs: 500,
        endMs: 1500,
        keepVideo: true,
        keepAudio: false,
        includeAudio: true,
        quality: 'fast',
        audioFormat: 'wav',
        audioSampleRate: 44100
      } as never
    })
    const ms = durationMs(h.saved[before].path)
    // 快速模式按关键帧对齐，边界不精确是它的设计取舍：宁可多给一点也不少给。
    expect(ms).toBeGreaterThanOrEqual(900)
    expect(ms).toBeLessThanOrEqual(2600)
  })

  it('提音：WAV 采样率与区间时长都落到产物里', async () => {
    const { transformVideoAudio } = await import('../src/main/media/video-transform')
    const before = h.saved.length
    await transformVideoAudio({
      projectId: 'p1',
      sourceMediaId: 'source-video',
      config: { version: 2, startMs: 500, endMs: 1500, format: 'wav', sampleRate: 48000 } as never
    })
    const audio = h.saved[before]
    expect((await bytes(audio.path)).subarray(0, 4).toString()).toBe('RIFF')
    expect(streamFields(audio.path)).toContain('48000')
    const ms = durationMs(audio.path)
    expect(ms, `取 500–1500ms 音频实得 ${ms}ms`).toBeGreaterThanOrEqual(900)
    expect(ms).toBeLessThanOrEqual(1600)
  })

  // 用户在时间轴上把一段无声视频连到提音节点，是日常操作而不是极端输入。
  it('无声视频提音：失败信息说明没有音轨，而不是 FFmpeg 原始报错加临时路径', async () => {
    const { transformVideoAudio } = await import('../src/main/media/video-transform')
    const error = await transformVideoAudio({
      projectId: 'p1',
      sourceMediaId: 'silent-video',
      config: { version: 2, startMs: 0, endMs: 1000, format: 'wav', sampleRate: 44100 } as never
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const message = String(error)
    expect(message).toContain('没有音轨')
    // 修复前这里是 FFmpeg 的英文报错原文，还带出系统临时目录的绝对路径。
    expect(message).not.toMatch(/Invalid argument|Temp|canvas-studio-video-/)
  })

  it('源视频不存在时在执行前就报错，不去调用 FFmpeg', async () => {
    const { transformVideoFrame } = await import('../src/main/media/video-transform')
    await expect(
      transformVideoFrame({
        projectId: 'p1',
        sourceMediaId: 'missing-video',
        config: { version: 2, mode: 'first', timeMs: 0, format: 'png' } as never
      })
    ).rejects.toThrow('输入视频不存在，或不属于当前项目')
  })
})

describe.skipIf(toolsReady)('本机缺少 FFmpeg/FFprobe 时跳过真实媒体验收', () => {
  it('给出可操作的缺失提示', async () => {
    const { getLocalMediaCapabilities } = await import('../src/main/media/video-transform')
    const caps = await getLocalMediaCapabilities()
    expect(caps.ffmpeg.available).toBe(false)
    expect(caps.ffmpeg.message).toContain('CANVAS_STUDIO_FFMPEG_PATH')
  })
})
