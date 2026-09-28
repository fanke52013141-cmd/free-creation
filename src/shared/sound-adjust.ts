/** 音频或带声视频的本地变速、音量调整配置。目标时长以毫秒持久化。 */
export interface SoundAdjustConfig {
  version: 1
  mode: 'rate' | 'duration'
  rate: number
  targetDurationMs: number
  volumePercent: number
}

export const DEFAULT_SOUND_ADJUST_CONFIG: SoundAdjustConfig = {
  version: 1,
  mode: 'rate',
  rate: 1,
  targetDurationMs: 10_000,
  volumePercent: 100
}

export function parseSoundAdjustConfig(value: string): SoundAdjustConfig {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
  } catch {
    // 未配置的新节点使用明确的默认值。
  }
  const bounded = (input: unknown, fallback: number, min: number, max: number): number =>
    typeof input === 'number' && Number.isFinite(input)
      ? Math.min(max, Math.max(min, input))
      : fallback
  return {
    version: 1,
    mode: raw.mode === 'duration' ? 'duration' : 'rate',
    rate: bounded(raw.rate, 1, 0.25, 4),
    targetDurationMs: Math.round(bounded(raw.targetDurationMs, 10_000, 100, 36_000_000)),
    volumePercent: Math.round(bounded(raw.volumePercent, 100, 0, 300))
  }
}

/** FFmpeg 变速的安全范围为 0.25–4 倍；目标秒数超出时直接报告原因。 */
export function soundAdjustRate(config: SoundAdjustConfig, sourceDurationMs?: number): number {
  if (config.mode === 'rate') return config.rate
  if (!sourceDurationMs || !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    throw new Error('无法读取源媒体时长，不能按目标秒数调整')
  }
  const rate = sourceDurationMs / config.targetDurationMs
  if (rate < 0.25 || rate > 4) {
    throw new Error('目标秒数超出支持范围：调整后的语速须在 0.25–4 倍之间')
  }
  return rate
}

/** 兼容较早版本 FFmpeg 的 atempo 范围，将 0.25–4 倍拆成 0.5–2 倍滤镜链。 */
export function soundAtempoFilters(rate: number): string[] {
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error('语速须在 0.25–4 倍之间')
  const factors: number[] = []
  let remaining = rate
  while (remaining < 0.5) { factors.push(0.5); remaining /= 0.5 }
  while (remaining > 2) { factors.push(2); remaining /= 2 }
  factors.push(remaining)
  return factors.map((factor) => `atempo=${factor.toFixed(6)}`)
}
