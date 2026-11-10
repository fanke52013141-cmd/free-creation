// F9：供应商连通性测试与模型真实验证的外部实现。
//
// 唯一实现：复用 `gateway/factory.testProvider`（GUI 供应商测试同一函数）与
// `model-runtime.validateModel`（GUI 模型验证同一运行时）。本模块只做边界：
// - 默认不执行（必须 confirmNetwork=true；validate 还需 confirmCost=true）；
// - 外部不提供密钥/地址，只给已保存 id；
// - 回执去敏（不含地址、密钥、请求/响应正文）。
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { getProvider } from '../gateway/providers.repo'
import { testProvider } from '../gateway/factory'
import { createDesktopModelRuntime } from '../model-host/runtime'
import { discoverConnectionModels } from '../model-host/discovery'
import { validateAgentToolCallingOnHost } from '../model-host/agent-tool-calling'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { getDb } from '../store/db'
import type { ModelOperation } from '@free-creation/model-contracts'
import { redactDiagnosticText } from '../../shared/diagnostics'
import { DesktopAccessError } from './desktop'

export const PROVIDER_NETWORK_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'provider.testConnection',
  'model.validate',
  'model.discover',
  'model.validateAgentToolCalling'
] as AccessOperationId[])

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

/**
 * 文案去敏：供应商错误文案里经常夹带 URL 与主机名（`401 at https://host/v1`），
 * 公共 redactDiagnosticText 只抹路径与密钥形态，**不抹地址**。这里额外把
 * 协议 URL、`host:port` 与域名形态替换掉——外部不需要知道供应商打到了哪台机器。
 */
function safeMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : ''
  const scrubbed = text
    .replace(/https?:\/\/[^\s)"']+/gi, '[地址]')
    .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b(:\d+)?/gi, '[地址]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b(:\d+)?/g, '[地址]')
  return redactDiagnosticText(scrubbed, 400)
}

export async function runProviderNetworkOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>
): Promise<unknown> {
  if (input.confirmNetwork !== true)
    refuse('NETWORK_CONFIRM_REQUIRED', 'pass confirmNetwork: true to allow a supplier request')

  if (operationId === 'provider.testConnection') {
    const providerId = input.providerId as string
    try {
      // 只传 id：密钥由 main 从设备密钥库读取，外部无法借此探测或注入密钥。
      const provider = await getProvider(providerId)
      if (!provider) throw new Error('PROVIDER_NOT_FOUND')
      const result = await testProvider({
        id: provider.id,
        name: provider.name,
        specId: provider.specId,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        models: provider.models
      })
      return {
        providerId,
        reachable: true,
        modelCount: Array.isArray(result?.models) ? result.models.length : 0,
        message: safeMessage(result?.message ?? '连接可用')
      }
    } catch (error) {
      // 不可用是**正常业务结果**（供应商拒绝/网络不通），不是"操作失败"：
      // 如实返回 reachable=false 与去敏原因，让调用方能区分"没发出去"和"发了但失败"。
      return {
        providerId,
        reachable: false,
        modelCount: 0,
        message: safeMessage(error) || '连接不可用'
      }
    }
  }

  // model.validate：会真实调用模型，必须再确认一次费用。
  if (operationId === 'model.validate') {
    if (input.confirmCost !== true)
      refuse('COST_CONFIRM_REQUIRED', 'model validation may incur supplier cost; pass confirmCost: true')
    const connectionId = input.connectionId as string
    const modelDefinitionId = input.modelDefinitionId as string
    const operation = input.operation as ModelOperation
    try {
      const host = new SqliteModelHost(getDb())
      const runtime = createDesktopModelRuntime(host)
      const result = await runtime.validateModel(connectionId, modelDefinitionId, operation)
      const status =
        result?.status === 'verified' ? 'verified' : result?.status === 'failed' ? 'failed' : 'pending'
      return {
        connectionId,
        modelDefinitionId,
        operation: String(operation),
        status,
        message: safeMessage(result?.message ?? '')
      }
    } catch (error) {
      refuse('VALIDATION_FAILED', safeMessage(error))
    }
  }

  // model.discover：拉取供应商模型列表（同一实现，同一端点绑定校验）。
  if (operationId === 'model.discover') {
    const connectionId = input.connectionId as string
    try {
      const host = new SqliteModelHost(getDb())
      const models = await discoverConnectionModels(host, connectionId)
      return {
        connectionId,
        models: models.slice(0, 500).map((model) => ({
          id: String(model.id).slice(0, 200),
          name: String(model.name).slice(0, 200)
        })),
        total: models.length
      }
    } catch (error) {
      // 供应商拒绝/网络失败是**业务结果**：给可分支的稳定码，不把错误文案当机密封死。
      refuse('DISCOVERY_FAILED', safeMessage(error))
    }
  }

  // model.validateAgentToolCalling：真实请求、可能计费 → 双重确认。
  if (input.confirmCost !== true)
    refuse(
      'COST_CONFIRM_REQUIRED',
      'agent tool-calling validation sends real supplier requests; pass confirmCost: true'
    )
  {
    const connectionId = input.connectionId as string
    const modelDefinitionId = input.modelDefinitionId as string
    try {
      const host = new SqliteModelHost(getDb())
      const result = await validateAgentToolCallingOnHost(host, {
        connectionId,
        modelDefinitionId,
        allowCost: true
      })
      return {
        connectionId,
        modelDefinitionId,
        status: result.status,
        message: safeMessage(result.message),
        ...(result.action ? { action: safeMessage(result.action) } : {}),
        checkedAt: result.checkedAt
      }
    } catch (error) {
      refuse('VALIDATION_FAILED', safeMessage(error))
    }
  }
}
