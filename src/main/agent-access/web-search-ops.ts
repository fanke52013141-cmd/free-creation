// C2：受控联网搜索外部 op 实现（CLI/MCP 自动派生）。
//
// 唯一实现：复用 `gateway/doubao-search.searchDoubao`（agent 内部 web.search@1 工具
// 同一客户端、同一官方真实端点、同一脱敏事件）。本模块只做边界：
// - 默认不执行（必须 confirmNetwork=true；搜索消耗供应方额度，还需 confirmCost=true）；
// - 外部不提供密钥/地址：密钥由 main 从设备密钥库按 well-known 连接 id 读取；
// - 直接返回结构化搜索结果，不做资产结算（固定资产候选仍是 agent 内部路径专属）。
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { getProvider } from '../gateway/providers.repo'
import { searchDoubao } from '../gateway/doubao-search'
import { GatewayError } from '../gateway/factory'
import { DOUBAO_SEARCH_CONNECTION_ID } from '../agent-flow/search-tool'
import { DesktopAccessError } from './desktop'

export const WEB_SEARCH_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'webSearch.run'
] as AccessOperationId[])

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

export async function runWebSearchOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>
): Promise<unknown> {
  if (operationId !== 'webSearch.run') refuse('NOT_FOUND', 'unknown web search operation')
  if (input.confirmNetwork !== true)
    refuse('NETWORK_CONFIRM_REQUIRED', 'pass confirmNetwork: true to allow a web search request')
  if (input.confirmCost !== true)
    refuse(
      'COST_CONFIRM_REQUIRED',
      'web search consumes supplier quota and may incur cost; pass confirmCost: true'
    )
  const query = String(input.query ?? '')
  const count = typeof input.count === 'number' ? input.count : undefined
  // 只按 well-known id 读设备密钥库；外部无法借此注入密钥或地址。
  const provider = await getProvider(DOUBAO_SEARCH_CONNECTION_ID)
  if (!provider?.apiKey)
    refuse('WEB_SEARCH_NO_KEY', 'configure the doubao-search connection key in the device vault')
  try {
    const result = await searchDoubao(provider.apiKey, {
      query,
      count,
      connectionId: DOUBAO_SEARCH_CONNECTION_ID
    })
    return { query, resultCount: result.resultCount, items: result.items }
  } catch (error) {
    // 归一为稳定码（客户端已脱敏），不暴露原始报文/密钥/地址。
    const code = error instanceof GatewayError ? error.code : 'WEB_SEARCH_FAILED'
    refuse(code, 'web search request failed')
  }
}