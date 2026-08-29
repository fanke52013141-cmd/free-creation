/** 视频媒体处理节点的固定配置。所有时间统一保存为毫秒，避免用不稳定的帧号持久化。 */
export type VideoTransformKind = 'frame' | 'clip' | 'audio'

export interface VideoFrameConfig {
  version: 1
  timeMs: number
}

export interface VideoRangeConfig {
  version: 1
  startMs: number
  endMs: number
}

const clampTime = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback

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
    const raw = JSON.parse(text) as { startMs?: unknown; endMs?: unknown }
    const startMs = clampTime(raw.startMs, 0)
    const endMs = Math.max(startMs + 1, clampTime(raw.endMs, Math.max(1000, startMs + 1000)))
    return { version: 1, startMs, endMs }
  } catch {
    return { version: 1, startMs: 0, endMs: 1000 }
  }
}

export function serializeVideoConfig(config: VideoFrameConfig | VideoRangeConfig): string {
  return JSON.stringify(config)
}
