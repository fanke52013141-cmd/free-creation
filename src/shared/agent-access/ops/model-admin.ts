import { z } from 'zod'
import {
  CapabilitySchema,
  ConnectionProtocolSchema,
  JsonValueSchema,
  ModelOperationSchema
} from '@free-creation/model-contracts'
import { identifier } from './common'

/**
 * 模型连接与受控凭据写入（F9）。
 *
 * 安全口径（AGENT_PARITY_SPEC §6）：
 * - 凭据只能**受控写入**：复用 GUI 的 `SqliteModelHost.saveConnection`（设备绑定密钥库 +
 *   授权守卫），明文既不回传也不进日志/诊断；回执只给"是否存在 + 不可逆指纹"。
 * - 不允许外部公开明文、读取明文、绕过密钥库或授权；`model.discover`/`model.validate`
 *   这类会向供应商发请求的动作**不在此开放**（需独立网络/预算授权），因此外部也无法
 *   "自己把模型验证成已通过"——功能绑定仍只能在已通过验证的模型上成立（宿主强制）。
 * - 删除是显式的破坏性动作：删连接会连同其模型定义一起删，回执给出被删模型数。
 */
const connectionId = identifier
const definitionId = identifier
const baseUrl = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .regex(/^https?:\/\//i, 'baseUrl 必须是 http(s) 地址')
const apiKey = z.string().min(1).max(4096)
const secretSummary = z
  .object({
    present: z.boolean(),
    /** 明文绝不回传：只给 sha256 前 12 位十六进制，用于"我设置的密钥是否在库"的核对。 */
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{12}$/)
      .optional(),
    algorithm: z.literal('sha256:12').optional()
  })
  .strict()

export const MODEL_ADMIN_OPERATIONS = {
  'model.connection.save': {
    effect: 'write',
    description:
      '创建或更新模型供应商连接；可选写入 API Key（写入设备绑定密钥库，明文不回传、不进日志）。连接协议/地址/头或密钥发生变化会清除该连接的模型验证与功能绑定，回执如实标记',
    input: z
      .object({
        id: connectionId,
        name: z.string().trim().min(1).max(120),
        protocol: ConnectionProtocolSchema,
        baseUrl,
        apiKey: apiKey.optional(),
        headers: z.record(z.string(), z.string().max(2000)).optional(),
        metadata: JsonValueSchema.optional(),
        enabled: z.boolean().optional()
      })
      .strict()
  },
  'model.credential.status': {
    effect: 'read',
    description:
      '查询某个连接是否已保存 API Key：只返回是否存在与不可逆指纹，不返回明文、不返回端点或请求头',
    input: z.object({ connectionId }).strict()
  },
  'model.connection.delete': {
    effect: 'delete',
    description:
      '删除模型供应商连接及其下所有模型定义（连带清理验证与功能绑定）；连接不存在如实 NOT_FOUND',
    input: z.object({ connectionId }).strict()
  },
  'model.definition.save': {
    effect: 'write',
    description:
      '创建或更新模型定义（必须绑定既有连接，能力声明非空）；不涉及凭据；能力变化会清除对应验证与绑定',
    input: z
      .object({
        id: definitionId,
        connectionId,
        name: z.string().trim().min(1).max(120),
        modelId: z.string().trim().min(1).max(200),
        capabilities: z.array(CapabilitySchema).min(1).max(16),
        metadata: JsonValueSchema.optional(),
        enabled: z.boolean().optional()
      })
      .strict()
  },
  'model.definition.delete': {
    effect: 'write',
    description: '删除单个模型定义（连带清理其验证、工具调用验证与功能绑定）；不存在如实 NOT_FOUND',
    input: z.object({ id: definitionId }).strict()
  },
  'model.binding.save': {
    effect: 'write',
    description:
      '保存功能默认绑定（featureKey + 连接 + 模型定义 + 操作）。**只有该模型该操作已通过验证才成立**：外部无法自行验证模型，因此未验证一律拒绝，不伪造"已绑定可用"',
    input: z
      .object({
        featureKey: z.string().trim().min(1).max(200),
        connectionId,
        modelDefinitionId: definitionId,
        operation: ModelOperationSchema,
        enabled: z.boolean().optional(),
        overrides: z.record(z.string(), JsonValueSchema).optional()
      })
      .strict()
  }
} as const

export const MODEL_ADMIN_OUTPUTS = {
  'model.connection.save': z
    .object({
      id: connectionId,
      name: z.string().max(120),
      protocol: ConnectionProtocolSchema,
      enabled: z.boolean(),
      /** 仅回端点主机名：能核对"改的是哪台"，又不会把查询串/凭据带出去。 */
      baseUrlHost: z.string().max(200),
      secret: secretSummary,
      /** true = 本次保存改变了连接事实，宿主的验证与功能绑定已被清除。 */
      invalidatedBindings: z.boolean()
    })
    .strict(),
  'model.credential.status': z
    .object({ connectionId, secret: secretSummary })
    .strict(),
  'model.connection.delete': z
    .object({ connectionId, deleted: z.literal(true), deletedModels: z.number().int().nonnegative() })
    .strict(),
  'model.definition.save': z
    .object({
      id: definitionId,
      connectionId,
      name: z.string().max(120),
      modelId: z.string().max(200),
      enabled: z.boolean(),
      operations: z.array(ModelOperationSchema).max(16)
    })
    .strict(),
  'model.definition.delete': z.object({ id: definitionId, deleted: z.literal(true) }).strict(),
  'model.binding.save': z
    .object({
      featureKey: z.string().max(200),
      connectionId,
      modelDefinitionId: definitionId,
      operation: ModelOperationSchema,
      enabled: z.boolean()
    })
    .strict()
} as const
