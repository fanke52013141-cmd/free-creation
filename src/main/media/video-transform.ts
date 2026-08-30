import { spawn } from 'child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDb } from '../store/db'
import { deleteMedia, getMediaAbsPath, saveFileAsset } from '../store/media.repo'
import type {
  AudioWaveformInput,
  AudioWaveformResult,
  LocalMediaCapabilities,
  LocalToolCapability,
  VideoClipTransformInput,
  VideoFrameTransformInput,
  VideoProbeInput,
  VideoProbeResult,
  VideoAudioTransformInput,
  VideoThumbnailsInput,
  VideoThumbnailsResult,
  VocalSeparateInput,
  VocalSeparationResult
} from '../../shared/contracts'
import {
  parseVideoClipConfig,
  parseVideoFrameConfig,
  parseVideoAudioConfig,
  parseVocalSeparationConfig
} from '../../shared/video-transform'
import type { MediaAsset } from '../../shared/types'

interface VideoSource {
  path: string
}

interface AudioSource {
  path: string
}

/**
 * 只读检查本机媒体工具。这里不缓存结果，方便用户安装或调整 PATH 后在设置面板重新打开即生效。
 * 执行器仍须处理工具在检查后被移除等竞态，不能把此状态当作授权或安全边界。
 */
export async function getLocalMediaCapabilities(): Promise<LocalMediaCapabilities> {
  const check = async (
    binary: string,
    args: string[],
    missingHint: string
  ): Promise<LocalToolCapability> => {
    try {
      await runProcess(binary, args, missingHint)
      return { available: true, message: '已就绪' }
    } catch (error) {
      return {
        available: false,
        message: error instanceof Error ? error.message : missingHint
      }
    }
  }
  const ffmpegBinary = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim() || 'ffmpeg'
  const audioSeparatorBinary =
    process.env.CANVAS_STUDIO_AUDIO_SEPARATOR_PATH?.trim() || 'audio-separator'
  const ffmpegHint = '未找到本机 FFmpeg。请安装并加入 PATH，或设置 CANVAS_STUDIO_FFMPEG_PATH。'
  return {
    ffmpeg: await check(ffmpegBinary, ['-version'], ffmpegHint),
    ffprobe: await check(getFfprobePath(), ['-version'], ffmpegHint),
    audioSeparator: await check(
      audioSeparatorBinary,
      ['--version'],
      '未找到本机 audio-separator。请安装并加入 PATH，或设置 CANVAS_STUDIO_AUDIO_SEPARATOR_PATH。'
    )
  }
}

/**
 * 视频变换适配器。只调用用户本机已安装/显式配置的 FFmpeg，不随应用打包 GPL 二进制。
 * 配置路径优先级：CANVAS_STUDIO_FFMPEG_PATH > 系统 PATH 中的 ffmpeg。
 */

// ── 取帧 ──

export async function transformVideoFrame(input: VideoFrameTransformInput): Promise<MediaAsset> {
  const source = await resolveVideoSource(input.projectId, input.sourceMediaId)
  const config = parseVideoFrameConfig(JSON.stringify(input.config))
  const ext = config.format === 'jpg' ? '.jpg' : '.png'
  const codec = config.format === 'jpg' ? 'mjpeg' : 'png'
  const name = config.format === 'jpg' ? 'frame.jpg' : 'frame.png'

  // first 模式：从开头解码第一张可正常解码的画面
  // last 模式：先探测时长，再定位到最后一帧（避开尾部空帧）
  // custom 模式：用户指定毫秒
  let seekMs: number
  if (config.mode === 'first') {
    seekMs = 0
  } else if (config.mode === 'last') {
    const meta = await probeVideo(input)
    // 向后退一帧的安全余量（通常一帧≈33ms），避免越界输出空文件
    seekMs = Math.max(0, meta.durationMs - 100)
  } else {
    seekMs = config.timeMs
  }

  return runToAsset(input.projectId, name, ext, '视频帧', [
    '-ss',
    seconds(seekMs),
    '-i',
    source.path,
    '-frames:v',
    '1',
    '-f',
    'image2',
    '-c:v',
    codec,
    '-q:v',
    '2',
    '-an'
  ])
}

// ── 截取 ──

export async function transformVideoClip(input: VideoClipTransformInput): Promise<MediaAsset> {
  const source = await resolveVideoSource(input.projectId, input.sourceMediaId)
  const config = parseVideoClipConfig(JSON.stringify(input.config))
  const durationSec = seconds(config.endMs - config.startMs)

  if (config.quality === 'fast') {
    // 快速模式：关键帧对齐复制，边界可能不精确
    const audioArgs = config.includeAudio ? ['-map', '0:a?'] : ['-an']
    return runToAsset(input.projectId, 'clip.mp4', '.mp4', '视频片段', [
      '-i',
      source.path,
      '-ss',
      seconds(config.startMs),
      '-t',
      durationSec,
      '-map',
      '0:v:0?',
      ...audioArgs,
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero'
    ])
  }

  // balanced/high 模式：精确重编码
  const crf = config.quality === 'high' ? '14' : '18'
  const preset = config.quality === 'high' ? 'slow' : 'medium'
  const audioArgs = config.includeAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']

  return runToAsset(input.projectId, 'clip.mp4', '.mp4', '视频片段', [
    '-i',
    source.path,
    '-ss',
    seconds(config.startMs),
    '-t',
    durationSec,
    '-map',
    '0:v:0?',
    ...(config.includeAudio ? ['-map', '0:a?'] : []),
    '-c:v',
    'libx264',
    '-crf',
    crf,
    '-preset',
    preset,
    ...audioArgs,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart'
  ])
}

// ── 提音 ──

export async function transformVideoAudio(input: VideoAudioTransformInput): Promise<MediaAsset> {
  const source = await resolveVideoSource(input.projectId, input.sourceMediaId)
  const config = parseVideoAudioConfig(JSON.stringify(input.config))
  const wav = config.format === 'wav'
  const name = wav ? 'audio.wav' : 'audio.m4a'
  const ext = wav ? '.wav' : '.m4a'
  const sr = String(config.sampleRate)

  return runToAsset(input.projectId, name, ext, '提取音频', [
    '-i',
    source.path,
    '-ss',
    seconds(config.startMs),
    '-t',
    seconds(config.endMs - config.startMs),
    '-vn',
    '-map',
    '0:a:0?',
    '-ar',
    sr,
    ...(wav ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k'])
  ])
}

// ── 人声分离 ──

export async function separateVocals(input: VocalSeparateInput): Promise<VocalSeparationResult> {
  const config = parseVocalSeparationConfig(JSON.stringify(input.config))

  if (config.mode === 'quality') {
    return separateWithModel(input)
  }
  // 快速模式：FFmpeg 滤镜增强（中置提取 + EQ），不保证完全分离
  return enhanceWithFfmpeg(input)
}

/** 快速增强：FFmpeg 滤镜链。诚实标注为"增强"而非"分离"。 */
async function enhanceWithFfmpeg(input: VocalSeparateInput): Promise<VocalSeparationResult> {
  const source = await resolveAudioSource(input.projectId, input.sourceMediaId)
  const dir = await mkdtemp(join(tmpdir(), 'canvas-studio-vocal-'))
  try {
    const vocalPath = join(dir, 'vocals_enhanced.wav')
    // 中置提取 + 带通 + 降噪 + 增益
    await runFfmpeg([
      '-i',
      source.path,
      '-vn',
      '-af',
      [
        'pan=mono|c0=0.5*c0+-0.5*c1',
        'highpass=f=85',
        'lowpass=f=8000',
        'afftdn=nr=15',
        'volume=1.6'
      ].join(','),
      '-c:a',
      'pcm_s16le',
      '-ar',
      '44100',
      '-y',
      vocalPath
    ])
    const vocals = await saveFileAsset(input.projectId, vocalPath, '.wav', '人声增强')

    // 快速模式只承诺“人声增强”。不能把原始音频副本伪装为伴奏。
    return { vocals }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 高质量模式：调用本地 audio-separator（UVR/MDX/RoFormer 模型）。 */
async function separateWithModel(input: VocalSeparateInput): Promise<VocalSeparationResult> {
  const source = await resolveAudioSource(input.projectId, input.sourceMediaId)
  const dir = await mkdtemp(join(tmpdir(), 'canvas-studio-vocal-'))
  const inputWav = join(dir, 'source.wav')
  const outputDir = join(dir, 'separated')
  try {
    await runFfmpeg(['-i', source.path, '-vn', '-c:a', 'pcm_s16le', '-ar', '44100', '-y', inputWav])
    await runAudioSeparator([
      inputWav,
      '--model_filename',
      'UVR-MDX-NET-Inst_HQ_3.onnx',
      '--output_dir',
      outputDir
    ])
    const files = await readdir(outputDir).catch(() => [])
    const vocal = files.find((name) => /\(vocals\)|vocal/i.test(name))
    if (!vocal) throw new Error('本地分离模型没有返回人声轨，请检查 audio-separator 与模型文件。')
    const config = parseVocalSeparationConfig(JSON.stringify(input.config))
    const accompaniment = files.find((name) =>
      /\(instrumental\)|instrumental|accompaniment/i.test(name)
    )
    if (config.outputAccompaniment && !accompaniment) {
      throw new Error('本地分离模型没有返回伴奏轨；请取消“同时输出伴奏”或更换模型。')
    }

    const created: MediaAsset[] = []
    try {
      const vocals = await saveFileAsset(
        input.projectId,
        join(outputDir, vocal),
        '.wav',
        '分离人声'
      )
      created.push(vocals)
      if (!config.outputAccompaniment) return { vocals }
      const backing = await saveFileAsset(
        input.projectId,
        join(outputDir, accompaniment as string),
        '.wav',
        '分离伴奏'
      )
      created.push(backing)
      return { vocals, accompaniment: backing }
    } catch (error) {
      await Promise.all(created.map((asset) => deleteMedia(asset.id).catch(() => false)))
      throw error
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ── 元数据探测 ──

export async function probeVideo(input: VideoProbeInput): Promise<VideoProbeResult> {
  const source = await resolveVideoSource(input.projectId, input.sourceMediaId)
  const raw = await runFfprobe([
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-show_entries',
    'stream=codec_type,avg_frame_rate',
    '-of',
    'json',
    source.path
  ])
  try {
    const parsed = JSON.parse(raw) as {
      format?: { duration?: string }
      streams?: Array<{ codec_type?: string; avg_frame_rate?: string }>
    }
    const durationMs = Math.max(0, Math.round(Number(parsed.format?.duration ?? 0) * 1000))
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
    const [n, d] = String(video?.avg_frame_rate ?? '')
      .split('/')
      .map(Number)
    const fps = Number.isFinite(n) && Number.isFinite(d) && d > 0 ? n / d : null
    return {
      durationMs,
      fps,
      hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === 'audio'))
    }
  } catch {
    throw new Error('无法读取视频时长和帧率，请确认文件可被 FFmpeg 解码。')
  }
}

// ── 缩略图采样 ──

export async function generateVideoThumbnails(
  input: VideoThumbnailsInput
): Promise<VideoThumbnailsResult> {
  const source = await resolveVideoSource(input.projectId, input.sourceMediaId)
  const count = Math.max(1, Math.min(12, Math.floor(input.count)))
  const meta = await probeVideo(input)
  const durationMs = Math.max(1000, meta.durationMs)

  const dir = await mkdtemp(join(tmpdir(), 'canvas-studio-thumbs-'))
  try {
    const thumbnails: string[] = []
    for (let i = 0; i < count; i++) {
      const t = Math.round((durationMs * i) / count)
      const outFile = join(dir, `thumb_${String(i).padStart(2, '0')}.jpg`)
      await runFfmpeg([
        '-ss',
        seconds(t),
        '-i',
        source.path,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        '-q:v',
        '5',
        '-vf',
        'scale=120:-1',
        '-y',
        outFile
      ]).catch(() => undefined)
      const buf = await readFile(outFile).catch(() => null)
      thumbnails.push(buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : '')
    }
    return { thumbnails }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ── 音频波形采样 ──

export async function generateAudioWaveform(
  input: AudioWaveformInput
): Promise<AudioWaveformResult> {
  const source = await resolveAudioSource(input.projectId, input.sourceMediaId)
  const samples = Math.max(50, Math.min(500, Math.floor(input.samples)))
  const dir = await mkdtemp(join(tmpdir(), 'canvas-studio-waveform-'))
  try {
    const rawFile = join(dir, 'raw.pcm')
    // 解码为 8-bit 单声道 raw PCM，便于快速采样峰值
    await runFfmpeg([
      '-i',
      source.path,
      '-vn',
      '-ac',
      '1',
      '-c:a',
      'pcm_u8',
      '-ar',
      String(Math.min(8000, samples * 4)),
      '-f',
      'u8',
      '-y',
      rawFile
    ]).catch(() => undefined)
    const buf = await readFile(rawFile).catch(() => null)
    if (!buf || buf.length === 0) return { peaks: new Array(samples).fill(0), sampleRate: 8000 }

    // 将原始 PCM 均匀分桶，每桶取最大绝对值（峰值）
    const peaks: number[] = new Array(samples).fill(0)
    const bucketSize = Math.max(1, Math.floor(buf.length / samples))
    for (let i = 0; i < samples; i++) {
      let peak = 0
      const start = i * bucketSize
      const end = Math.min(buf.length, start + bucketSize)
      for (let j = start; j < end; j++) {
        const val = Math.abs(buf[j] - 128) / 128 // u8 中心为 128
        if (val > peak) peak = val
      }
      peaks[i] = peak
    }
    return { peaks, sampleRate: Math.min(8000, samples * 4) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ── 源解析 ──

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

async function resolveAudioSource(projectId: string, mediaId: string): Promise<AudioSource> {
  if (!projectId || !mediaId) throw new Error('缺少项目或源音频')
  const prefix = `projects/${projectId}/media/`
  const row = getDb()
    .prepare(
      'SELECT path, mime, kind FROM media WHERE id = ? AND substr(path, 1, length(?)) = ? LIMIT 1'
    )
    .get(mediaId, prefix, prefix) as { path: string; mime: string; kind: string } | undefined
  if (!row || row.kind !== 'audio' || !row.mime.startsWith('audio/')) {
    throw new Error('输入音频不存在，或不属于当前项目')
  }
  const path = getMediaAbsPath(row.path)
  if (!path || !(await stat(path).catch(() => null))?.isFile())
    throw new Error('输入音频文件不存在')
  return { path }
}

// ── FFmpeg / 外部进程 ──

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

function getFfprobePath(): string {
  const ffmpegPath = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim()
  if (ffmpegPath) return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  return 'ffprobe'
}

function runFfprobe(args: string[]): Promise<string> {
  return runProcess(
    getFfprobePath(),
    args,
    '未找到本机 FFprobe。请安装 FFmpeg 并加入 PATH，或设置 CANVAS_STUDIO_FFMPEG_PATH。'
  )
}

function runAudioSeparator(args: string[]): Promise<string> {
  const binary = process.env.CANVAS_STUDIO_AUDIO_SEPARATOR_PATH?.trim() || 'audio-separator'
  return runProcess(
    binary,
    args,
    '未找到本机 audio-separator。请安装 audio-separator（含 UVR/MDX 模型），或设置 CANVAS_STUDIO_AUDIO_SEPARATOR_PATH。'
  )
}

function runProcess(binary: string, args: string[], missingHint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on(
      'data',
      (chunk: Buffer) => (stderr = `${stderr}${chunk.toString()}`.slice(-4000))
    )
    child.once('error', (error) =>
      reject(
        new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? missingHint : error.message)
      )
    )
    child.once('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.trim() || `${binary} 退出码 ${code ?? '未知'}`))
    )
  })
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
