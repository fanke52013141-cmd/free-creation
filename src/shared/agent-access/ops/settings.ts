import { z } from 'zod'
import { ModelOperationSchema } from '@free-creation/model-contracts'
import { empty, page } from './common'

/**
 * 模型设置与环境（F9）：模型连接/定义/绑定/发现/验证/受控凭据/环境探测/节点可见集/诊断。
 *
 * 本包（F9 二）只开放**读取**类动作，并且刻意排除任何会联网、可能产生供应商费用或
 * 写凭据的动作（详见 docs/local-agent-access/36-models-env-delivery.md 第 5 节）：
 * - 不开放 models.discover / models.validate / validateAgentToolCalling（会向供应商发请求）；
 * - 不开放「保存 / 删除」连接与定义（受控凭据写入需独立凭据包与去敏契约）；
 * - 不开放 keys.* / license.*（外部不得读写密钥库或绕过授权）。
 *
 * 去敏口径是**字段白名单**而不是黑名单：连接只回 id/名称/协议/启用状态/时间，
 * 模型定义只回能力与验证状态，绑定只回 featureKey 与目标三元组。地址、鉴权头、
 * metadata、能力 controls、验证 message、密钥密文与密钥引用一律不投影。
 *
 * 新增操作的方法：在本文件的 `SETTINGS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `SETTINGS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 */
const targetId = z.string().min(1).max(200)
const featureKey = z.string().trim().min(1).max(200)
const modelOperation = ModelOperationSchema

/** GUI 节点配置里的显式模型目标格式 `provider::model`（provider 即模型连接 id）。 */
const modelKey = z
  .string()
  .trim()
  .min(3)
  .max(400)
  .regex(/^[^:]{1,200}::.+$/, 'modelKey 必须是 provider::model 形式')

const validationStatus = z.enum([
  'unverified',
  'validating',
  'verified',
  'failed',
  'unsupported'
])

export const SETTINGS_OPERATIONS = {
  'model.connection.list': {
    effect: 'read',
    description:
      '分页读取本机模型供应商连接的去敏摘要（ID/名称/协议/启用状态/时间）；字段白名单投影，不返回地址、鉴权头、密钥密文或密钥引用，不联网探测',
    input: page
  },
  'model.definition.list': {
    effect: 'read',
    description:
      '分页读取模型定义（可按 connectionId 过滤）的能力声明与验证状态；不返回能力控制参数、元数据、验证原文或密钥材料，不联网探测',
    input: page.extend({ connectionId: targetId.optional() }).strict()
  },
  'model.binding.list': {
    effect: 'read',
    description:
      '分页读取已启用的默认功能绑定（featureKey → 连接/模型/能力）；执行参数 overrides 与模型元数据不返回',
    input: page
  },
  'model.binding.resolve': {
    effect: 'read',
    description:
      '按 featureKey（可选显式 provider::model 目标）解析实际执行会用的 provider/model；复用 GUI 同一解析服务（含能力验证与密钥存在性检查），只返回去敏目标，不发起任何供应商请求',
    input: z.object({ featureKey, operation: modelOperation, modelKey: modelKey.optional() }).strict()
  },
  'environment.local': {
    effect: 'read',
    description:
      '只读探测本机媒体工具（FFmpeg/FFprobe/audio-separator）与本地推理环境（Python/GPU/IndexTTS）就绪状态；不安装、不下载、不联网，缺依赖如实报告不可用',
    input: empty
  },
  'environment.videoEngine.status': {
    effect: 'read',
    description:
      '只读读取视频引擎（本地 CUDA 推理环境，video-depth/video-clay 使用）的安装与就绪状态；不触发安装、下载或任何模型调用',
    input: empty
  }
} as const

const toolCapability = z
  .object({
    available: z.boolean(),
    /** 缺失时的可操作提示（环境变量名/PATH 说明），不含密钥或路径。 */
    message: z.string().max(600)
  })
  .strict()

const videoEngineReadiness = z
  .object({
    pythonAvailable: z.boolean(),
    ready: z.boolean(),
    installing: z.boolean(),
    gpuName: z.string().max(200).optional()
  })
  .strict()

/**
 * 本地 IndexTTS 运行时状态：只给"就绪/部分就绪/缺失"粗粒度事实。
 * 具体缺哪个解释器或模型目录由 GUI 显示——那段文案包含本机绝对路径，不能对外投影。
 */
const indexTtsReadiness = z
  .object({
    ready: z.boolean(),
    state: z.enum(['ready', 'incomplete', 'missing'])
  })
  .strict()

const connectionSummary = z
  .object({
    id: targetId,
    name: z.string().max(200),
    protocol: z.string().max(40),
    enabled: z.boolean(),
    createdAt: z.string().max(40).optional(),
    updatedAt: z.string().max(40).optional()
  })
  .strict()

const capabilitySummary = z
  .object({
    operation: modelOperation,
    asynchronous: z.boolean(),
    streaming: z.boolean(),
    acceptedAssetKinds: z.array(z.string().max(20)).max(12),
    producedAssetKinds: z.array(z.string().max(20)).max(12)
  })
  .strict()

const validationSummary = z
  .object({
    operation: modelOperation,
    status: validationStatus,
    checkedAt: z.string().max(40).optional(),
    verifiedAt: z.string().max(40).optional()
  })
  .strict()

const agentToolCallingSummary = z
  .object({
    status: validationStatus,
    checkedAt: z.string().max(40).optional(),
    verifiedAt: z.string().max(40).optional()
  })
  .strict()

const definitionSummary = z
  .object({
    id: targetId,
    connectionId: targetId,
    /** 上游供应商模型 ID（不是本机密钥或地址）。 */
    modelId: targetId,
    name: z.string().max(200),
    enabled: z.boolean(),
    connectionEnabled: z.boolean(),
    capabilitiesTruncated: z.boolean(),
    capabilities: z.array(capabilitySummary).max(32),
    validation: z.array(validationSummary).max(12),
    agentToolCalling: agentToolCallingSummary
  })
  .strict()

const bindingSummary = z
  .object({
    featureKey,
    modelDefinitionId: targetId,
    connectionId: targetId,
    modelId: targetId,
    operation: modelOperation,
    enabled: z.boolean(),
    updatedAt: z.string().max(40).optional()
  })
  .strict()

export const SETTINGS_OUTPUTS = {
  'model.connection.list': z
    .object({
      connections: z.array(connectionSummary).max(100),
      total: z.number().int().nonnegative(),
      /** 只读本地目录；本操作不发起任何供应商可达性探测。 */
      reachability: z.literal('not-probed')
    })
    .strict(),
  'model.definition.list': z
    .object({
      models: z.array(definitionSummary).max(100),
      total: z.number().int().nonnegative(),
      reachability: z.literal('not-probed')
    })
    .strict(),
  'model.binding.list': z
    .object({
      bindings: z.array(bindingSummary).max(200),
      total: z.number().int().nonnegative(),
      reachability: z.literal('not-probed')
    })
    .strict(),
  'model.binding.resolve': z
    .object({
      featureKey,
      /** 模型连接 id（与 GUI 同一解析服务返回的 providerId 一致）。 */
      providerId: targetId,
      modelId: targetId,
      operation: modelOperation,
      modelKey: z.string().min(3).max(400),
      /** 本次解析来源：显式节点目标优先，其次默认功能绑定（与 GUI 执行器同一优先级）。 */
      resolvedFrom: z.enum(['explicit-target', 'feature-binding'])
    })
    .strict(),
  'environment.local': z
    .object({
      ffmpeg: toolCapability,
      ffprobe: toolCapability,
      audioSeparator: toolCapability,
      videoEngine: videoEngineReadiness,
      indexTts: indexTtsReadiness
    })
    .strict(),
  'environment.videoEngine.status': z
    .object({
      pythonAvailable: z.boolean(),
      ready: z.boolean(),
      installing: z.boolean(),
      progress: z.string().max(300),
      message: z.string().max(600),
      gpuName: z.string().max(200).optional()
    })
    .strict()
} as const
