// 真实 FFprobe 探测验收（时间线节点 M3）。
//
// probeMedia 是时间线取「每段素材多长、画面多大」的唯一入口：参数拼错、字段口径错
// 都会让时间线片段排错长度，所以这里用 ffmpeg 现场合成素材驱动真实 FFprobe，而不是
// mock 一段写死的 JSON。素材覆盖：带音轨视频、无声视频、纯音频、单帧 PNG、只有字幕流
// 的容器（unknown）、不可解码文件，以及「本机没装 FFprobe」的 ENOENT 路径。
//
// 同时用 node:sqlite 建真实 media 表验证 updateMediaMetadata：列名照建表 SQL 走真库，
// 避免用假 prepare 只断言 SQL 字符串却漏掉真实列名。
//
// 本机没有 ffmpeg/ffprobe 时整组跳过（先探测再 describe.skipIf），不让 CI 变红。
import { spawnSync } from 'child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FFPROBE_MISSING_HINT } from '../src/main/media/ffmpeg-runner'
import { probeMedia } from '../src/main/media/media-probe'
import { migrateDatabase } from '../src/main/store/db-migrations'

const h = vi.hoisted(() => ({ dataDir: '', database: null as unknown }))

vi.mock('../src/main/store/db', () => ({
  getDataDir: () => h.dataDir,
  getDb: () => {
    const database = h.database as DatabaseSync
    return { prepare: (sql: string) => database.prepare(sql) }
  }
}))

import { updateMediaMetadata } from '../src/main/store/media.repo'

const ffmpegReady = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0
const ffprobeReady = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0
const toolsReady = ffmpegReady && ffprobeReady

let dir = ''
const files = {
  clip: '',
  silentClip: '',
  spacedClip: '',
  tone: '',
  still: '',
  subtitle: '',
  broken: ''
}

function runFfmpegOrThrow(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8'
  })
  expect(res.status, res.stderr).toBe(0)
}

// ── 媒体表回填（不依赖 FFmpeg） ──

describe('媒体元数据回填 updateMediaMetadata', () => {
  let database: DatabaseSync

  beforeAll(() => {
    h.dataDir = tmpdir()
    database = new DatabaseSync(':memory:')
    h.database = database
    migrateDatabase({
      exec: (sql) => database.exec(sql),
      pragma: (statement, options) =>
        options?.simple
          ? Number(
              (database.prepare(`PRAGMA ${statement}`).get() as { user_version: number }).user_version
            )
          : database.exec(`PRAGMA ${statement}`)
    })
    database
      .prepare(
        'INSERT INTO media (id, kind, mime, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('media-1', 'video', 'video/mp4', 'projects/p1/media/media-1.mp4', 1024, 1)
  })

  afterAll(() => {
    database.close()
  })

  function mediaRow(): { width: number | null; height: number | null; duration_sec: number | null } {
    const row = database
      .prepare('SELECT width, height, duration_sec FROM media WHERE id = ?')
      .get('media-1') as {
      width: number | null
      height: number | null
      duration_sec: number | null
    }
    return { width: row.width, height: row.height, duration_sec: row.duration_sec }
  }

  it('按 media 表真实列名写入宽高与时长', () => {
    updateMediaMetadata('media-1', { width: 320, height: 240, durationSec: 3.033 })
    expect(mediaRow()).toEqual({ width: 320, height: 240, duration_sec: 3.033 })
  })

  it('只更新非 null 字段，不擦掉之前探测到的值', () => {
    updateMediaMetadata('media-1', { width: 640, height: null, durationSec: undefined })
    expect(mediaRow()).toEqual({ width: 640, height: 240, duration_sec: 3.033 })
  })

  it('没有有效字段或 id 不存在时不发空 UPDATE、不抛错', () => {
    expect(() => updateMediaMetadata('media-1', {})).not.toThrow()
    expect(() => updateMediaMetadata('media-1', { width: null, durationSec: null })).not.toThrow()
    expect(() => updateMediaMetadata('missing-id', { width: 100 })).not.toThrow()
    expect(mediaRow()).toEqual({ width: 640, height: 240, duration_sec: 3.033 })
  })

  it('非正数/NaN 视为没探测到，不写入假数据', () => {
    updateMediaMetadata('media-1', { width: 0, height: -1, durationSec: Number.NaN })
    expect(mediaRow()).toEqual({ width: 640, height: 240, duration_sec: 3.033 })
  })
})

// ── 入参守卫（不需要 FFprobe） ──

describe('probeMedia 入参守卫', () => {
  it('相对路径直接失败且不设置 missingTool', async () => {
    const result = await probeMedia('projects/p1/media/clip.mp4')
    expect(result).toEqual({
      ok: false,
      missingTool: false,
      reason: '媒体文件路径必须是绝对路径'
    })
  })
})

// ── 真实 FFprobe ──

describe.skipIf(!toolsReady)('真实 FFprobe 媒体探测', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'canvas-studio-media-probe-'))
    files.clip = join(dir, 'clip.mp4')
    files.silentClip = join(dir, 'silent.mp4')
    files.tone = join(dir, 'tone.wav')
    files.still = join(dir, 'still.png')
    files.subtitle = join(dir, 'notes.srt')
    files.broken = join(dir, 'broken.bin')

    // 3 秒 320×240@25 视频 + 同长 440Hz 音轨：时间线片段的典型形态。
    runFfmpegOrThrow([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=25:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      files.clip
    ])
    // 1 秒 320×240@10 无声视频：验证 hasAudio=false，且 fps 不是写死的 25。
    runFfmpegOrThrow([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=10:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      files.silentClip
    ])
    // 2 秒单声道 44.1kHz 音频：验证 sampleRate/channels 与「没有画面尺寸」。
    runFfmpegOrThrow([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'pcm_s16le',
      files.tone
    ])
    // 单帧 PNG：图片没有 duration，不能伪造时长。
    runFfmpegOrThrow([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=128x96:d=1',
      '-frames:v',
      '1',
      files.still
    ])
    // 只有字幕流：既没有 video 也没有 audio，应判为 unknown。
    await writeFile(files.subtitle, '1\n00:00:01,000 --> 00:00:02,000\nhello\n', 'utf8')
    await writeFile(files.broken, Buffer.from('this is not a media file'))
    // 带空格的目录：绝对路径作为单个 argv 传给 spawn，验证不会被拆开。
    const spacedDir = join(dir, 'with space')
    await mkdir(spacedDir, { recursive: true })
    files.spacedClip = join(spacedDir, 'clip.mp4')
    await copyFile(files.clip, files.spacedClip)
  })

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('视频：读到 3 秒时长、320×240、25fps 与音轨', async () => {
    const result = await probeMedia(files.clip)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const meta = result.meta
    expect(meta.kind).toBe('video')
    expect(meta.durationMs).toBeGreaterThan(2850)
    expect(meta.durationMs).toBeLessThan(3150)
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(240)
    expect(meta.fps).toBeCloseTo(25, 5)
    expect(meta.hasAudio).toBe(true)
    expect(meta.sampleRate).toBe(44100)
    expect(meta.channels).toBe(1)
  })

  it('无声视频：hasAudio=false，fps 由 avg_frame_rate 换算而不是默认值', async () => {
    const result = await probeMedia(files.silentClip)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('video')
    expect(result.meta.hasAudio).toBe(false)
    expect(result.meta.fps).toBeCloseTo(10, 5)
    expect(result.meta.width).toBe(320)
    expect(result.meta.height).toBe(240)
    expect(result.meta.sampleRate).toBeNull()
    expect(result.meta.channels).toBeNull()
  })

  it('音频：读到 2 秒时长/采样率/声道，且没有画面尺寸与帧率', async () => {
    const result = await probeMedia(files.tone)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const meta = result.meta
    expect(meta.kind).toBe('audio')
    expect(meta.durationMs).toBeGreaterThan(1850)
    expect(meta.durationMs).toBeLessThan(2150)
    expect(meta.width).toBeNull()
    expect(meta.height).toBeNull()
    expect(meta.fps).toBeNull()
    expect(meta.hasAudio).toBe(true)
    expect(meta.sampleRate).toBe(44100)
    expect(meta.channels).toBe(1)
  })

  it('单帧 PNG：kind=image、尺寸正确、durationMs 为 null（不伪造）', async () => {
    const result = await probeMedia(files.still)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const meta = result.meta
    expect(meta.kind).toBe('image')
    expect(meta.width).toBe(128)
    expect(meta.height).toBe(96)
    expect(meta.durationMs).toBeNull()
    expect(meta.fps).toBeNull()
    expect(meta.hasAudio).toBe(false)
  })

  it('只有字幕流：判为 unknown，字段全空', async () => {
    const result = await probeMedia(files.subtitle)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('unknown')
    expect(result.meta.width).toBeNull()
    expect(result.meta.height).toBeNull()
    expect(result.meta.durationMs).toBeNull()
    expect(result.meta.hasAudio).toBe(false)
  })

  it('不可解码文件：ok=false 且 missingTool=false（是文件问题，不是没装工具）', async () => {
    const result = await probeMedia(files.broken)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missingTool).toBe(false)
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('路径带空格也能探测（绝对路径作为单个参数传给 spawn）', async () => {
    const result = await probeMedia(files.spacedClip)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('video')
    expect(result.meta.width).toBe(320)
  })

  it('本机没有 FFprobe：missingTool=true 且沿用统一提示', async () => {
    const previous = process.env.CANVAS_STUDIO_FFMPEG_PATH
    process.env.CANVAS_STUDIO_FFMPEG_PATH = join(dir, 'not-installed-ffmpeg.exe')
    try {
      const result = await probeMedia(files.clip)
      expect(result).toEqual({ ok: false, missingTool: true, reason: FFPROBE_MISSING_HINT })
    } finally {
      if (previous === undefined) delete process.env.CANVAS_STUDIO_FFMPEG_PATH
      else process.env.CANVAS_STUDIO_FFMPEG_PATH = previous
    }
  })
})
