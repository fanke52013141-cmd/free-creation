// 真实 FFmpeg / FFprobe 验收。
//
// 已有的 test/video-transform.test.ts 全部 mock 掉 window.api，证明的是「执行器把参数拼对、
// 产物记账正确」；主进程那批真正调 FFmpeg 的处理器（transformVideoFrame / transformVideoClip /
// transformVideoAudio / separateVocals / probeVideo / generateVideoThumbnails /
// generateAudioWaveform）此前一次都没有真跑过。参数顺序、-ss 位置、尾帧越界、无音轨源、
// 声道滤镜把目标声像整条抵消这类问题只在真二进制面前才会暴露，所以这里用合成测试素材驱动真实代码。
//
// 只 mock 持久层（media.repo 落盘 + db 查询），FFmpeg 与文件都是真的：产物会被复制进临时
// 数据目录，再用 ffprobe 独立复核时长与响度，避免「ffmpeg 自己产的文件自己说没问题」。
import { copyFile, mkdtemp, readFile, rm, stat } from 'fs/promises'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from '@shared/types'

type Fixture = {
  abs: string
  rel: string
  kind: 'video' | 'audio'
  mime: string
}

const h = vi.hoisted(() => ({
  dataDir: '',
  saved: [] as Array<{ path: string; name: string; ext: string }>,
  /** 媒体 ID → 磁盘上的真文件；beforeAll 灌入，两份 mock 共用。 */
  byId: new Map<string, Fixture>(),
  byRel: new Map<string, string>()
}))

vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (mediaId: string) => {
        const item = h.byId.get(mediaId)
        if (!item) return undefined
        return {
          path: item.rel,
          mime: item.mime,
          kind: item.kind,
          size_bytes: 1
        }
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
// 高质量模式会真的跑本地模型：装了分离器的机器上跳过这条，验收只覆盖缺失路径。
const separator = spawnSync('audio-separator', ['--version'], { encoding: 'utf8' })
const separatorReady = separator.status === 0

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

/** 声道数：快速增强的产物必须是单声道，否则下游播放器与时间轴按 mono 画的就不对。 */
function channelCount(file: string): string {
  const res = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=channels',
      '-of',
      'csv=p=0',
      file
    ],
    { encoding: 'utf8' }
  )
  expect(res.status, res.stderr).toBe(0)
  return res.stdout.trim()
}

function runFfmpegOrThrow(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8'
  })
  expect(res.status, res.stderr).toBe(0)
}

/** 平均响度（dBFS）：判断产物到底是"有人声"还是"一条静音"。 */
function meanVolumeDb(file: string): number {
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    {
      encoding: 'utf8'
    }
  )
  const matched = /mean_volume:\s*(-?[\d.]+) dB/.exec(res.stderr)
  expect(matched, `读不到 ${file} 的响度：${res.stderr}`).not.toBeNull()
  return Number(matched?.[1])
}

async function bytes(file: string): Promise<Buffer> {
  return readFile(file)
}

beforeAll(async () => {
  h.dataDir = await mkdtemp(join(tmpdir(), 'canvas-studio-real-media-'))
  const files = {
    'source-video': { file: 'source.mp4', kind: 'video' as const, mime: 'video/mp4' },
    'silent-video': { file: 'silent.mp4', kind: 'video' as const, mime: 'video/mp4' },
    'center-audio': { file: 'center.wav', kind: 'audio' as const, mime: 'audio/wav' },
    'side-audio': { file: 'side.wav', kind: 'audio' as const, mime: 'audio/wav' },
    'silent-audio': { file: 'silent.wav', kind: 'audio' as const, mime: 'audio/wav' }
  }
  for (const [id, item] of Object.entries(files)) {
    const abs = join(h.dataDir, item.file)
    h.byId.set(id, { abs, rel: `projects/p1/media/${item.file}`, kind: item.kind, mime: item.mime })
    h.byRel.set(`projects/p1/media/${item.file}`, abs)
  }
  if (!toolsReady) return
  const sourceAbs = h.byId.get('source-video')?.abs as string
  const silentAbs = h.byId.get('silent-video')?.abs as string
  const centerAbs = h.byId.get('center-audio')?.abs as string
  const sideAbs = h.byId.get('side-audio')?.abs as string
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
    sourceAbs
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
    silentAbs
  ])
  // 人声分离要按声像分真伪两种素材，并且都要推到满刻度：
  //   center = 同相双单声道（单声道录音上混立体声的日常形态，也是居中的人声）；
  //   side   = 右声道反相，只有左右差值、没有同相内容（分布在两侧的伴奏）。
  // 频率取 1kHz：它落在人声带通之内，同时高于旧版按采样数反推的解码率能保住的上限，
  // 波形一旦被错误降采样就会整条抹平。lavfi 的 sine 默认只有 −21dBFS，用 volume=10 补齐。
  runFfmpegOrThrow([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:duration=1',
    '-af',
    'volume=10',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    centerAbs
  ])
  runFfmpegOrThrow([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:duration=1',
    '-filter_complex',
    '[0:a]volume=10,asplit=2[a][b];[b]volume=-1[inv];[a][inv]amerge=inputs=2',
    '-c:a',
    'pcm_s16le',
    sideAbs
  ])
  runFfmpegOrThrow([
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=mono',
    '-t',
    '1',
    '-c:a',
    'pcm_s16le',
    h.byId.get('silent-audio')?.abs as string
  ])
  expect((await stat(sourceAbs)).size).toBeGreaterThan(0)
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

  // 快速模式此前只有 mock 测试（证明参数拼装），滤镜链本身从没在真 FFmpeg 面前跑过。
  // 一跑就发现方向是反的：0.5L-0.5R 抵消的是同相内容，也就是节点承诺要保留的居中人声。
  it('人声分离（快速增强）：居中人声留在产物里，纯左右反相内容被抵消', async () => {
    const { separateVocals } = await import('../src/main/media/video-transform')
    const loudness: number[] = []
    for (const mediaId of ['center-audio', 'side-audio'] as const) {
      const before = h.saved.length
      const result = await separateVocals({
        projectId: 'p1',
        sourceMediaId: mediaId,
        config: { version: 1, mode: 'fast', outputAccompaniment: false } as never
      })
      // 快速模式不承诺伴奏，把原音频副本伪装成伴奏轨同样是不诚实的输出。
      expect(result.accompaniment).toBeUndefined()
      const produced = h.saved[before]
      expect(produced.name).toBe('人声增强')
      expect(streamFields(produced.path)).toContain('pcm_s16le')
      expect(channelCount(produced.path)).toBe('1')
      loudness.push(meanVolumeDb(produced.path))
    }
    const [center, side] = loudness
    expect(center, `居中人声被滤镜抵消，产物只剩 ${center} dBFS`).toBeGreaterThan(-60)
    expect(side, `纯反相内容没被削弱（${side} dBFS），滤镜方向仍是反的`).toBeLessThan(-60)
  })

  it.skipIf(separatorReady)('人声分离（高质量）未安装分离器时给出可操作报错', async () => {
    const { separateVocals } = await import('../src/main/media/video-transform')
    const error = await separateVocals({
      projectId: 'p1',
      sourceMediaId: 'center-audio',
      config: { version: 1, mode: 'quality', outputAccompaniment: false } as never
    }).catch((e: unknown) => e)
    expect(String(error)).toContain('audio-separator')
  })

  it('时间轴缩略图：按请求数量给图，每张都是可解码的 120 宽 JPEG', async () => {
    const { generateVideoThumbnails } = await import('../src/main/media/video-transform')
    const { thumbnails } = await generateVideoThumbnails({
      projectId: 'p1',
      sourceMediaId: 'source-video',
      count: 4
    })
    expect(thumbnails).toHaveLength(4)
    for (const dataUrl of thumbnails) {
      expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
      const buf = Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')
      expect(buf[0]).toBe(0xff)
      expect(buf[1]).toBe(0xd8)
      expect(buf.length, '缩略图小得不像一张真实图片').toBeGreaterThan(500)
    }
  })

  it('时间轴缩略图：数量越界被夹到 1–12，不会向 FFmpeg 要 0 张或几百张', async () => {
    const { generateVideoThumbnails } = await import('../src/main/media/video-transform')
    for (const [count, expected] of [
      [0, 1],
      [-5, 1],
      [99, 12]
    ] as const) {
      const { thumbnails } = await generateVideoThumbnails({
        projectId: 'p1',
        sourceMediaId: 'source-video',
        count
      })
      expect(thumbnails, `count=${count}`).toHaveLength(expected)
    }
  })

  it('音频波形：峰值数量等于请求采样数，有声素材不会算成全零', async () => {
    const { generateAudioWaveform } = await import('../src/main/media/video-transform')
    // 300 是提音/视频截取卡片实际请求的桶数；满刻度 1kHz 素材必须仍然画得出来。
    for (const samples of [64, 300] as const) {
      const { peaks, sampleRate } = await generateAudioWaveform({
        projectId: 'p1',
        sourceMediaId: 'center-audio',
        samples
      })
      expect(peaks).toHaveLength(samples)
      // 解码率固定 8kHz：分桶在 JS 里做，降低采样率只会把内容滤没，省不了多少时间。
      expect(sampleRate).toBe(8000)
      expect(Math.max(...peaks)).toBeLessThanOrEqual(1)
      expect(
        Math.max(...peaks),
        `${samples} 桶把满刻度 1kHz 素材算成峰值 ${Math.max(...peaks)}，时间轴会画成一条平线`
      ).toBeGreaterThan(0.5)
      expect(peaks.every((peak) => Number.isFinite(peak))).toBe(true)
    }
  })

  it('音频波形：采样数越界被夹到 50–500，不会向主进程要几千个桶', async () => {
    const { generateAudioWaveform } = await import('../src/main/media/video-transform')
    for (const [samples, expected] of [
      [0, 50],
      [-10, 50],
      [9000, 500]
    ] as const) {
      const { peaks } = await generateAudioWaveform({
        projectId: 'p1',
        sourceMediaId: 'center-audio',
        samples
      })
      expect(peaks, `samples=${samples}`).toHaveLength(expected)
    }
  })

  it('音频波形：静音素材给全零峰值，不产生 NaN 或异常', async () => {
    const { generateAudioWaveform } = await import('../src/main/media/video-transform')
    const { peaks } = await generateAudioWaveform({
      projectId: 'p1',
      sourceMediaId: 'silent-audio',
      samples: 80
    })
    expect(peaks).toHaveLength(80)
    expect(peaks.every((peak) => peak === 0)).toBe(true)
  })

  it('音频波形：源音频不存在时在执行前报错', async () => {
    const { generateAudioWaveform } = await import('../src/main/media/video-transform')
    await expect(
      generateAudioWaveform({ projectId: 'p1', sourceMediaId: 'missing-audio', samples: 100 })
    ).rejects.toThrow('输入音频不存在，或不属于当前项目')
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
