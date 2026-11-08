// F9：模型连接与受控凭据写入的外部实现。
//
// 唯一实现：全部委托 `SqliteModelHost`（GUI 模型设置用的同一类），不新增任何存储或加密路径。
// 明文密钥只在本进程内短暂存在：写入走宿主的设备绑定密钥库，读取只用于计算指纹，
// 既不返回给调用方，也不写入日志/诊断。
import { createHash } from 'node:crypto'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { getDb } from '../store/db'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { DesktopAccessError } from './desktop'

export const MODEL_ADMIN_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'model.connection.save',
  'model.credential.status',
  'model.connection.delete',
  'model.definition.save',
  'model.definition.delete',
  'model.definition.deleteMany',
  'model.binding.save'
] as AccessOperationId[])

/** 准入前失败：明确错误码、无副作用。 */
function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

function host(): SqliteModelHost {
  return new SqliteModelHost(getDb())
}

/** 不可逆指纹：明文绝不回传，只证明"这条连接里存的是不是同一把密钥"。 */
function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12)
}

interface SecretSummary {
  present: boolean
  fingerprint?: string
  algorithm?: 'sha256:12'
}

async function secretSummary(instance: SqliteModelHost, connectionId: string): Promise<SecretSummary> {
  // readSecret 内部带授权守卫；缺少授权时这里会抛错，从而如实失败而不是"看起来没密钥"。
  const secret = await instance.readSecret(connectionId)
  if (!secret) return { present: false }
  return { present: true, fingerprint: fingerprint(secret), algorithm: 'sha256:12' }
}

export async function runModelAdminOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>
): Promise<unknown> {
  const instance = host()

  if (operationId === 'model.connection.save') {
    const connectionId = input.id as string
    const before = await instance.getConnection(connectionId)
    const nextUrl = String(input.baseUrl).replace(/\/+$/, '')
    const nextHeaders = (input.headers as Record<string, string> | undefined) ?? {}
    const keyProvided = Boolean((input.apiKey as string | undefined)?.trim())
    // 连接事实变化会触发宿主清除验证与功能绑定（与 GUI 保存同一行为），回执必须如实告知。
    const invalidatedBindings = Boolean(
      before &&
        (before.protocol !== input.protocol ||
          before.baseUrl !== nextUrl ||
          JSON.stringify(before.headers ?? {}) !== JSON.stringify(nextHeaders) ||
          keyProvided)
    )
    let saved
    try {
      saved = await instance.saveConnection({
        id: connectionId,
        name: input.name as string,
        protocol: input.protocol as never,
        baseUrl: input.baseUrl as string,
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey as string } : {}),
        ...(input.headers !== undefined ? { headers: input.headers as Record<string, string> } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as never } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled as boolean } : {})
      })
    } catch (error) {
      refuse('MODEL_CONNECTION_SAVE_FAILED', error instanceof Error ? error.message.slice(0, 120) : undefined)
    }
    const summary = await secretSummary(instance, connectionId)
    return {
      id: saved.id,
      name: saved.name.slice(0, 120),
      protocol: saved.protocol,
      enabled: saved.enabled,
      baseUrlHost: new URL(saved.baseUrl).hostname.slice(0, 200),
      secret: summary,
      invalidatedBindings
    }
  }

  if (operationId === 'model.credential.status') {
    const connectionId = input.connectionId as string
    if (!(await instance.getConnection(connectionId))) refuse('NOT_FOUND', connectionId.slice(0, 80))
    return { connectionId, secret: await secretSummary(instance, connectionId) }
  }

  if (operationId === 'model.connection.delete') {
    const connectionId = input.connectionId as string
    if (!(await instance.getConnection(connectionId))) refuse('NOT_FOUND', connectionId.slice(0, 80))
    const deletedModels = instance.listModels(connectionId).length
    if (!instance.deleteConnection(connectionId)) refuse('NOT_FOUND', connectionId.slice(0, 80))
    return { connectionId, deleted: true, deletedModels }
  }

  if (operationId === 'model.definition.save') {
    const connectionId = input.connectionId as string
    if (!(await instance.getConnection(connectionId))) refuse('NOT_FOUND', `connection:${connectionId}`)
    const definition = instance.saveModel({
      id: input.id as string,
      connectionId,
      name: input.name as string,
      modelId: input.modelId as string,
      capabilities: input.capabilities as never,
      ...(input.metadata !== undefined ? { metadata: input.metadata as never } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled as boolean } : {})
    })
    return {
      id: definition.id,
      connectionId: definition.connectionId,
      name: definition.name.slice(0, 120),
      modelId: definition.modelId.slice(0, 200),
      enabled: definition.enabled,
      operations: definition.capabilities.map((capability) => capability.operation).slice(0, 16)
    }
  }

  if (operationId === 'model.definition.delete') {
    const id = input.id as string
    if (!instance.listModels().some((model) => model.id === id)) refuse('NOT_FOUND', id)
    if (!instance.deleteModel(id)) refuse('NOT_FOUND', id)
    return { id, deleted: true }
  }

  if (operationId === 'model.definition.deleteMany') {
    // 与 GUI 多选删除同一 deleteModels；不存在的 ID 逐项计入 notFound，
    // 不让"一个 ID 过期"把整批成功项变成失败（与 GUI 行为一致）。
    const requested = [...new Set(input.modelDefinitionIds as string[])]
    const known = new Set(instance.listModels().map((model) => model.id))
    const deleted = requested.filter((id) => known.has(id))
    const notFound = requested.filter((id) => !known.has(id))
    let removed = 0
    if (deleted.length) {
      removed = instance.deleteModels(deleted)
      // 防御：宿主返回值与请求不符时如实报不一致，而不是假装全删成功。
      if (removed !== deleted.length)
        refuse('STORAGE_INCONSISTENT', `deleted ${removed}/${deleted.length}`)
    }
    return { deleted, notFound }
  }

  // model.binding.save：宿主只接受"该模型该操作已验证"的绑定。外部无法自行验证模型，
  // 因此这里先给出稳定错误码，避免靠中文错误信息做判定的脆弱实现。
  const featureKey = input.featureKey as string
  const connectionId = input.connectionId as string
  const modelDefinitionId = input.modelDefinitionId as string
  const operation = input.operation as string
  const model = instance
    .listModels(connectionId)
    .find((candidate) => candidate.id === modelDefinitionId)
  if (!model) refuse('NOT_FOUND', `model:${modelDefinitionId}`)
  const validation = getDb()
    .prepare(
      `SELECT status FROM model_validations WHERE connection_id=? AND model_definition_id=? AND operation=?`
    )
    .get(connectionId, modelDefinitionId, operation) as { status?: string } | undefined
  if (validation?.status !== 'verified')
    refuse(
      'MODEL_NOT_VERIFIED',
      'this model capability has not been verified; validation requires provider access and is not open to external callers'
    )
  const binding = instance.saveBinding({
    featureKey,
    connectionId,
    modelDefinitionId,
    operation: operation as never,
    ...(input.enabled !== undefined ? { enabled: input.enabled as boolean } : {}),
    ...(input.overrides !== undefined ? { overrides: input.overrides as never } : {})
  })
  return {
    featureKey: binding.featureKey.slice(0, 200),
    connectionId: binding.target.connectionId,
    modelDefinitionId,
    operation: binding.target.operation,
    enabled: binding.enabled
  }
}
