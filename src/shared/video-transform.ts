/**
 * 视频媒体处理节点的固定配置。所有时间统一保存为毫秒，避免用不稳定的帧号持久化。
 *
 * v2 将原有的 VideoRangeConfig 拆分为 VideoClipConfig + VideoAudioConfig，
 * 并将人声分离完全独立为 VocalSeparationConfig。
 */

// ── 枚举类型 ──

/** 取帧定位模式。first=首帧、last=尾帧、custom=任意时刻。 */
export type FrameMode = 'first' | 'last' | 'custom'

/** 视频截取输出质量。fast=关键帧复制（边界可能不精确）、balanced=重编码 CRF18、high=重编码 CRF14。 */
export type ClipQuality = 'fast' | 'balanced' | 'high'

/** 提音格式。wav=无损（适合后续人声分离）、m4a=有损压缩（体积小）。 */
export type AudioFormat = 'wav' | 'm4a'

/** 人声分离档位。fast=FFmpeg 滤镜增强（快但不保证完全分离）、quality=本地 AI 模型（BS-RoFormer 等）。 */
export type VocalMode = 'fast' | 'quality'

// ── v2 配置接口 ──

export interface VideoFrameConfig {
  version: 2
  /** 取帧定位模式。 */
  mode: FrameMode
  /** 自定义模式下使用的毫秒时间点；first/last 模式下忽略此字段。 */
  timeMs: number
  /** 输出图片格式。 */
  format: 'png' | 'jpg'
}

/**
 * 视频截取配置。v3 起「截视频」与「截音频」合并为同一节点（用户 2026-09-18 拍板：
 * 少了 一个节点），因此同一份起止时间同时驱动画面与音频两条输出。
 *
 * 与 v2 的语义差异：v2 的 `includeAudio` 只表示「截出的视频是否带原声」；v3 新增
 * `keepVideo` / `keepAudio` 决定产出哪几条资产，`includeAudio` 语义不变。
 */
export interface VideoClipConfig {
  version: 3
  startMs: number
  endMs: number
  /** 是否产出画面（视频片段资产）。 */
  keepVideo: boolean
  /** 是否产出独立的音频片段资产。 */
  keepAudio: boolean
  /** 视频片段是否保留原音轨；仅 keepVideo 为真时有效。 */
  includeAudio: boolean
  /** 画面输出编码质量。 */
  quality: ClipQuality
  /** 音频片段输出格式。 */
  audioFormat: AudioFormat
  /** 音频片段采样率。 */
  audioSampleRate: 44100 | 48000
}

export interface VideoAudioConfig {
  version: 2
  startMs: number
  endMs: number
  /** 输出音频格式。 */
  format: AudioFormat
  /** 采样率。 */
  sampleRate: 44100 | 48000
}

export interface VocalSeparationConfig {
  version: 1
  /** 分离档位。 */
  mode: VocalMode
  /** 是否同时输出伴奏轨。 */
  outputAccompaniment: boolean
}

// ── 解析辅助 ──

const clampTime = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback

const parseFrameMode = (value: unknown): FrameMode => {
  if (value === 'first' || value === 'last' || value === 'custom') return value
  return 'custom'
}

const parseClipQuality = (value: unknown): ClipQuality => {
  if (value === 'fast' || value === 'balanced') return value
  return 'high'
}

// 提音默认无损 WAV：下游人声分离需要高质量输入；仅显式配置 m4a 时才压缩。
const parseAudioFormat = (value: unknown): AudioFormat => (value === 'm4a' ? 'm4a' : 'wav')

const parseVocalMode = (value: unknown): VocalMode => (value === 'quality' ? 'quality' : 'fast')

const parseSampleRate = (value: unknown): 44100 | 48000 => (value === 48000 ? 48000 : 44100)

const parseBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const parseImageFormat = (value: unknown): 'png' | 'jpg' => (value === 'jpg' ? 'jpg' : 'png')

// ── v1 → v2 迁移 ──

/**
 * 解析取帧配置，兼容 v1（{ version:1, timeMs }）与 v2。
 * v1 数据默认视为 custom 模式，保留原 timeMs。
 */
export function parseVideoFrameConfig(text: string): VideoFrameConfig {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const ver = raw.version
    if (ver === 2) {
      return {
        version: 2,
        mode: parseFrameMode(raw.mode),
        timeMs: clampTime(raw.timeMs, 0),
        format: parseImageFormat(raw.format)
      }
    }
    // v1 兼容
    return {
      version: 2,
      mode: 'custom',
      timeMs: clampTime(raw.timeMs, 0),
      format: 'png'
    }
  } catch {
    return { version: 2, mode: 'first', timeMs: 0, format: 'png' }
  }
}

/**
 * 解析视频截取配置。
 *
 * - v3：直接读取 keepVideo / keepAudio。
 * - v2（历史「截视频」节点）：只产画面，等价 keepVideo=true、keepAudio=false，
 *   保证旧项目行为完全不变。
 * - 无配置（新建节点）：画面与音频都保留（用户 2026-09-18 拍板的默认值）。
 */
export function parseVideoClipConfig(text: string): VideoClipConfig {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const baseStart = clampTime(raw.startMs, 0)
    const startMs = baseStart
    const endMs = Math.max(startMs + 1, clampTime(raw.endMs, startMs + 1000))
    const quality = parseClipQuality(raw.quality)
    const includeAudio = parseBoolean(raw.includeAudio, true)
    const audioFormat = parseAudioFormat(raw.audioFormat ?? raw.format)
    const audioSampleRate = parseSampleRate(raw.audioSampleRate ?? raw.sampleRate)
    if (raw.version === 3) {
      const hasKeepFlags = typeof raw.keepVideo === 'boolean' || typeof raw.keepAudio === 'boolean'
      return {
        version: 3,
        startMs,
        endMs,
        keepVideo: parseBoolean(raw.keepVideo, true),
        // 两个开关都没落盘时按新节点默认值「画面+音频」；已显式保存的按保存值。
        keepAudio: hasKeepFlags ? parseBoolean(raw.keepAudio, false) : true,
        includeAudio,
        quality,
        audioFormat,
        audioSampleRate
      }
    }
    if (raw.version === 2) {
      return {
        version: 3,
        startMs,
        endMs,
        keepVideo: true,
        keepAudio: false,
        includeAudio,
        quality,
        audioFormat,
        audioSampleRate
      }
    }
    // v1 VideoRangeConfig 兼容
    return {
      version: 3,
      startMs,
      endMs,
      keepVideo: true,
      keepAudio: false,
      includeAudio: true,
      quality: 'high',
      audioFormat: 'wav',
      audioSampleRate: 44100
    }
  } catch {
    return {
      version: 3,
      startMs: 0,
      endMs: 1000,
      keepVideo: true,
      keepAudio: true,
      includeAudio: true,
      quality: 'high',
      audioFormat: 'wav',
      audioSampleRate: 44100
    }
  }
}

/**
 * 解析提音配置，兼容 v1 VideoRangeConfig。
 */
export function parseVideoAudioConfig(text: string): VideoAudioConfig {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    if (raw.version === 2) {
      const startMs = clampTime(raw.startMs, 0)
      const endMs = Math.max(startMs + 1, clampTime(raw.endMs, startMs + 1000))
      return {
        version: 2,
        startMs,
        endMs,
        format: parseAudioFormat(raw.format),
        sampleRate: parseSampleRate(raw.sampleRate)
      }
    }
    // v1 VideoRangeConfig 兼容（忽略 removeBackground/isolationMode 等已废弃字段）
    const startMs = clampTime(raw.startMs, 0)
    const endMs = Math.max(startMs + 1, clampTime(raw.endMs, startMs + 1000))
    return {
      version: 2,
      startMs,
      endMs,
      format: parseAudioFormat(raw.format),
      sampleRate: 44100
    }
  } catch {
    return { version: 2, startMs: 0, endMs: 1000, format: 'wav', sampleRate: 44100 }
  }
}

/**
 * 解析人声分离配置。
 */
export function parseVocalSeparationConfig(text: string): VocalSeparationConfig {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    return {
      version: 1,
      mode: parseVocalMode(raw.mode),
      outputAccompaniment: parseBoolean(raw.outputAccompaniment, true)
    }
  } catch {
    return { version: 1, mode: 'fast', outputAccompaniment: true }
  }
}

// ── 序列化 ──

export function serializeVideoFrameConfig(config: VideoFrameConfig): string {
  return JSON.stringify(config)
}

export function serializeVideoClipConfig(config: VideoClipConfig): string {
  return JSON.stringify(config)
}

export function serializeVideoAudioConfig(config: VideoAudioConfig): string {
  return JSON.stringify(config)
}

export function serializeVocalSeparationConfig(config: VocalSeparationConfig): string {
  return JSON.stringify(config)
}
