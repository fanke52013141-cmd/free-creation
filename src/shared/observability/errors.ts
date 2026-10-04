// 错误归一化（LOGGING_SPEC.md §6）：任意原始错误/配置/响应不得直接序列化。
// 这里把内部错误码、HTTP 状态与异常对象映射为稳定的 code/category/retryable，
// 保留安全 sourceCode；message 由调用方用固定模板生成，不拼接原始正文。
import { redactDiagnosticText } from '../diagnostics'
import { DIAGNOSTICS_STACK_MAX_CHARS } from './limits'

export const DIAGNOSTICS_ERROR_CODES = [
  'INPUT_INVALID',
  'CAPABILITY_UNAVAILABLE',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'REQUEST_TIMEOUT',
  'NETWORK_FAILED',
  'UPSTREAM_FAILED',
  'RESPONSE_INVALID',
  'MEDIA_DOWNLOAD_FAILED',
  'MEDIA_WRITE_FAILED',
  'SAVE_CONFLICT',
  'STORAGE_WRITE_FAILED',
  'RESTORE_FAILED',
  'PROCESS_EXITED',
  'CANCELLED',
  'UNKNOWN'
] as const
export type DiagnosticsErrorCode = (typeof DIAGNOSTICS_ERROR_CODES)[number]

export type DiagnosticsErrorCategory =
  | 'input'
  | 'capability'
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'upstream'
  | 'response'
  | 'media'
  | 'storage'
  | 'process'
  | 'cancelled'
  | 'unknown'

export interface NormalizedDiagnosticError {
  code: DiagnosticsErrorCode
  category: DiagnosticsErrorCategory
  retryable: boolean
  httpStatus?: number
  /** 内部既有业务错误码（短标识），保持可追溯。 */
  sourceCode?: string
  causeCode?: string
  safeStack?: string
}

/** 既有内部错误码 → 诊断错误码的稳定映射；未识别一律 UNKNOWN，不猜。 */
const INTERNAL_CODE_MAP: Record<string, DiagnosticsErrorCode> = {
  TIMEOUT: 'REQUEST_TIMEOUT',
  INVALID_INPUT: 'INPUT_INVALID',
  INVALID_NAME: 'INPUT_INVALID',
  PROVIDER_NO_KEY: 'INPUT_INVALID',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  UNVERIFIED_PROVIDER: 'CAPABILITY_UNAVAILABLE',
  AUTH_FAILED: 'AUTH_FAILED',
  UNAUTHORIZED: 'AUTH_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_RATE_LIMIT: 'RATE_LIMITED',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  UPSTREAM_ERROR: 'UPSTREAM_FAILED',
  NETWORK: 'NETWORK_FAILED',
  RESPONSE_INVALID: 'RESPONSE_INVALID',
  EMPTY_RESULT: 'RESPONSE_INVALID',
  MEDIA_NOT_FOUND: 'MEDIA_DOWNLOAD_FAILED',
  DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
  TOAPIS_TASK_FAILED: 'UPSTREAM_FAILED',
  TOAPIS_UPLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
  MEDIA_DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
  MEDIA_WRITE_FAILED: 'MEDIA_WRITE_FAILED',
  SAVE_CONFLICT: 'SAVE_CONFLICT',
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
  RESTORE_FAILED: 'RESTORE_FAILED',
  PROCESS_EXITED: 'PROCESS_EXITED',
  CANCELLED: 'CANCELLED',
  ABORTED: 'CANCELLED'
}

const CATEGORY_BY_CODE: Record<DiagnosticsErrorCode, DiagnosticsErrorCategory> = {
  INPUT_INVALID: 'input',
  CAPABILITY_UNAVAILABLE: 'capability',
  AUTH_FAILED: 'auth',
  RATE_LIMITED: 'rate_limit',
  REQUEST_TIMEOUT: 'network',
  NETWORK_FAILED: 'network',
  UPSTREAM_FAILED: 'upstream',
  RESPONSE_INVALID: 'response',
  MEDIA_DOWNLOAD_FAILED: 'media',
  MEDIA_WRITE_FAILED: 'media',
  SAVE_CONFLICT: 'storage',
  STORAGE_WRITE_FAILED: 'storage',
  RESTORE_FAILED: 'storage',
  PROCESS_EXITED: 'process',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown'
}

const RETRYABLE_CODES = new Set<DiagnosticsErrorCode>([
  'RATE_LIMITED',
  'REQUEST_TIMEOUT',
  'NETWORK_FAILED',
  'UPSTREAM_FAILED',
  'MEDIA_DOWNLOAD_FAILED'
])

/** HTTP 状态 → 稳定错误码；未识别的 4xx/5xx 不伪造语义。 */
export function httpStatusToError(status: number): {
  code: DiagnosticsErrorCode
  retryable: boolean
} {
  if (status === 401 || status === 403) return { code: 'AUTH_FAILED', retryable: false }
  if (status === 429) return { code: 'RATE_LIMITED', retryable: true }
  if (status === 408) return { code: 'REQUEST_TIMEOUT', retryable: true }
  if (status >= 500) return { code: 'UPSTREAM_FAILED', retryable: true }
  if (status >= 400) return { code: 'INPUT_INVALID', retryable: false }
  return { code: 'UNKNOWN', retryable: false }
}

/**
 * 安全 stack：保留错误类型与代码位置，去除用户主目录、盘符绝对路径与消息正文
 * 中的潜在敏感内容。只保留前若干帧，避免 4KiB 超限。
 */
export function safeStack(error: unknown, maxChars = DIAGNOSTICS_STACK_MAX_CHARS): string {
  const raw =
    error instanceof Error && error.stack
      ? error.stack
      : `${(error as { name?: string })?.name ?? 'Error'}: safeStack(non-error)`
  const sanitized = redactDiagnosticText(
    raw
      .replace(/\r?\n/g, ' | ')
      .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s|]+)+/g, '[PATH]')
      .replace(/(?:\/(?:home|Users|root)[^\s|]*)/g, '[PATH]'),
    maxChars
  )
  return sanitized
}

/** 取 cause 链的根因 code（最多下探 3 层，防循环）。 */
function rootCauseCode(error: unknown, depth = 0): string | undefined {
  if (!error || depth > 3) return undefined
  const cause = (error as { cause?: unknown }).cause
  if (!cause) return undefined
  const code = (cause as { code?: unknown }).code
  if (typeof code === 'string' && code) return code.slice(0, 64)
  return rootCauseCode(cause, depth + 1)
}

/**
 * 把任意抛出物归一化为受限错误描述。任何分支都不抛错、不包含原始消息正文——
 * 上层 message 由调用方按固定模板生成。
 */
export function normalizeDiagnosticError(
  error: unknown,
  options: { withStack?: boolean } = {}
): NormalizedDiagnosticError {
  const sourceCode =
    typeof (error as { code?: unknown })?.code === 'string'
      ? ((error as { code: string }).code.slice(0, 64) as string)
      : undefined
  const mapped = sourceCode ? INTERNAL_CODE_MAP[sourceCode] : undefined
  let code: DiagnosticsErrorCode = mapped ?? 'UNKNOWN'
  let retryable = RETRYABLE_CODES.has(code)
  let httpStatus: number | undefined

  const status = (error as { status?: unknown; statusCode?: unknown })?.status ??
    (error as { statusCode?: unknown })?.statusCode
  if (typeof status === 'number' && Number.isFinite(status) && status >= 100 && status < 600) {
    httpStatus = status
    // 显式状态码比错误码映射更可信：401/429/5xx 直接决定语义。
    const byStatus = httpStatusToError(status)
    if (code === 'UNKNOWN' || (status === 429 && code !== 'RATE_LIMITED')) code = byStatus.code
    retryable = byStatus.retryable
  }

  const name = (error as { name?: unknown })?.name
  if (code === 'UNKNOWN' && name === 'TimeoutError') {
    code = 'REQUEST_TIMEOUT'
    retryable = true
  }
  if (code === 'UNKNOWN' && name === 'AbortError') {
    code = 'CANCELLED'
    retryable = false
  }
  if (code === 'CANCELLED') retryable = false

  const normalized: NormalizedDiagnosticError = {
    code,
    category: CATEGORY_BY_CODE[code],
    retryable
  }
  if (httpStatus !== undefined) normalized.httpStatus = httpStatus
  if (sourceCode) normalized.sourceCode = sourceCode
  const causeCode = rootCauseCode(error)
  if (causeCode) normalized.causeCode = causeCode
  if (options.withStack) normalized.safeStack = safeStack(error)
  return normalized
}
