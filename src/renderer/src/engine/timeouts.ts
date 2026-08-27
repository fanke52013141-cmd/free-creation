/**
 * 长任务统一超时协议（R8 / WP3）。
 *
 * 单一事实源：所有网关调用受统一超时约束，超时自动取消并记 phase='timeout' 错误。
 * 各节点不再各自实现 setTimeout（唯一例外是 shared.ts 的 waitForChat 内部计时，
 * 它已在 R8/WP3 之前存在，此处提供运行器层面的兜底超时）。
 *
 * 分级默认值（毫秒）：
 *   - 文本/对话/AI 处理：120s（短任务，快速失败反馈）
 *   - 生图/音频：300s（中等任务）
 *   - 视频：1800s（轮询型，较长）
 *   - 其余节点（text/json/code/processor/storyboard/script/iterate）：120s 兜底
 *
 * 节点 config 可通过 timeoutMs 字段覆盖默认值（高级用户直接改 JSON 配置，
 * 不做专门 UI 控件）。
 */

/** 各节点类型的默认超时（毫秒）。 */
const DEFAULT_TIMEOUTS_MS: Record<string, number> = {
  // 短任务：文本生成、对话、AI 处理
  chat: 120_000,
  text: 120_000,
  'ai-process': 120_000,
  // 中等任务：生图、音频合成
  'image-gen': 300_000,
  audio: 300_000,
  // 长任务：视频生成（轮询型）
  video: 1_800_000
}

/** 未登记节点类型的兜底超时。 */
const FALLBACK_TIMEOUT_MS = 120_000

/** 超时的下限与上限（毫秒），防止用户配置极端值。 */
const MIN_TIMEOUT_MS = 1_000 // 最少 1 秒
const MAX_TIMEOUT_MS = 3_600_000 // 最多 1 小时

/**
 * 解析节点的超时设置。
 *
 * 优先级：config.timeoutMs（用户显式覆盖） > 默认表 > 兜底值。
 * 用户配置会被钳制到 [MIN, MAX] 范围内。
 *
 * @param nodeType 节点类型 ID
 * @param config 节点配置对象（可为空）
 * @returns 超时毫秒数
 */
export function resolveTimeoutMs(
  nodeType: string,
  config?: Record<string, unknown> | null
): number {
  // 用户显式覆盖
  if (config && typeof config.timeoutMs === 'number' && config.timeoutMs > 0) {
    return clamp(config.timeoutMs)
  }
  return DEFAULT_TIMEOUTS_MS[nodeType] ?? FALLBACK_TIMEOUT_MS
}

function clamp(ms: number): number {
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, ms))
}

/**
 * 把毫秒超时格式化为用户可读的秒/分钟字符串。
 * 用于错误文案："超时（300s）"或"超时（30m0s）"。
 */
export function formatTimeoutLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}
