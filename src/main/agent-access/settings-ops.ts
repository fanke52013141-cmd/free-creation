// F9（二）「模型设置」与「环境」页读取类动作的外部实现。
//
// 三入口同一实现：本模块不写执行器、不直写 SQLite、不复制 GUI 规则，
// 只把 GUI 页面背后的 main 服务按去敏字段投影出来：
// - 连接/定义/绑定：SqliteModelHost（与 ipc/models.ipc.ts 的 list* 同一仓储）；
// - 绑定解析：ModelRuntime.resolveForExecution（与 GUI models.bindings:resolve 同一解析服务）；
// - 本机能力：getLocalMediaCapabilities（FFmpeg/FFprobe/audio-separator）；
// - 视频引擎：getVideoEngineStatus（本地 CUDA 推理环境，video-depth/video-clay）；
// - 本地语音：detectIndexTts（IndexTTS 运行时，只投影 ready/state，不返回本机路径）。
//
// 边界（详见 docs/local-agent-access/36-models-env-delivery.md 第 5 节）：
// - 全部只读：不发供应商请求、不探测远端、不安装/下载、不写凭据与设置；
// - 去敏用**字段白名单**：地址、鉴权头、metadata、能力 controls、验证 message、
//   密钥密文/引用一律不投影（连接列表尤其如此）；
// - resolve 内部会读取密钥做"存在性检查"（GUI 同款语义），但密钥只存在于函数局部，
//   响应里只有 providerId/modelId；不把 `resolved` 整体展开，避免未来加字段时泄漏。
import type { Capability, ModelOperation } from '@free-creation/model-contracts'
import { ModelRuntimeError, type ModelRuntime, type ResolvedModelTarget } from '@free-creation/model-runtime'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { createDesktopModelRuntime } from '../model-host/runtime'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { detectIndexTts } from '../media/indextts-engine'
import { getLocalMediaCapabilities } from '../media/video-transform'
import { getVideoEngineStatus } from '../media/video-conversion'
import { getDb } from '../store/db'
import { DesktopAccessError } from './desktop'

export type SettingsOperationId =
  | 'model.connection.list'
  | 'model.definition.list'
  | 'model.binding.list'
  | 'model.binding.resolve'
  | 'environment.local'
  | 'environment.videoEngine.status'

const SETTINGS_READ_OPERATIONS: ReadonlySet<AccessOperationId> = new Set<AccessOperationId>([
  'model.connection.list',
  'model.definition.list',
  'model.binding.list',
  'model.binding.resolve',
  'environment.local',
  'environment.videoEngine.status'
])

export function isSettingsOperation(id: AccessOperationId): id is SettingsOperationId {
  return SETTINGS_READ_OPERATIONS.has(id)
}

function refuse(code: string, phase: string, detail?: string): never {
  throw new DesktopAccessError(
    code,
    false,
    `${phase}${detail ? `:${detail.slice(0, 200)}` : ''}`
  )
}

/** 每次读取都开一个仓储实例（与 ipc 层用法一致），不缓存连接/密钥。 */
function modelHost(): SqliteModelHost {
  return new SqliteModelHost(getDb())
}

const bounded = (value: string, max: number): string => value.slice(0, max)

/** 能力投影：只保留能力声明本身；controls（任意执行参数）不对外。 */
function capabilityDto(capability: Capability): {
  operation: ModelOperation
  asynchronous: boolean
  streaming: boolean
  acceptedAssetKinds: string[]
  producedAssetKinds: string[]
} {
  return {
    operation: capability.operation,
    asynchronous: capability.asynchronous,
    streaming: capability.streaming,
    acceptedAssetKinds: capability.acceptedAssetKinds.slice(0, 12),
    producedAssetKinds: capability.producedAssetKinds.slice(0, 12)
  }
}

function pageBounds(input: Record<string, unknown>): { offset: number; limit: number } {
  return { offset: input.offset as number, limit: input.limit as number }
}

function listConnections(input: Record<string, unknown>): unknown {
  const all = modelHost().listConnections()
  const { offset, limit } = pageBounds(input)
  return {
    // 字段白名单：只投影可公开的目录事实。刻意不含 baseUrl/headers/auth/metadata，
    // 也不含 secret_ref——连接可能带查询串凭据或内部域名，不能"顺手"带出。
    connections: all.slice(offset, offset + limit).map((connection) => ({
      id: connection.id,
      name: connection.name,
      protocol: connection.protocol,
      enabled: connection.enabled,
      ...(connection.createdAt ? { createdAt: connection.createdAt } : {}),
      ...(connection.updatedAt ? { updatedAt: connection.updatedAt } : {})
    })),
    total: all.length,
    reachability: 'not-probed' as const
  }
}

function listDefinitions(input: Record<string, unknown>): unknown {
  const host = modelHost()
  const connectionId = input.connectionId as string | undefined
  // 与 GUI models:definitions:list 同一仓储调用（含可选连接过滤）。
  const all = host.listModels(connectionId)
  const connectionEnabled = new Map(
    host.listConnections().map((connection) => [connection.id, connection.enabled])
  )
  const { offset, limit } = pageBounds(input)
  return {
    models: all.slice(offset, offset + limit).map((definition) => {
      const validation: Array<{ operation: ModelOperation; status: string; checkedAt?: string; verifiedAt?: string }> = []
      for (const [operation, snapshot] of Object.entries(definition.validation)) {
        if (!snapshot) continue
        validation.push({
          operation: operation as ModelOperation,
          status: snapshot.status,
          ...(snapshot.checkedAt ? { checkedAt: snapshot.checkedAt } : {}),
          ...(snapshot.verifiedAt ? { verifiedAt: snapshot.verifiedAt } : {})
        })
      }
      const agentToolCalling = definition.agentToolCallingValidation ?? { status: 'unverified' as const }
      return {
        id: definition.id,
        connectionId: definition.connectionId,
        modelId: definition.modelId,
        name: definition.name,
        enabled: definition.enabled,
        connectionEnabled: connectionEnabled.get(definition.connectionId) ?? false,
        capabilitiesTruncated: definition.capabilities.length > 32,
        capabilities: definition.capabilities.slice(0, 32).map(capabilityDto),
        // 验证 message 是供应商/探测原文，不进外部投影（与 model.list 口径一致）。
        validation: validation.slice(0, 12),
        agentToolCalling: {
          status: agentToolCalling.status,
          ...(agentToolCalling.checkedAt ? { checkedAt: agentToolCalling.checkedAt } : {}),
          ...(agentToolCalling.verifiedAt ? { verifiedAt: agentToolCalling.verifiedAt } : {})
        }
      }
    }),
    total: all.length,
    reachability: 'not-probed' as const
  }
}

function listBindings(input: Record<string, unknown>): unknown {
  const all = modelHost().listBindings()
  const { offset, limit } = pageBounds(input)
  return {
    bindings: all.slice(offset, offset + limit).map((binding) => ({
      featureKey: binding.featureKey,
      modelDefinitionId: binding.modelDefinitionId,
      connectionId: binding.target.connectionId,
      modelId: binding.target.modelId,
      operation: binding.target.operation,
      enabled: binding.enabled,
      ...(binding.updatedAt ? { updatedAt: binding.updatedAt } : {})
    })),
    total: all.length,
    reachability: 'not-probed' as const
  }
}

/** 显式目标 `provider::model`；provider 段是模型连接 id（GUI 同格式）。 */
function splitModelKey(value: string): { connectionId: string; modelId: string } {
  const index = value.indexOf('::')
  const connectionId = index > 0 ? value.slice(0, index).trim() : ''
  const modelId = index > 0 ? value.slice(index + 2).trim() : ''
  if (!connectionId || !modelId) refuse('INVALID_INPUT', 'validate', 'modelKey')
  return { connectionId, modelId }
}

function runtimeErrorCode(error: ModelRuntimeError): string {
  if (error.code === 'not-verified') return 'MODEL_NOT_VERIFIED'
  if (error.code === 'invalid-configuration') return 'MODEL_NOT_CONFIGURED'
  return `MODEL_${error.code.replace(/-/g, '_').toUpperCase()}`
}

/**
 * 与 GUI `models.bindings:resolve` 完全相同的解析服务。只翻译错误码，
 * 不把 ModelRuntimeError.message 带进 detail——该文案可能包含供应商验证原文。
 */
async function resolveTarget(
  runtime: ModelRuntime,
  connectionId: string,
  modelDefinitionId: string,
  operation: ModelOperation
): Promise<ResolvedModelTarget> {
  try {
    return await runtime.resolveForExecution(connectionId, modelDefinitionId, operation)
  } catch (error) {
    if (error instanceof ModelRuntimeError) refuse(runtimeErrorCode(error), 'model-resolve', operation)
    throw error
  }
}

function resolvedDto(
  featureKey: string,
  resolvedFrom: 'explicit-target' | 'feature-binding',
  resolved: ResolvedModelTarget
): unknown {
  // 显式逐字段投影：`resolved` 还带着 connection（地址/头/元数据）与 secret，
  // 整体展开会在未来字段变化时变成泄漏点。
  return {
    featureKey,
    providerId: resolved.target.connectionId,
    modelId: resolved.target.modelId,
    operation: resolved.operation,
    modelKey: `${resolved.target.connectionId}::${resolved.target.modelId}`,
    resolvedFrom
  }
}

async function resolveBinding(input: Record<string, unknown>): Promise<unknown> {
  const featureKey = input.featureKey as string
  const operation = input.operation as ModelOperation
  const explicitKey = input.modelKey as string | undefined
  const host = modelHost()
  const runtime = createDesktopModelRuntime(host)
  // 与 GUI 执行器相同的优先级：节点显式 selectedModelKey 优先，其次才是功能绑定。
  if (explicitKey) {
    const target = splitModelKey(explicitKey)
    const definition = host
      .listModels(target.connectionId)
      .find((candidate) => candidate.modelId === target.modelId)
    if (!definition) refuse('MODEL_TARGET_NOT_FOUND', 'model-resolve', 'explicit-target')
    const resolved = await resolveTarget(runtime, target.connectionId, definition.id, operation)
    return resolvedDto(featureKey, 'explicit-target', resolved)
  }
  const binding = await host.getBinding(featureKey)
  if (!binding?.enabled) refuse('MODEL_BINDING_NOT_FOUND', 'model-resolve', 'feature-binding')
  if (binding.target.operation !== operation)
    refuse('MODEL_OPERATION_MISMATCH', 'model-resolve', 'feature-binding')
  const resolved = await resolveTarget(runtime, binding.target.connectionId, binding.modelDefinitionId, operation)
  return resolvedDto(featureKey, 'feature-binding', resolved)
}

async function localEnvironment(): Promise<unknown> {
  // 三个探测都是 GUI 现有只读服务：媒体工具（设置面板）、视频推理环境（video-depth/clay 节点）、
  // 本地 IndexTTS（配音节点「重新检测」）。只 spawn 本机工具/读取本地就绪文件，不联网、
  // 不安装、不下载、不做推理；缺依赖如实返回 available=false，不让整个操作失败。
  // IndexTTS 探测按 GUI 同款规则不缓存且可能扫描本机安装位置（有界），因此这里只投影
  // 粗粒度就绪状态，不返回解释器/模型目录（GUI 文案里含本机绝对路径）。
  try {
    const [media, engine, indexTts] = await Promise.all([
      getLocalMediaCapabilities(),
      getVideoEngineStatus(),
      detectIndexTts()
    ])
    return {
      ffmpeg: { available: media.ffmpeg.available, message: bounded(media.ffmpeg.message, 600) },
      ffprobe: { available: media.ffprobe.available, message: bounded(media.ffprobe.message, 600) },
      audioSeparator: {
        available: media.audioSeparator.available,
        message: bounded(media.audioSeparator.message, 600)
      },
      videoEngine: {
        pythonAvailable: engine.pythonAvailable,
        ready: engine.ready,
        installing: engine.installing,
        ...(engine.gpuName ? { gpuName: bounded(engine.gpuName, 200) } : {})
      },
      indexTts: {
        ready: indexTts.ready,
        state: indexTts.ready
          ? ('ready' as const)
          : indexTts.pythonPath || indexTts.modelDir
            ? ('incomplete' as const)
            : ('missing' as const)
      }
    }
  } catch {
    // 探测实现本身异常（非"依赖缺失"）：给稳定错误码，不把原始异常文本回给外部。
    refuse('ENVIRONMENT_PROBE_FAILED', 'environment-probe')
  }
}

async function videoEngineStatus(): Promise<unknown> {
  try {
    const status = await getVideoEngineStatus()
    return {
      pythonAvailable: status.pythonAvailable,
      ready: status.ready,
      installing: status.installing,
      progress: bounded(status.progress, 300),
      message: bounded(status.message, 600),
      ...(status.gpuName ? { gpuName: bounded(status.gpuName, 200) } : {})
    }
  } catch {
    refuse('ENVIRONMENT_PROBE_FAILED', 'environment-probe')
  }
}

/** dispatch 分组分支的唯一入口；operationId 已由 isSettingsOperation 收窄。 */
export function runSettingsOperation(
  operationId: SettingsOperationId,
  input: Record<string, unknown>
): Promise<unknown> | unknown {
  switch (operationId) {
    case 'model.connection.list':
      return listConnections(input)
    case 'model.definition.list':
      return listDefinitions(input)
    case 'model.binding.list':
      return listBindings(input)
    case 'model.binding.resolve':
      return resolveBinding(input)
    case 'environment.local':
      return localEnvironment()
    case 'environment.videoEngine.status':
      return videoEngineStatus()
  }
}
