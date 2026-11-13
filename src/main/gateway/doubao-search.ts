// 豆包搜索（火山引擎联网搜索 Custom 版）受控客户端。
// 官方契约：https://www.volcengine.com/docs/87772/2272953
//   POST https://open.feedcoopapi.com/search_api/web_search
//   Authorization: Bearer <独立搜索 API Key>（非方舟 Ark key）
//   错误在 ResponseMetadata.Error（HTTP 可能仍 200），Result 失败时为 null。
// 红线：不记录 query 正文、搜索结果正文、密钥或原始异常；事件只记 ID/计数/稳定码。
import { GatewayError } from './factory'
import { CONTROL_TIMEOUT_MS, fetchUpstream } from './upstream-fetch'
import { emitGatewayEvent } from '../diagnostics/gateway-events'

/** 真实供应方端点（官方文档核实，禁止替换为任何临时代理）。 */
const DOUBAO_SEARCH_URL = 'https://open.feedcoopapi.com/search_api/web_search'

export interface DoubaoSearchItem {
  title: string
  url: string
  /** 相关摘要（500~1000 字，官方推荐用于大模型场景）；缺失时回退 Snippet。 */
  summary: string
  siteName: string
  publishTime: string
  /** 权威度等级 1~4（1 非常权威）；缺省 0。 */
  authInfoLevel: number
}

export interface DoubaoSearchResult {
  items: DoubaoSearchItem[]
  resultCount: number
}

export interface DoubaoSearchOptions {
  query: string
  count?: number
  timeRange?: string
  /** 仅用于诊断事件关联，不进请求体。 */
  connectionId?: string
}

/** 把豆包 body 错误码归一为稳定网关错误码（不暴露原始报文）。 */
function mapErrorCode(code: string | number | undefined): string {
  const value = String(code ?? '')
  if (value === '700429') return 'WEB_SEARCH_RATE_LIMITED'
  if (value === '10406' || value === '10412') return 'WEB_SEARCH_QUOTA_EXHAUSTED'
  if (value === '700901' || value === '100013') return 'WEB_SEARCH_AUTH_INVALID'
  if (value === '10413') return 'WEB_SEARCH_COMPLIANCE_BLOCKED'
  if (value === '10500' || value === '10501') return 'WEB_SEARCH_UPSTREAM_RETRYABLE'
  return 'WEB_SEARCH_FAILED'
}

function toItem(raw: Record<string, unknown>): DoubaoSearchItem | null {
  const url = typeof raw.Url === 'string' ? raw.Url : ''
  const title = typeof raw.Title === 'string' ? raw.Title : ''
  const summary =
    (typeof raw.Summary === 'string' && raw.Summary) ||
    (typeof raw.Snippet === 'string' && raw.Snippet) ||
    ''
  // 无链接且无正文的条目丢弃（与官方建议一致）。
  if (!url && !summary) return null
  return {
    title,
    url,
    summary,
    siteName: typeof raw.SiteName === 'string' ? raw.SiteName : '',
    publishTime: typeof raw.PublishTime === 'string' ? raw.PublishTime : '',
    authInfoLevel: typeof raw.AuthInfoLevel === 'number' ? raw.AuthInfoLevel : 0
  }
}

/**
 * 发起一次受控豆包网页搜索。密钥由调用方从设备密钥库读取后传入，本模块不持久化密钥。
 * 失败抛 GatewayError（稳定码）；超时/重定向由 fetchUpstream 归一。
 */
export async function searchDoubao(
  apiKey: string,
  options: DoubaoSearchOptions
): Promise<DoubaoSearchResult> {
  const query = options.query.trim().slice(0, 100)
  if (!query) throw new GatewayError('WEB_SEARCH_QUERY_REQUIRED', '搜索词不能为空')
  if (!apiKey) throw new GatewayError('WEB_SEARCH_NO_KEY', '豆包搜索 API Key 未配置')
  const connectionId = options.connectionId ?? ''
  emitGatewayEvent('web.search.started', '受控联网搜索开始', undefined, {
    attributes: { operation: 'web.search', connectionId }
  })
  const started = Date.now()
  try {
    const response = await fetchUpstream(
      DOUBAO_SEARCH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          Query: query,
          SearchType: 'web',
          Count: Math.max(1, Math.min(50, options.count ?? 10)),
          ...(options.timeRange ? { TimeRange: options.timeRange } : {}),
          Filter: { NeedUrl: true },
          ContentFormats: 'text'
        })
      },
      CONTROL_TIMEOUT_MS,
      '豆包搜索'
    )
    if (!response.ok) {
      throw new GatewayError(
        'WEB_SEARCH_HTTP_ERROR',
        `豆包搜索返回 HTTP ${response.status}，请稍后重试`
      )
    }
    const json = (await response.json()) as {
      ResponseMetadata?: { Error?: { Code?: string | number; Message?: string } }
      Result?: { ResultCount?: number; WebResults?: Array<Record<string, unknown>> } | null
    }
    // 错误在 body：必须先查 ResponseMetadata.Error，否则空结果会被误判成功。
    const bodyError = json.ResponseMetadata?.Error
    if (bodyError) {
      throw new GatewayError(
        mapErrorCode(bodyError.Code),
        '豆包搜索服务返回错误，请检查密钥/额度或稍后重试'
      )
    }
    const items = (json.Result?.WebResults ?? [])
      .map(toItem)
      .filter((item): item is DoubaoSearchItem => item !== null)
    const resultCount = json.Result?.ResultCount ?? items.length
    emitGatewayEvent('web.search.completed', '受控联网搜索完成', undefined, {
      status: 'success',
      durationMs: Date.now() - started,
      attributes: { operation: 'web.search', connectionId, resultCount: items.length }
    })
    return { items, resultCount }
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : 'WEB_SEARCH_FAILED'
    emitGatewayEvent('web.search.failed', '受控联网搜索失败', undefined, {
      status: 'failed',
      durationMs: Date.now() - started,
      attributes: { operation: 'web.search', connectionId, code }
    })
    if (error instanceof GatewayError) throw error
    throw new GatewayError('WEB_SEARCH_FAILED', '豆包搜索请求失败，请检查网络后重试')
  }
}