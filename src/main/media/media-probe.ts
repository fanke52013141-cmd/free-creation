// 媒体元数据探测（时间线节点 M3）：一次 FFprobe 拿到时间线需要的全部字段。
//
// 单独成模块的原因：时间线插入素材既要时长（视频/音频）又要画面尺寸（图片/视频），
// 而 media/video-transform.ts 里的 probeVideo 只关心时长/帧率/音轨，MediaAsset 的
// width/height/durationSec 一直是空字段。这里把「ffprobe JSON → 字段口径」收敛成一处，
// probeVideo 改为复用，避免出现第二套解析；子进程执行与取消登记复用 media/ffmpeg-runner，
// 不再另建 spawn 链（停止工作流时由主进程统一 kill）。
//
// 约定：
// - 失败不抛错：探测不到是「素材暂时不可用」而不是程序异常，调用方按 ok:false 决定提示；
//   只有 ENOENT（本机没有 FFprobe）才标记 missingTool，其余是文件/解码/解析问题。
// - 不伪造时长：图片等没有 duration 的素材返回 null，不写 0 或按帧数估算。
// - 只读探测：不落盘、不改数据库、不发诊断终态（解析失败由调用方所在的节点/导入路径报告）。
import { isAbsolute } from 'path'
import { FFPROBE_MISSING_HINT, resolveFfprobeBinary, runProcess } from './ffmpeg-runner'

export interface MediaProbeMeta {
  kind: 'image' | 'video' | 'audio' | 'unknown'
  durationMs: number | null
  width: number | null
  height: number | null
  fps: number | null
  hasAudio: boolean
  sampleRate: number | null
  channels: number | null
}

export type MediaProbeResult =
  | { ok: true; meta: MediaProbeMeta }
  | { ok: false; reason: string; missingTool: boolean }

/** 这些 codec 出现在视频流上时代表静态图/动图，不是可播放的视频轨道。 */
const IMAGE_CODECS = new Set([
  'png',
  'apng',
  'mjpeg',
  'jpeg',
  'jpg',
  'webp',
  'bmp',
  'gif',
  'tiff',
  'tif',
  'avif',
  'heic',
  'heif',
  'jp2',
  'jpeg2000',
  'qoi',
  'exr',
  'dpx',
  'targa',
  'tga',
  'ico',
  'dds',
  'pcx',
  'sgi',
  'ppm',
  'pgm',
  'pbm',
  'pnm',
  'fits'
])

/** 图片容器/序列：ffprobe 对文件级图片常报 `png_pipe`、`image2` 这类 format_name。 */
const IMAGE_FORMAT_HINTS = ['image2', '_pipe']

/** 大文件（尤其网络盘）探测可能很慢；超时按普通失败返回，不让调用方无限等待。 */
const PROBE_TIMEOUT_MS = 30_000

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  /** 形如 `30000/1001`；单帧图片会是 demux 默认值（如 25/1），不代表真实帧率。 */
  avg_frame_rate?: string
  /** 字符串数字，如 `48000`。 */
  sample_rate?: string
  channels?: number
  disposition?: { attached_pic?: number }
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string }
  streams?: FfprobeStream[]
}

/**
 * 一次 ffprobe 拿到时长、尺寸、帧率、音轨与采样参数；失败不抛错。
 * absPath 必须是绝对路径（媒体仓库里的相对路径先经 getMediaAbsPath 解析）。
 */
export async function probeMedia(absPath: string): Promise<MediaProbeResult> {
  if (!isAbsolute(absPath)) {
    return { ok: false, reason: '媒体文件路径必须是绝对路径', missingTool: false }
  }
  let raw: string
  try {
    raw = await runProcess(
      resolveFfprobeBinary(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
      FFPROBE_MISSING_HINT,
      { captureStdout: true, timeoutMs: PROBE_TIMEOUT_MS }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // runProcess 把 ENOENT 统一翻译成 missingHint，逐字比对即可区分「没装工具」。
    if (message === FFPROBE_MISSING_HINT) {
      return { ok: false, reason: message, missingTool: true }
    }
    return { ok: false, reason: `无法读取媒体元数据：${message}`, missingTool: false }
  }

  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(raw) as FfprobeOutput
  } catch {
    return {
      ok: false,
      reason: '无法解析 FFprobe 输出，请确认文件可被 FFmpeg 解码。',
      missingTool: false
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reason: '无法解析 FFprobe 输出，请确认文件可被 FFmpeg 解码。',
      missingTool: false
    }
  }
  return { ok: true, meta: describeStreams(parsed) }
}

/** 把 ffprobe 的 streams/format 归并成时间线字段；缺项一律 null，不用 0 冒充。 */
function describeStreams(parsed: FfprobeOutput): MediaProbeMeta {
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const formatName = typeof parsed.format?.format_name === 'string' ? parsed.format.format_name : ''
  // 专辑封面等 attached_pic 也是 codec_type=video，但它是音频文件的附属图片，不构成视频轨。
  const videoStreams = streams.filter(
    (stream) => stream?.codec_type === 'video' && stream.disposition?.attached_pic !== 1
  )
  const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio')
  const video = videoStreams[0]
  const audio = audioStreams[0]
  const kind = classifyKind(videoStreams, formatName, audioStreams.length > 0)
  const hasPicture = kind === 'image' || kind === 'video'

  return {
    kind,
    durationMs: parseDurationMs(parsed.format?.duration),
    width: hasPicture ? positiveInt(numberOrNull(video?.width)) : null,
    height: hasPicture ? positiveInt(numberOrNull(video?.height)) : null,
    // 单帧图片没有帧率语义：ffprobe 给的 25/1 是 demux 默认值，返回 null 比报 25 更诚实。
    fps: kind === 'video' ? parseFps(video?.avg_frame_rate) : null,
    hasAudio: audioStreams.length > 0,
    sampleRate: positiveInt(numberOrNull(audio?.sample_rate)),
    channels: positiveInt(numberOrNull(audio?.channels))
  }
}

function classifyKind(
  videoStreams: FfprobeStream[],
  formatName: string,
  hasAudio: boolean
): MediaProbeMeta['kind'] {
  if (videoStreams.length > 0) {
    const imageCodec = videoStreams.some((stream) =>
      IMAGE_CODECS.has((stream.codec_name ?? '').toLowerCase())
    )
    const imageFormat = formatName
      .split(',')
      .some((name) => IMAGE_FORMAT_HINTS.some((hint) => name.includes(hint)))
    return imageCodec || imageFormat ? 'image' : 'video'
  }
  if (hasAudio) return 'audio'
  return 'unknown'
}

function parseDurationMs(value: unknown): number | null {
  const seconds = numberOrNull(value)
  // 0 与缺失都按「没有时长」处理：图片序列/部分容器会报 0，写 0 会让时间线排出 0 秒片段。
  if (seconds === null || seconds <= 0) return null
  return Math.round(seconds * 1000)
}

/** `30000/1001` → 29.97…；`0/0`、缺分母、负数一律 null。 */
function parseFps(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const [numerator, denominator] = value.trim().split('/').map(Number)
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null
  }
  const fps = numerator / denominator
  return Number.isFinite(fps) && fps > 0 ? fps : null
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function positiveInt(value: number | null): number | null {
  return value !== null && value > 0 ? Math.round(value) : null
}
