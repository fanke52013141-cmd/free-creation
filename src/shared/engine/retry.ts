// AI 节点自动重试助手（优化方案 W1）。
//
// 背景：供应商波动（空返回 / 坏 JSON / 网络 5xx / 生图任务失败）是实测中最大的人工
// 阻塞点——每次失败都要用户手点「重试节点」。本模块把「瞬时可重试」的判定与指数
// 退避收敛成一个公共助手，供 ai-process / image-gen / video 三个执行器复用。
//
// 设计约束（画布工具优化方案 W1）：
// - 只重试「随机性 / 瞬时」错误；配置错误、输入契约失败、用户取消一律立即失败，
//   重试不会改变结果，只会烧钱；
// - 每次重试通过节点 trace 留痕，最终失败时聚合此前各次原因，运行中心一次看懂；
// - 退避等待必须响应取消信号（100ms 粒度轮询），绝不能在取消后仍发起下一轮请求。

export interface RetryConfig {
  /** 最大重试次数（不含首次）；0 表示关闭重试，保持既有行为。 */
  maxRetries: number
  /** 首次重试的退避基数（毫秒），按 2^(attempt-1) 指数递增。 */
  backoffMs: number
}

/** 节点 config 中 retry 字段的解析与钳制：缺省 / 非法值安全降级为关闭。 */
export function parseRetryConfig(value: unknown): RetryConfig {
  const raw =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>).retry
      : undefined
  if (!raw || typeof raw !== 'object') return { maxRetries: 0, backoffMs: 2000 }
  const record = raw as Record<string, unknown>
  const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    maxRetries: clamp(record.maxRetries, 0, 5, 0),
    backoffMs: clamp(record.backoffMs, 500, 30000, 2000)
  }
}

/** 立即失败（不重试）的错误特征：配置 / 契约 / 取消类，重试不会改变结果。 */
const NON_RETRYABLE_PATTERNS: RegExp[] = [
  /已取消/,
  /必须选择输出 Schema/,
  /尚未绑定已验证/,
  /当前模型不支持/,
  /不支持已连接的参考素材/,
  /^无提示词$/,
  /没有输入文本/,
  /没有可循环的列表输入/,
  /未配置循环体/,
  /未配置子流程/,
  /输入契约校验失败/,
  /循环体已修改/,
  /功能 \w+(\.\w+)* 尚未/
]

/** 可重试的错误特征：模型随机性输出与瞬时网络 / 供应商故障。 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /返回为空/,
  /不是合法 JSON/,
  /JSON 不符合/, // 模型输出未通过 Schema 校验——输出有随机性，重试有意义
  /task processing failed/i,
  /Generation failed/i,
  /timed? ?out|timeout/i,
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND/i,
  /fetch failed|Failed to fetch|NetworkError|network error/i,
  /\b(429|500|502|503|504)\b/, // HTTP 状态码（词边界，避免误伤正文数字）
  /rate.?limit|too many requests/i,
  /overloaded|服务超载|供应商繁忙/
]

/** 判定一次失败是否值得重试。先匹配「不重试」名单，再匹配「可重试」名单；未知错误默认不重试。 */
export function isRetryableError(message: string): boolean {
  if (NON_RETRYABLE_PATTERNS.some((p) => p.test(message))) return false
  return RETRYABLE_PATTERNS.some((p) => p.test(message))
}

/** 可中断的退避等待：每 100ms 检查一次取消信号，取消即以「已取消」拒绝。 */
export function backoffDelay(ms: number, signal: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.cancelled) {
      reject(new Error('已取消'))
      return
    }
    let waited = 0
    const timer = setInterval(() => {
      if (signal.cancelled) {
        clearInterval(timer)
        reject(new Error('已取消'))
        return
      }
      waited += 100
      if (waited >= ms) {
        clearInterval(timer)
        resolve()
      }
    }, 100)
  })
}

export interface RetryOptions {
  retry: RetryConfig
  signal: { cancelled: boolean }
  /** 每次决定重试时回调（写节点 trace 用）；可省略。 */
  onRetry?: (attempt: number, reason: string, delayMs: number) => void
}

/**
 * 对「瞬时可重试」的异步操作做指数退避重试。
 * fn 的 attempt 从 1 开始计（首次调用即 attempt=1）；总调用次数最多 maxRetries+1。
 * 最终失败抛出最后一次错误；此前有过其他尝试时，把历史原因聚合进错误消息。
 * 取消立即以「已取消」抛出，不等待退避结束。
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const { retry, signal, onRetry } = opts
  const reasons: string[] = []
  for (let attempt = 1; ; attempt += 1) {
    if (signal.cancelled) throw new Error('已取消')
    try {
      return await fn(attempt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (signal.cancelled) throw new Error('已取消')
      if (!isRetryableError(message) || attempt > retry.maxRetries) {
        if (reasons.length > 0 && !reasons.includes(message)) {
          throw new Error(`${message}（此前 ${reasons.length} 次尝试失败：${reasons.join('；')}）`)
        }
        throw error instanceof Error ? error : new Error(message)
      }
      reasons.push(message)
      const delay = retry.backoffMs * 2 ** (attempt - 1)
      onRetry?.(attempt, message, delay)
      await backoffDelay(delay, signal)
    }
  }
}
