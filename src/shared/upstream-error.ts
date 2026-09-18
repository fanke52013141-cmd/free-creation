// 上游 HTTP 错误归一化：MiniMax / Seedance / ToAPIS 这些服务商失败时返回的形态
// 各不相同（JSON 错误体、嵌套 base_resp、甚至整页 HTML 错误页）。直接把响应体
// 截断拼进错误信息，用户会在节点上看到一段看不懂的 markup 或 JSON。
// 所有网关的错误出口共用这一份判定，不允许各写一套 slice。

export type UpstreamErrorCode = 'UPSTREAM_AUTH' | 'UPSTREAM_RATE_LIMIT' | 'UPSTREAM_ERROR'

export interface UpstreamHttpError {
  code: UpstreamErrorCode
  message: string
}

/** 各服务商错误体里承载人话信息的字段名，按优先级排列。 */
const MESSAGE_KEYS = [
  'message',
  'error_message',
  'err_msg',
  'errmsg',
  'status_msg',
  'error_msg',
  'msg',
  'detail',
  'reason',
  'error'
]

function labelForStatus(status: number): string {
  if (status === 401 || status === 403) return '鉴权失败，请检查供应商的 API Key 与模型权限'
  if (status === 404) return '接口不存在，请检查供应商的 Base URL 与模型名'
  if (status === 429) return '触发频率或额度限制，稍后再试'
  if (status >= 500) return '上游服务异常'
  return '上游拒绝请求'
}

export function upstreamErrorCode(status: number): UpstreamErrorCode {
  if (status === 401 || status === 403) return 'UPSTREAM_AUTH'
  if (status === 429) return 'UPSTREAM_RATE_LIMIT'
  return 'UPSTREAM_ERROR'
}

/**
 * 429 意味着任务在创建之前就被拒绝，重发不会重复扣费；
 * 超时与 5xx 可能已经创建了任务，重发等于同一内容扣两次钱。
 */
export function isResubmitSafeStatus(status: number): boolean {
  return status === 429
}

function looksLikeMarkup(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase()
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<?xml') ||
    head.includes('<html') ||
    head.includes('<body')
  )
}

/** 递归找出错误体里最具体的一句人话；找不到返回空串。 */
export function extractUpstreamMessage(payload: unknown, depth = 0): string {
  if (depth > 4 || payload == null) return ''
  if (typeof payload === 'string') return payload.trim()
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const message = extractUpstreamMessage(item, depth + 1)
      if (message) return message
    }
    return ''
  }
  if (typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  for (const key of MESSAGE_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
      const message = extractUpstreamMessage(value, depth + 1)
      if (message) return message
    }
  }
  // 包装层名字 unpredictable（{resp:{err:{...}}}），未知对象也要钻进去找
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const message = extractUpstreamMessage(value, depth + 1)
      if (message) return message
    }
  }
  return ''
}

/**
 * 把一次非 2xx 响应变成一句用户能照着行动的错误。
 * `context` 是调用方给出的动作说明，例如「视频任务提交失败」。
 */
export function describeUpstreamHttpError(
  status: number,
  body: string,
  context = ''
): UpstreamHttpError {
  const label = labelForStatus(status)
  const trimmed = (body ?? '').trim()
  let detail = ''
  if (trimmed && !looksLikeMarkup(trimmed)) {
    try {
      detail = extractUpstreamMessage(JSON.parse(trimmed))
    } catch {
      // 非 JSON 的纯文本错误体（如 "insufficient credit"）本身就是最有用的信息
      detail = trimmed
    }
  }
  const message = [
    context ? `${context}：` : '',
    `${label}（HTTP ${status}）`,
    detail && detail !== label ? ` ${detail}` : ''
  ].join('')
  return { code: upstreamErrorCode(status), message }
}
