/**
 * 运行错误脱敏纯函数（双进程共用）。
 *
 * 渲染进程在 addError 时调用一次（发送前），主进程在写盘前再调用一次（防御纵深）。
 * 目标：日志文件中不出现 API Key、Authorization 头、含路径/参数的完整 URL。
 */

// Bearer token：裸 Bearer xxx（无 Authorization 头前缀时兜底）
const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g
// Authorization 头：Authorization: Bearer xxx / Basic xxx / authorization=xxx。
// 值可能含 scheme 前缀（Bearer/Basic + 空格），scheme 也要吞掉，否则 scheme 后的 token 会泄漏。
const AUTH_HEADER_RE = /[Aa]uthorization\s*[:=]\s*(?:[A-Za-z]+\s+)?[^\s;,)\]}"']+/g
// sk- 前缀密钥（OpenAI 等）：sk-xxxxxxxx...
const SK_KEY_RE = /sk-[A-Za-z0-9]{8,}/g
// api_key=xxx / api-key: xxx / apikey xxx
const API_KEY_RE = /api[-_]?key\s*[:=]\s*[^\s;,)\]}"']+/g
// 完整 URL（含 path 和 query），保留协议+域名，去掉路径和查询参数（Key 常在 query）
const URL_RE = /https?:\/\/[^\s'"<>)\]]+/g

function trimUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return url
  }
}

/**
 * 对文本脱敏并截断。
 * @param text 原始文本
 * @param maxLength 最大长度，超出尾部截断加省略号
 */
export function sanitizeText(text: string, maxLength = 500): string {
  const sanitized = text
    // Authorization 头先处理：整体吞掉 scheme+token，避免 Bearer 分开替换后残留
    .replace(AUTH_HEADER_RE, 'Authorization [REDACTED]')
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(SK_KEY_RE, 'sk-[REDACTED]')
    .replace(API_KEY_RE, 'api-key [REDACTED]')
    .replace(URL_RE, (m) => trimUrl(m))

  if (sanitized.length > maxLength) {
    return sanitized.slice(0, maxLength) + '…'
  }
  return sanitized
}

/**
 * 对运行错误对象脱敏（不修改原对象）。
 * 只清洗可能携带密钥的 reason 和 label 字段，其余字段原样透传。
 */
export function sanitizeRunError<T extends { label?: string; reason?: string }>(err: T): T {
  return {
    ...err,
    label: err.label ? sanitizeText(err.label, 200) : err.label,
    reason: err.reason ? sanitizeText(err.reason, 500) : err.reason
  }
}
