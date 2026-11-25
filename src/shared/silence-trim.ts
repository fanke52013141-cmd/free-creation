/** 音频去气口（静音/呼吸剪辑）配置与区间计算。
 *
 * 双引擎只差「气口区间」的来源：
 * - silence 引擎：FFmpeg silencedetect 按能量阈值找低于阈值的静音段；
 * - vad 引擎：Silero VAD（ONNX）逐帧判语音，非语音段（含呼吸声）都算气口。
 * 后续的 margin/minGap/keepGap 裁剪语义与拼接输出由本模块的纯函数统一定义，
 * 主进程变换与单元测试共用同一份实现。
 */

/** 毫秒区间；startMs 含、endMs 不含，恒有 startMs <= endMs。 */
export interface MsInterval {
  startMs: number
  endMs: number
}

export interface SilenceTrimConfig {
  version: 1
  /** silence：能量阈值检测；vad：Silero VAD 语音活动检测（可识别呼吸声）。 */
  engine: 'silence' | 'vad'
  /** silence 引擎：低于该 dB 值视为静音。 */
  thresholdDb: number
  /** vad 引擎：帧语音概率达到该值记为语音。 */
  vadThreshold: number
  /** 气口不短于该时长才参与裁剪；更短的停顿完整保留。 */
  minGapMs: number
  /** 每段语音前后保留的边距，防止剪掉字头字尾。 */
  marginMs: number
  /** 每个气口中心额外保留的时长；0 表示除边距外整段剪掉。 */
  keepGapMs: number
}

export const DEFAULT_SILENCE_TRIM_CONFIG: SilenceTrimConfig = {
  version: 1,
  engine: 'silence',
  thresholdDb: -35,
  vadThreshold: 0.5,
  minGapMs: 300,
  marginMs: 80,
  keepGapMs: 120
}

export function parseSilenceTrimConfig(value: string): SilenceTrimConfig {
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
    engine: raw.engine === 'vad' ? 'vad' : 'silence',
    thresholdDb: bounded(raw.thresholdDb, -35, -60, 0),
    vadThreshold: bounded(raw.vadThreshold, 0.5, 0.05, 0.95),
    minGapMs: Math.round(bounded(raw.minGapMs, 300, 0, 10_000)),
    marginMs: Math.round(bounded(raw.marginMs, 80, 0, 1000)),
    keepGapMs: Math.round(bounded(raw.keepGapMs, 120, 0, 2000))
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** FFmpeg silencedetect 的 stderr → 气口区间。
 *
 * silencedetect 在 info 日志级输出 `silence_start: X` / `silence_end: Y | silence_duration: D`。
 * 音频以静音结尾时只有 start 没有 end：区间钳到 durationMs。
 */
export function parseSilencedetectEvents(text: string, durationMs: number): MsInterval[] {
  const gaps: MsInterval[] = []
  let startMs: number | null = null
  for (const line of text.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (start) {
      startMs = clamp(Number(start[1]) * 1000, 0, durationMs)
      continue
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (end && startMs !== null) {
      const endMs = clamp(Number(end[1]) * 1000, 0, durationMs)
      if (endMs > startMs) gaps.push({ startMs, endMs })
      startMs = null
    }
  }
  // 尾静音：检测到 start 但流已结束（silence_end 缺失）。
  if (startMs !== null && durationMs > startMs) gaps.push({ startMs, endMs: durationMs })
  return gaps
}

/** 逐帧语音概率序列 → 语音区间（连续命中段合并）。
 *
 * `probs[i]` 对应第 i 帧的语音概率；一帧 = frameMs 毫秒。
 */
export function speechIntervalsFromProbabilities(
  probs: readonly number[],
  frameMs: number,
  threshold: number
): MsInterval[] {
  const speech: MsInterval[] = []
  let start: number | null = null
  for (let i = 0; i < probs.length; i++) {
    const isSpeech = probs[i] >= threshold
    if (isSpeech && start === null) start = i * frameMs
    if (!isSpeech && start !== null) {
      const endMs = i * frameMs
      if (endMs > start) speech.push({ startMs: start, endMs })
      start = null
    }
  }
  if (start !== null) {
    const endMs = probs.length * frameMs
    if (endMs > start) speech.push({ startMs: start, endMs })
  }
  return speech
}

/** 语音区间 → 气口区间：全时间轴的补集；输入不要求有序。 */
export function gapsFromSpeechIntervals(speech: readonly MsInterval[], durationMs: number): MsInterval[] {
  const sorted = [...speech].sort((a, b) => a.startMs - b.startMs)
  const gaps: MsInterval[] = []
  let cursor = 0
  for (const segment of sorted) {
    const startMs = clamp(segment.startMs, 0, durationMs)
    const endMs = clamp(segment.endMs, 0, durationMs)
    if (endMs <= cursor) continue
    if (startMs > cursor) gaps.push({ startMs: cursor, endMs: Math.min(startMs, durationMs) })
    cursor = Math.max(cursor, endMs)
  }
  if (cursor < durationMs) gaps.push({ startMs: cursor, endMs: durationMs })
  return gaps.filter((gap) => gap.endMs > gap.startMs)
}

/** 气口区间 → 剪切区间（margin/minGap/keepGap 语义，双引擎共用）。
 *
 * 每个气口先裁掉两端 marginMs（留给语音的边距），短于 minGapMs 的气口整个保留；
 * 剩余部分保留中心 keepGapMs、剪掉其余（keepGapMs=0 时除边距外全剪）。
 * 返回有序合并后的剪切区间（相邻/重叠自动合并）。
 */
export function gapCutsFromGaps(
  gaps: readonly MsInterval[],
  durationMs: number,
  config: Pick<SilenceTrimConfig, 'minGapMs' | 'marginMs' | 'keepGapMs'>
): MsInterval[] {
  const cuts: MsInterval[] = []
  for (const raw of gaps) {
    const startMs = clamp(raw.startMs, 0, durationMs)
    const endMs = clamp(raw.endMs, 0, durationMs)
    if (endMs - startMs < config.minGapMs) continue
    const candidateStart = startMs + config.marginMs
    const candidateEnd = endMs - config.marginMs
    if (candidateEnd <= candidateStart) continue
    const candidateLen = candidateEnd - candidateStart
    const keepLen = Math.min(config.keepGapMs, candidateLen)
    const cutLen = candidateLen - keepLen
    const headEnd = candidateStart + cutLen / 2
    const tailStart = candidateEnd - cutLen / 2
    // round 到毫秒并丢弃过短的碎边，避免 select 表达式膨胀。
    const head = { startMs: candidateStart, endMs: Math.round(headEnd) }
    const tail = { startMs: Math.ceil(tailStart), endMs: candidateEnd }
    if (head.endMs - head.startMs >= 1) cuts.push(head)
    if (tail.endMs - tail.startMs >= 1) cuts.push(tail)
  }
  return mergeIntervals(cuts)
}

/** 剪切区间 → 保留区间：全时间轴的补集。cuts 为空时返回整段。 */
export function keepIntervalsFromCuts(cuts: readonly MsInterval[], durationMs: number): MsInterval[] {
  return gapsFromSpeechIntervals(cuts, durationMs)
}

/** 有序化并合并相邻/重叠区间。 */
export function mergeIntervals(intervals: readonly MsInterval[]): MsInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs)
  const merged: MsInterval[] = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs)
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

/** 保留区间 → FFmpeg select 表达式；保留区间必须有序且不重叠。 */
export function selectExpressionForKeeps(keeps: readonly MsInterval[]): string {
  if (keeps.length === 0) throw new Error('整段都是气口，没有可保留的音频')
  return keeps
    .map((keep) => `between(t,${(keep.startMs / 1000).toFixed(3)},${(keep.endMs / 1000).toFixed(3)})`)
    .join('+')
}

/** 写进 meta.nodeResult.prompt 的参数安全摘要（不含媒体路径与内容）。 */
export function silenceTrimSummary(config: SilenceTrimConfig): string {
  const engine = config.engine === 'vad'
    ? `Silero VAD · 语音阈值 ${config.vadThreshold.toFixed(2)}`
    : `静音阈值 ${Math.round(config.thresholdDb)}dB`
  return `去气口 · ${engine} · 气口≥${config.minGapMs}ms · 边距${config.marginMs}ms · 中心保留${config.keepGapMs}ms`
}
