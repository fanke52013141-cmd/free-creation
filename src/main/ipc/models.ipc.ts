// IPC surface for the reusable model catalog. This is intentionally separate from gateway.ipc:
// callers configure named connections and model definitions, then verify each exact capability.
import { ipcMain } from 'electron'
import type { ModelRuntime } from '@free-creation/model-runtime'
import { IPC, type DeleteModelConnectionInput, type DeleteModelDefinitionInput, type DeleteModelDefinitionsInput, type DiscoverModelDefinitionsInput, type DiscoveredModel, type IpcEnvelope, type ResolveModelFeatureInput, type ResolvedModelFeature, type SaveModelConnectionInput, type SaveModelDefinitionInput, type SaveModelFeatureBindingInput, type ValidateModelDefinitionInput } from '../../shared/contracts'
import type { Connection, ModelDefinition } from '@free-creation/model-contracts'
import { SqliteModelHost } from '../model-host/sqlite-model-host'

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
      return ok(await runtime.validateModel(input.connectionId, input.modelDefinitionId, input.operation))
    } catch (error) { return fail(error) }
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
