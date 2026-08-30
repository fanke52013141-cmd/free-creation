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

export interface VideoClipConfig {
  version: 2
  startMs: number
  endMs: number
  /** 是否保留音轨；无音轨视频此项无效。 */
  includeAudio: boolean
  /** 输出编码质量。 */
  quality: ClipQuality
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
  if (value === 'fast' || value === 'high') return value
  return 'balanced'
}

const parseAudioFormat = (value: unknown): AudioFormat =>
  value === 'wav' ? 'wav' : 'm4a'

const parseVocalMode = (value: unknown): VocalMode =>
  value === 'quality' ? 'quality' : 'fast'

const parseSampleRate = (value: unknown): 44100 | 48000 =>
  value === 48000 ? 48000 : 44100

const parseBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const parseImageFormat = (value: unknown): 'png' | 'jpg' =>
  value === 'jpg' ? 'jpg' : 'png'

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
 * 解析截取配置，兼容 v1 VideoRangeConfig。
 */
export function parseVideoClipConfig(text: string): VideoClipConfig {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    if (raw.version === 2) {
      const startMs = clampTime(raw.startMs, 0)
      const endMs = Math.max(startMs + 1, clampTime(raw.endMs, startMs + 1000))
      return {
        version: 2,
        startMs,
        endMs,
        includeAudio: parseBoolean(raw.includeAudio, true),
        quality: parseClipQuality(raw.quality)
      }
    }
    // v1 VideoRangeConfig 兼容
    const startMs = clampTime(raw.startMs, 0)
    const endMs = Math.max(startMs + 1, clampTime(raw.endMs, startMs + 1000))
    return { version: 2, startMs, endMs, includeAudio: true, quality: 'balanced' }
  } catch {
    return { version: 2, startMs: 0, endMs: 1000, includeAudio: true, quality: 'balanced' }
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
    return { version: 2, startMs: 0, endMs: 1000, format: 'm4a', sampleRate: 44100 }
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
