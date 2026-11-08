// 上游请求超时兜底：所有直连供应商的 fetch 必须有界。
// 2026-09-27 实测 MiniMax 创建合成任务的连接可以无回包挂死（7 分钟+无错误无结果），
// 而画布引擎是单任务串行——一次挂起会把整张画布的执行入口一起拖死。这里统一注入
// AbortSignal.timeout，并把超时异常翻译成一句用户能行动的网关错误。
import { GatewayError } from './factory'
import { emitGatewayEvent } from '../diagnostics/gateway-events'

/** 控制面请求（建任务 / 查询 / 检索 / 登记音色）：正常都是秒级回包。 */
export const CONTROL_TIMEOUT_MS = 60 * 1000
/** 同步合成请求：长文本可能到分钟级，给足余量但必须有界。 */
export const SYNTHESIS_TIMEOUT_MS = 120 * 1000
/** 参考音频上传：受用户上行带宽影响最大（上限 20MB），给最宽的窗口。 */
export const UPLOAD_TIMEOUT_MS = 180 * 1000
/** 成片/产物下载：体积可达数百 MB 且受服务端出网带宽主导，不能套用控制面窗口，独立给更宽上界。 */
export const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 带原始 HTTP 状态的网关错误：错误码与文案仍由 describeUpstreamHttpError 归一化，
 * 只是额外保留 status，供调用方区分「瞬时 5xx」与「确定性 4xx」（如轮询容错）。
 */
export class UpstreamStatusError extends GatewayError {
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(code, message)
    this.status = status
  }
}

/**
 * 带超时的上游 fetch。超时（TimeoutError）与外部中止（AbortError）都归一为
 * GatewayError('TIMEOUT')；其余异常（网络断开等）原样抛出，维持既有错误通道。
 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'cookie'])

function carriesCredentials(init: RequestInit): boolean {
  try {
    const headers = new Headers(init.headers)
    for (const name of headers.keys()) {
      if (CREDENTIAL_HEADERS.has(name.toLowerCase())) return true
    }
  } catch {
    return true // 无法解析时按携带凭据处理，宁可保守
  }
  return false
}

export async function fetchUpstream(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  context: string
): Promise<Response> {
  // P2 端点绑定（方案 §4.3）：携带凭据的请求禁用自动重定向——3xx 一律拒绝，
  // 防止 Authorization / 自定义鉴权头被转发到非预期主机。
  const guardRedirect = carriesCredentials(init)
  try {
    const response = await fetch(url, {
      ...init,
      ...(guardRedirect ? { redirect: 'manual' as RequestRedirect } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (guardRedirect && response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      emitGatewayEvent('gateway.upstream.redirect_blocked', '携带凭据的上游重定向被拒绝', undefined, {
        status: 'failed',
        level: 'warn',
        attributes: { component: 'gateway', code: 'REDIRECT_BLOCKED' }
      })
      throw new GatewayError(
        'REDIRECT_BLOCKED',
        `${context}：上游返回重定向，为防止凭据外发已拒绝；请改用最终直达地址`
      )
    }
    return response
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new GatewayError(
        'TIMEOUT',
        `${context}：上游 ${Math.round(timeoutMs / 1000)} 秒内没有响应，已中断请求；请检查网络后重试`
      )
    }
    throw error
  }
}
