// Agent 工具调用能力验证的**共享实现**（从 ipc/models.ipc.ts 抽出）。
//
// 会向供应商发送真实请求（可能计费），因此：
// - 必须显式 allowCost=true 才允许发起；
// - 连接/模型必须启用且能力匹配、协议已适配；
// - 结果写入 agent tool-calling 验证快照（带 revision 防护，避免并发覆盖）。
// GUI 与外部接入调用同一函数，不各写一份。
import { emitDomainEvent } from '../diagnostics/ipc-domain-events'
import { newTraceId, newSpanId } from '../../shared/observability'
import { createCatalogChatModel } from '../gateway/factory'
import { probeAgentModel } from '../agent-flow/model-probe'
import type { SqliteModelHost } from './sqlite-model-host'

export interface AgentToolCallingValidationInput {
  connectionId?: unknown
  modelDefinitionId?: unknown
  allowCost?: unknown
}

export interface AgentToolCallingValidationResult {
  status: 'verified' | 'failed'
  message: string
  action?: string
  checkedAt: string
}

const SUPPORTED_PROTOCOLS = ['openai', 'openai-compatible', 'openrouter', 'toapis']

/** 与 GUI「验证 Agent 工具调用」完全同一条路径。 */
export async function validateAgentToolCallingOnHost(
  host: SqliteModelHost,
  input: AgentToolCallingValidationInput
): Promise<AgentToolCallingValidationResult> {
  const context = { traceId: newTraceId(), spanId: newSpanId() }
  emitDomainEvent('configuration.validation_started', 'Agent 工具调用能力验证开始', {
    context,
    ...(typeof input?.connectionId === 'string' ? { connectionId: input.connectionId } : {}),
    attributes: { modelId: typeof input?.modelDefinitionId === 'string' ? input.modelDefinitionId : '' }
  })
  try {
    if (input?.allowCost !== true)
      throw new Error('Agent 工具调用验证会向供应商发送真实请求，必须显式确认')
    const connectionId = typeof input.connectionId === 'string' ? input.connectionId : ''
    const modelDefinitionId =
      typeof input.modelDefinitionId === 'string' ? input.modelDefinitionId : ''
    if (!connectionId) throw new Error('连接 ID 不能为空')
    if (!modelDefinitionId) throw new Error('模型定义 ID 不能为空')
    const modelDefinition = await host.getModel(modelDefinitionId)
    if (
      !modelDefinition?.enabled ||
      modelDefinition.connectionId !== connectionId ||
      !modelDefinition.capabilities.some((capability) => capability.operation === 'text.generate')
    )
      throw new Error('所选文本模型不可用，请检查模型设置')
    const connection = await host.getConnection(connectionId)
    if (!connection?.enabled) throw new Error('模型连接不可用，请检查模型设置')
    if (!SUPPORTED_PROTOCOLS.includes(connection.protocol))
      throw new Error('当前连接协议未适配 Agent 工具调用验证')
    let address: URL
    try {
      address = new URL(connection.baseUrl)
    } catch {
      throw new Error('模型连接地址无效，请检查模型设置')
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)
    const secret = await host.readSecret(connectionId)
    if (!secret && !local) throw new Error('模型密钥不可用，请在模型设置中重新保存')
    const revisions = host.getAgentToolCallingRevisions(connectionId, modelDefinitionId)
    if (!revisions) throw new Error('模型连接或模型定义已更改，请重新验证')
    const report = await probeAgentModel(
      createCatalogChatModel({
        connectionId,
        baseURL: connection.baseUrl,
        apiKey: secret ?? undefined,
        headers: connection.headers,
        modelId: modelDefinition.modelId
      }),
      context,
      AbortSignal.timeout(65_000),
      { providerId: connectionId, modelId: modelDefinitionId }
    )
    const checkedAt = new Date().toISOString()
    const verified =
      report.structuredToolCall === 'verified' && report.toolResultRoundTrip === 'verified'
    const result: AgentToolCallingValidationResult = {
      status: verified ? 'verified' : 'failed',
      message: verified
        ? 'Agent 结构化工具调用与工具结果往返均已验证'
        : report.structuredToolCall !== 'verified'
          ? '模型未通过强制结构化工具调用验证'
          : '模型未通过工具结果往返验证',
      ...(verified ? {} : { action: '检查模型和连接配置后重试，或选择其他文本模型' }),
      checkedAt
    }
    host.saveAgentToolCallingValidation({
      connectionId,
      modelDefinitionId,
      snapshot: {
        status: result.status,
        message: result.message,
        checkedAt,
        ...(verified ? { verifiedAt: checkedAt } : {})
      },
      expectedConnectionRevision: revisions.connectionRevision,
      expectedModelRevision: revisions.modelRevision
    })
    emitDomainEvent('configuration.validation_completed', 'Agent 工具调用能力验证完成', {
      context,
      status: verified ? 'success' : 'failed',
      connectionId,
      attributes: { modelId: modelDefinitionId }
    })
    return result
  } catch (error) {
    emitDomainEvent('configuration.validation_failed', 'Agent 工具调用能力验证失败', {
      context,
      error,
      attributes: { modelId: typeof input?.modelDefinitionId === 'string' ? input.modelDefinitionId : '' }
    })
    throw error
  }
}
