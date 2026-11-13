// C2 受控联网搜索工具端口：main 侧执行豆包搜索并把结果结算为固定资产候选。
// 与 node.execute 的 ledger 端口不同——搜索无画布目标节点、无需 renderer deliver，
// 由 main 直接调用搜索客户端 + 资产来源（submitSearchResult）产出 committed 回执。
// 密钥由调用方注入的 resolveKey 从设备密钥库读取，本模块不持久化密钥、不记录正文。
import { searchDoubao } from '../gateway/doubao-search'
import { GatewayError } from '../gateway/factory'
import { FlowCommandError, type FlowCommandReceipt } from '../../shared/agent-flow/commands'
import type { FlowAssetStore } from './asset-store'
import type { AgentSearchInput } from './ledger-tool'

export type SearchKeyResolver = (connectionId: string) => Promise<string>

/**  well-known 搜索连接 id：用户在模型供应商中配置该 id 的连接（豆包搜索 baseUrl + 独立 key）。 */
export const DOUBAO_SEARCH_CONNECTION_ID = 'doubao-search'

export function createSearchPort(
  assets: FlowAssetStore,
  resolveKey: SearchKeyResolver,
  connectionId: string = DOUBAO_SEARCH_CONNECTION_ID
): (input: AgentSearchInput, signal: AbortSignal) => Promise<FlowCommandReceipt> {
  return async (input, signal) => {
    if (signal.aborted) throw new FlowCommandError('FLOW_CANCELLED', 'search')
    let apiKey: string
    try {
      apiKey = await resolveKey(connectionId)
    } catch {
      throw new FlowCommandError('WEB_SEARCH_NO_KEY', 'search-key')
    }
    if (!apiKey) throw new FlowCommandError('WEB_SEARCH_NO_KEY', 'search-key')
    let result
    try {
      result = await searchDoubao(apiKey, {
        query: input.query,
        count: input.count,
        connectionId
      })
    } catch (error) {
      // 归一为稳定码，不暴露原始报文/密钥。
      const code = error instanceof GatewayError ? error.code : 'WEB_SEARCH_FAILED'
      throw new FlowCommandError(code, 'search-request')
    }
    if (signal.aborted) throw new FlowCommandError('FLOW_CANCELLED', 'search')
    // 结果作为固定 JSON 候选资产（agent 节点 out-json）；幂等 submissionId 防重复结算。
    const version = assets.submitSearchResult({
      projectId: input.projectId,
      agentNodeId: input.agentNodeId,
      submissionId: `search:${input.commandId}`,
      data: {
        query: input.query,
        resultCount: result.resultCount,
        items: result.items,
        searchedAt: Date.now()
      }
    })
    return {
      commandId: input.commandId,
      projectId: input.projectId,
      taskId: input.taskId,
      targetNodeId: input.agentNodeId,
      state: 'committed',
      runId: input.commandId,
      inputs: [],
      outputRefs: [version.ref]
    }
  }
}