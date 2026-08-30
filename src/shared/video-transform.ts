/** 视频媒体处理节点的固定配置。所有时间统一保存为毫秒，避免用不稳定的帧号持久化。 */
export type VideoTransformKind = 'frame' | 'clip' | 'audio'

/** 人声隔离策略（FFmpeg 滤镜模式）。 */
export type VocalIsolationMode = 'off' | 'auto' | 'center' | 'eq'

/** AI 人声分离模型档位。 */
export type SeparationModel = 'fast' | 'balanced' | 'best'

export interface VideoFrameConfig {
  version: 1
  timeMs: number
}

export interface VideoRangeConfig {
  version: 1
  startMs: number
  endMs: number
  /** 音频提取专用：是否启用去除背景音（人声隔离）。 */
  removeBackground?: boolean
  /** 音频提取专用：FFmpeg 人声隔离策略（useAiSeparation 非 true 时生效）。 */
  isolationMode?: VocalIsolationMode
  /** 音频提取专用：是否使用 AI 模型分离（true=AI，false/undefined=FFmpeg 滤镜）。 */
  useAiSeparation?: boolean
  /** 音频提取专用：AI 模型档位（useAiSeparation=true 时生效）。 */
  separationModel?: SeparationModel
}

const clampTime = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback

const parseIsolationMode = (value: unknown): VocalIsolationMode => {
  if (value === 'center' || value === 'eq' || value === 'auto') return value
  return 'auto'
}

const parseSeparationModel = (value: unknown): SeparationModel => {
  if (value === 'fast' || value === 'balanced' || value === 'best') return value
  return 'balanced'
}

export function parseVideoFrameConfig(text: string): VideoFrameConfig {
  try {
    const raw = JSON.parse(text) as { timeMs?: unknown }
    return { version: 1, timeMs: clampTime(raw.timeMs, 0) }
  } catch {
    return { version: 1, timeMs: 0 }
  }
}

export function parseVideoRangeConfig(text: string): VideoRangeConfig {
  try {
    const raw = JSON.parse(text) as {
      startMs?: unknown
      endMs?: unknown
      removeBackground?: unknown
      isolationMode?: unknown
      useAiSeparation?: unknown
      separationModel?: unknown
    }
    const startMs = clampTime(raw.startMs, 0)
    const endMs = Math.max(startMs + 1, clampTime(raw.endMs, Math.max(1000, startMs + 1000)))
    const config: VideoRangeConfig = { version: 1, startMs, endMs }
    if (raw.removeBackground === true) {
      config.removeBackground = true
      if (raw.useAiSeparation === true) {
        config.useAiSeparation = true
        config.separationModel = parseSeparationModel(raw.separationModel)
      } else {
        config.isolationMode = parseIsolationMode(raw.isolationMode)
      }
    }
    return config
  } catch {
    return { version: 1, startMs: 0, endMs: 1000 }
  }
}

export function serializeVideoConfig(config: VideoFrameConfig | VideoRangeConfig): string {
  return JSON.stringify(config)
}
