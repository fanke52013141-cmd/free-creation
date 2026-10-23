// IPC surface for the reusable model catalog. This is intentionally separate from gateway.ipc:
// callers configure named connections and model definitions, then verify each exact capability.
import { ipcMain } from 'electron'
import { emitDomainEvent } from '../diagnostics/ipc-domain-events'
import type { ModelRuntime } from '@free-creation/model-runtime'
import { IPC, type DeleteModelConnectionInput, type DeleteModelDefinitionInput, type DeleteModelDefinitionsInput, type DiscoverModelDefinitionsInput, type DiscoveredModel, type IpcEnvelope, type ResolveModelFeatureInput, type ResolvedModelFeature, type SaveModelConnectionInput, type SaveModelDefinitionInput, type SaveModelFeatureBindingInput, type ValidateModelDefinitionInput } from '../../shared/contracts'
import type { Connection, ModelDefinition } from '@free-creation/model-contracts'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { createCatalogChatModel } from '../gateway/factory'
import { probeAgentModel } from '../agent-flow/model-probe'
import { newSpanId, newTraceId } from '../../shared/observability'
import { validateViduBaseURL } from '../gateway/vidu-cli'

const ok = <T>(data: T): IpcEnvelope<T> => ({ ok: true, data })
const fail = (error: unknown): IpcEnvelope<never> => ({ ok: false, error: { code: 'MODEL_CONFIGURATION_ERROR', message: error instanceof Error ? error.message : String(error) } })

function required(value: string, label: string): string {
  const result = value?.trim()
  if (!result) throw new Error(`${label}不能为空`)
  return result
}

/** Register once at startup. All responses are redacted Connection values (auth is always none). */
export function registerModelIpc(host: SqliteModelHost, runtime: ModelRuntime): void {

  ipcMain.handle(IPC.models.connections, (): IpcEnvelope<Connection[]> => ok(host.listConnections()))
  ipcMain.handle(IPC.models.definitions, (_event, connectionId?: string): IpcEnvelope<ModelDefinition[]> =>
    ok(host.listModels(connectionId))
  )
  ipcMain.handle(IPC.models.bindings, (): IpcEnvelope<import('@free-creation/model-contracts').FeatureBinding[]> => ok(host.listBindings()))
  ipcMain.handle(IPC.models.saveConnection, (_event, input: SaveModelConnectionInput): IpcEnvelope<Connection> => {
    try {
      required(input.id, '连接 ID'); required(input.name, '连接名称'); required(input.baseUrl, 'Base URL')
      if (input.protocol === 'vidu-cli') validateViduBaseURL(input.baseUrl)
      return ok(host.saveConnection(input))
    } catch (error) { return fail(error) }
  })
  ipcMain.handle(IPC.models.saveDefinition, (_event, input: SaveModelDefinitionInput): IpcEnvelope<ModelDefinition> => {
    try {
      required(input.id, '模型定义 ID'); required(input.name, '模型名称'); required(input.modelId, '上游模型 ID')
      return ok(host.saveModel(input))
    } catch (error) { return fail(error) }
  })
  ipcMain.handle(IPC.models.deleteDefinition, (_event, input: DeleteModelDefinitionInput): IpcEnvelope<boolean> => {
    try {
      required(input.modelDefinitionId, '模型定义 ID')
      return ok(host.deleteModel(input.modelDefinitionId))
    } catch (error) { return fail(error) }
  })
  ipcMain.handle(IPC.models.deleteDefinitions, (_event, input: DeleteModelDefinitionsInput): IpcEnvelope<number> => {
    try {
      if (!Array.isArray(input.modelDefinitionIds) || input.modelDefinitionIds.length === 0) throw new Error('请选择至少一个模型')
      return ok(host.deleteModels(input.modelDefinitionIds))
    } catch (error) { return fail(error) }
  })
  ipcMain.handle(IPC.models.deleteConnection, (_event, input: DeleteModelConnectionInput): IpcEnvelope<boolean> => {
    try {
      required(input.connectionId, '连接 ID')
      return ok(host.deleteConnection(input.connectionId))
    } catch (error) { return fail(error) }
  })
  ipcMain.handle(IPC.models.discover, async (_event, input: DiscoverModelDefinitionsInput): Promise<IpcEnvelope<DiscoveredModel[]>> => {
    try {
      required(input.connectionId, '连接 ID')
      const connection = await host.getConnection(input.connectionId)
      if (!connection) throw new Error('连接不存在')
      if (connection.protocol === 'vidu-cli') return ok([{ id: '3.4', name: 'Vidu Q4（图片参考生视频）' }, { id: '3.2', name: 'Vidu Q3（首尾帧生视频）' }])
      if (!['openai-compatible', 'openai', 'openrouter', 'toapis', 'custom'].includes(connection.protocol)) {
        throw new Error('此协议未提供统一的模型列表接口；请手动添加模型 ID')
      }
      const secret = await host.readSecret(input.connectionId)
      if (!secret) throw new Error('请先保存 API Key，再拉取可用模型')
      const response = await fetch(`${connection.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${secret}`, ...connection.headers }, signal: AbortSignal.timeout(20_000)
      })
      if (!response.ok) throw new Error(`拉取模型失败（HTTP ${response.status}）`)
      const payload = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> }
      const seen = new Set<string>()
      const models = (Array.isArray(payload.data) ? payload.data : []).flatMap((item) => {
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        if (!id || seen.has(id)) return []
        seen.add(id)
        return [{ id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id }]
      })
      return ok(models)
    } catch (error) { return fail(error) }
  })
  ipcMain.handle(IPC.models.validate, async (_event, input: ValidateModelDefinitionInput) => {
    try {
      if (input.allowCost !== true) throw new Error('模型真实验证可能产生供应商费用，必须显式确认')
      required(input.connectionId, '连接 ID'); required(input.modelDefinitionId, '模型定义 ID')
      const result = await runtime.validateModel(input.connectionId, input.modelDefinitionId, input.operation)
      emitDomainEvent('configuration.validation_completed', '模型能力验证完成', {
        status: 'success',
        connectionId: input.connectionId,
        attributes: { modelId: input.modelDefinitionId }
      })
      return ok(result)
    } catch (error) {
      emitDomainEvent('configuration.validation_failed', '模型能力验证失败', {
        error,
        connectionId: input?.connectionId,
        attributes: { modelId: input?.modelDefinitionId }
      })
      return fail(error)
    }
  })
  ipcMain.handle(IPC.models.validateAgentToolCalling, async (_event, input) => {
    const context = { traceId: newTraceId(), spanId: newSpanId() }
    emitDomainEvent('configuration.validation_started', 'Agent 工具调用能力验证开始', {
      context,
      connectionId: input?.connectionId,
      attributes: { modelId: input?.modelDefinitionId }
    })
    try {
      if (input?.allowCost !== true)
        throw new Error('Agent 工具调用验证会向供应商发送真实请求，必须显式确认')
      const connectionId = required(input.connectionId, '连接 ID')
      const modelDefinitionId = required(input.modelDefinitionId, '模型定义 ID')
      const modelDefinition = await host.getModel(modelDefinitionId)
      if (
        !modelDefinition?.enabled ||
        modelDefinition.connectionId !== connectionId ||
        !modelDefinition.capabilities.some((capability) => capability.operation === 'text.generate')
      )
        throw new Error('所选文本模型不可用，请检查模型设置')
      const connection = await host.getConnection(connectionId)
      if (!connection?.enabled) throw new Error('模型连接不可用，请检查模型设置')
      if (!['openai', 'openai-compatible', 'openrouter', 'toapis'].includes(connection.protocol))
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
      const result = {
        status: verified ? 'verified' as const : 'failed' as const,
        message: verified
          ? 'Agent 结构化工具调用与工具结果往返均已验证'
          : report.structuredToolCall !== 'verified'
            ? '模型未通过强制结构化工具调用验证'
            : '模型未通过工具结果往返验证',
        ...(!verified ? { action: '检查模型和连接配置后重试，或选择其他文本模型' } : {}),
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
      return ok(result)
    } catch (error) {
      emitDomainEvent('configuration.validation_failed', 'Agent 工具调用能力验证失败', {
        context,
        error,
        connectionId: input?.connectionId,
        attributes: { modelId: input?.modelDefinitionId }
      })
      return fail(error)
    }
  })
  ipcMain.handle(IPC.models.saveBinding, (_event, input: SaveModelFeatureBindingInput) => {
    try {
      required(input.featureKey, '功能标识'); required(input.connectionId, '连接 ID'); required(input.modelDefinitionId, '模型定义 ID')
      return ok(host.saveBinding(input))
    } catch (error) { return fail(error) }
  })
  ipcMain.handle(IPC.models.resolveBinding, async (_event, input: ResolveModelFeatureInput): Promise<IpcEnvelope<ResolvedModelFeature>> => {
    try {
      required(input.featureKey, '功能标识')
      const binding = await host.getBinding(input.featureKey)
      if (!binding?.enabled) throw new Error('该功能尚未绑定已启用模型')
      if (binding.target.operation !== input.operation) throw new Error(`功能绑定能力不匹配：需要 ${input.operation}`)
      const resolved = await runtime.resolveForExecution(binding.target.connectionId, binding.modelDefinitionId, input.operation)
      return ok({ featureKey: binding.featureKey, providerId: resolved.target.connectionId, modelId: resolved.target.modelId, operation: input.operation, modelKey: `${resolved.target.connectionId}::${resolved.target.modelId}` })
    } catch (error) { return fail(error) }
  })
}
