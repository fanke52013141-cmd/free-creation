import type { Connection, ModelOperation, ModelTarget, ValidationStatus } from '@free-creation/model-contracts'
import { isModelOperationVerified } from '@free-creation/model-contracts'
import { ModelRuntimeError } from './errors.js'
import type { ProviderAdapter } from './provider-adapter.js'
import type { ResolvedModelTarget, RuntimePorts, ValidationRecord } from './ports.js'

type ResolvedWithAdapter = Omit<ResolvedModelTarget, 'secret'> & { adapter: ProviderAdapter }

export interface ModelRuntimeOptions {
  ports: RuntimePorts
  adapterForConnection?: (connection: Connection) => string | null
  now?: () => Date
}

export interface ValidationResult {
  status: ValidationStatus
  message: string
  action?: string
  checkedAt: string
}

const adapterFromConnection = (connection: Connection): string | null =>
  typeof connection.metadata.adapterId === 'string'
    ? connection.metadata.adapterId
    : ['openai', 'openai-compatible', 'openrouter', 'anthropic', 'google', 'minimax', 'volcengine', 'toapis', 'custom'].includes(connection.protocol)
      ? 'http'
      : connection.protocol

export class ModelRuntime {
  private readonly adapters = new Map<string, ProviderAdapter>()
  private readonly getAdapterId: (connection: Connection) => string | null
  private readonly now: () => Date

  constructor(private readonly options: ModelRuntimeOptions) {
    this.getAdapterId = options.adapterForConnection ?? adapterFromConnection
    this.now = options.now ?? (() => new Date())
  }

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate model provider adapter: ${adapter.id}`)
    this.adapters.set(adapter.id, adapter)
  }

  async validateModel(connectionId: string, modelDefinitionId: string, operation: ModelOperation, signal?: AbortSignal): Promise<ValidationResult> {
    const checkedAt = this.now().toISOString()
    let resolved: ResolvedWithAdapter
    try { resolved = await this.lookup(connectionId, modelDefinitionId, operation) }
    catch (error) { return this.record(connectionId, modelDefinitionId, operation, 'failed', this.errorMessage(error), checkedAt) }
    const secret = await this.options.ports.secrets.readSecret(connectionId)
    if (!secret) return this.record(connectionId, modelDefinitionId, operation, 'failed', '该连接没有可用 API Key', checkedAt, '保存 API Key 后重新验证')
    if (!resolved.adapter.supports(operation, resolved.model)) return this.record(connectionId, modelDefinitionId, operation, 'unsupported', '该模型未声明支持此调用能力', checkedAt, '选择支持此能力的模型')
    try {
      const finding = await resolved.adapter.validate({ ...resolved, secret, signal })
      return this.record(connectionId, modelDefinitionId, operation, finding.status, finding.message, checkedAt, finding.action)
    } catch (error) {
      return this.record(connectionId, modelDefinitionId, operation, 'failed', `验证请求失败：${this.errorMessage(error)}`, checkedAt, '检查网络、Base URL 与 API Key 后重试')
    }
  }

  async resolveForExecution(connectionId: string, modelDefinitionId: string, operation: ModelOperation): Promise<ResolvedModelTarget> {
    const validation = await this.options.ports.validations.getValidation(connectionId, modelDefinitionId, operation)
    if (validation?.status !== 'verified') throw new ModelRuntimeError('not-verified', `模型尚未通过 ${operation} 调用验证${validation?.message ? `：${validation.message}` : ''}`, validation?.action ?? '请先在模型设置中验证此模型')
    const resolved = await this.lookup(connectionId, modelDefinitionId, operation)
    const secret = await this.options.ports.secrets.readSecret(connectionId)
    if (!secret) throw new ModelRuntimeError('invalid-configuration', '模型连接没有可用 API Key')
    return { ...resolved, secret }
  }

  private async lookup(connectionId: string, modelDefinitionId: string, operation: ModelOperation): Promise<ResolvedWithAdapter> {
    const [connection, model] = await Promise.all([this.options.ports.configuration.getConnection(connectionId), this.options.ports.configuration.getModel(modelDefinitionId)])
    if (!connection) throw new ModelRuntimeError('invalid-configuration', `模型连接 ${connectionId} 不存在`)
    if (!connection.enabled) throw new ModelRuntimeError('invalid-configuration', '模型连接已停用')
    if (!model || model.connectionId !== connectionId) throw new ModelRuntimeError('invalid-configuration', '模型目标不存在或不属于该连接')
    const target: ModelTarget = { connectionId, modelId: model.modelId, operation }
    const adapterId = this.getAdapterId(connection)
    const adapter = adapterId ? this.adapters.get(adapterId) : undefined
    if (!adapter) throw new ModelRuntimeError('invalid-configuration', '该连接没有已注册的协议适配器')
    return { connection, model, target, operation, adapter }
  }

  private async record(connectionId: string, modelDefinitionId: string, operation: ModelOperation, status: 'verified' | 'failed' | 'unsupported', message: string, checkedAt: string, action?: string): Promise<ValidationResult> {
    const record: ValidationRecord = { connectionId, modelDefinitionId, operation, status, message, action, checkedAt, ...(status === 'verified' ? { verifiedAt: checkedAt } : {}) }
    await this.options.ports.validations.saveValidation(record)
    return { status, message, action, checkedAt }
  }

  private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
}

export { isModelOperationVerified }
