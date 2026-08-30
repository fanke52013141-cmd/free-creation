import { spawn } from 'child_process'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDb } from '../store/db'
import { getMediaAbsPath, saveFileAsset } from '../store/media.repo'
import type { VideoFrameTransformInput, VideoRangeTransformInput } from '../../shared/contracts'
import {
  parseVideoFrameConfig,
  parseVideoRangeConfig,
  type VocalIsolationMode
} from '../../shared/video-transform'
import type { MediaAsset } from '../../shared/types'

interface VideoSource {
  path: string
}

/**
 * M0 视频变换适配器。只调用用户本机已安装/显式配置的 FFmpeg，不随应用打包 GPL 二进制。
 * 配置路径优先级：CANVAS_STUDIO_FFMPEG_PATH > 系统 PATH 中的 ffmpeg。
 */
export async function transformVideoFrame(input: VideoFrameTransformInput): Promise<MediaAsset> {
  const source = await resolveVideoSource(input.projectId, input.sourceMediaId)
  const config = parseVideoFrameConfig(JSON.stringify(input.config))
  return runToAsset(input.projectId, 'frame.png', '.png', '视频帧', [
    '-ss',
    seconds(config.timeMs),
    '-i',
    source.path,
    '-frames:v',
    '1',
    '-an'
  ])
}

export async function transformVideoClip(input: VideoRangeTransformInput): Promise<MediaAsset> {
  const source = await resolveVideoSource(input.projectId, input.sourceMediaId)
  const config = parseVideoRangeConfig(JSON.stringify(input.config))
  return runToAsset(input.projectId, 'clip.mp4', '.mp4', '视频片段', [
    '-i',
    source.path,
    '-ss',
    seconds(config.startMs),
    '-t',
    seconds(config.endMs - config.startMs),
    '-map',
    '0:v:0?',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'medium',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart'
  ])
}

export async function transformVideoAudio(input: VideoRangeTransformInput): Promise<MediaAsset> {
  const source = await resolveVideoSource(input.projectId, input.sourceMediaId)
  const config = parseVideoRangeConfig(JSON.stringify(input.config))
  const removeBg = config.removeBackground === true

  if (!removeBg) {
    return runToAsset(input.projectId, 'audio.m4a', '.m4a', '提取音频', [
      '-i',
      source.path,
      '-ss',
      seconds(config.startMs),
      '-t',
      seconds(config.endMs - config.startMs),
      '-vn',
      '-map',
      '0:a:0?',
      '-c:a',
      'aac',
      '-b:a',
      '192k'
    ])
  }

  // ── 人声隔离（去除背景音）──
  const mode: VocalIsolationMode = config.isolationMode ?? 'auto'
  const resolved = mode === 'auto' ? (await probeStereo(source.path) ? 'center' : 'eq') : mode
  const filter = resolved === 'center' ? buildCenterExtractionFilter() : buildEqOnlyFilter()

  return runToAsset(input.projectId, 'audio_vocal.m4a', '.m4a', '提取音频（人声）', [
    '-i',
    source.path,
    '-ss',
    seconds(config.startMs),
    '-t',
    seconds(config.endMs - config.startMs),
    '-vn',
    '-map',
    '0:a:0?',
    '-af',
    filter,
    '-c:a',
    'aac',
    '-b:a',
    '192k'
  ])
}

// ── 人声隔离滤镜链 ──

/**
 * 立体声中心声道提取：左右相减抵消两侧的乐器，保留居中的人声。
 * 叠加高通 / 低通 / 降噪 / 增益补偿来进一步提纯语音。
 */
function buildCenterExtractionFilter(): string {
  return [
    'pan=mono|c0=0.5*c0+-0.5*c1',
    'highpass=f=80',
    'lowpass=f=8000',
    'afftdn=nr=12',
    'volume=1.5'
  ].join(',')
}

/**
 * 仅 EQ 滤波方案：适用于单声道音频或中心声道提取效果不佳的场景。
 * 保留人声频率范围（80Hz–8kHz），削减两侧乐器频率。
 */
function buildEqOnlyFilter(): string {
  return ['highpass=f=80', 'lowpass=f=8000', 'afftdn=nr=12', 'volume=1.3'].join(',')
}

async function resolveVideoSource(projectId: string, mediaId: string): Promise<VideoSource> {
  if (!projectId || !mediaId) throw new Error('缺少项目或源视频')
  const prefix = `projects/${projectId}/media/`
  const row = getDb()
    .prepare(
      'SELECT path, mime, kind, size_bytes FROM media WHERE id = ? AND substr(path, 1, length(?)) = ? LIMIT 1'
    )
    .get(mediaId, prefix, prefix) as
    { path: string; mime: string; kind: string; size_bytes: number } | undefined
  if (!row || row.kind !== 'video' || !row.mime.startsWith('video/')) {
    throw new Error('输入视频不存在，或不属于当前项目')
  }
  const path = getMediaAbsPath(row.path)
  if (!path) throw new Error('输入视频路径无效')
  const file = await stat(path).catch(() => null)
  if (!file?.isFile()) throw new Error('输入视频文件不存在')
  return { path }
}

async function runToAsset(
  projectId: string,
  outputName: string,
  ext: string,
  assetName: string,
  args: string[]
): Promise<MediaAsset> {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-studio-video-'))
  const output = join(dir, outputName)
  try {
    await runFfmpeg([...args, '-y', output])
    const created = await stat(output).catch(() => null)
    if (!created?.isFile() || created.size === 0) throw new Error('本地媒体引擎未生成有效文件')
    return await saveFileAsset(projectId, output, ext, assetName)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function seconds(timeMs: number): string {
  return (Math.max(0, timeMs) / 1000).toFixed(3)
}

/**
 * 用 ffprobe 检测源视频第一条音轨是否为立体声（≥ 2 声道）。
 * 若 ffprobe 不可用则保守返回 false（走 EQ-only 方案）。
 */
async function probeStereo(filePath: string): Promise<boolean> {
  const binary = getFfprobePath()
  return new Promise((resolve) => {
    const child = spawn(
      binary,
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', filePath],
      { windowsHide: true }
    )
    let stdout = ''
    let settled = false
    const done = (value: boolean): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.once('error', () => done(false))
    child.once('close', () => {
      const channels = parseInt(stdout.trim(), 10)
      done(Number.isFinite(channels) && channels >= 2)
    })
  })
}

function getFfprobePath(): string {
  const ffmpegPath = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim()
  if (ffmpegPath) {
    return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  }
  return 'ffprobe'
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const binary = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim() || 'ffmpeg'
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', ...args], {
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000)
    })
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      const hint =
        code === 'ENOENT'
          ? '未找到本机 FFmpeg。请安装 FFmpeg 并加入 PATH，或设置 CANVAS_STUDIO_FFMPEG_PATH。'
          : error.message
      reject(new Error(hint))
    })
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`视频处理失败：${stderr.trim() || `FFmpeg 退出码 ${code ?? '未知'}`}`))
    })
  })
}
