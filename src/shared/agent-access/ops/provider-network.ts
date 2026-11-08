import { z } from 'zod'
import { identifier } from './common'

/**
 * 供应商连通性与模型验证（F9，需要联网；用户已授权"显式确认才执行"）。
 *
 * 统一安全契约：
 * - **默认不执行**：必须显式传 `confirmNetwork: true`，否则直接拒绝（NETWORK_CONFIRM_REQUIRED），
 *   绝不因为"调用方忘了传"就顺手发一个请求出去；
 * - 外部**不提供密钥、地址或鉴权头**：只给已保存的 id，密钥由 main 从设备密钥库取；
 * - `validate` 会真实调用模型（可能计费），故额外要求 `confirmCost: true`；
 * - 回执只给结论与去敏文案，不含请求报文、响应正文或密钥。
 */
export const PROVIDER_NETWORK_OPERATIONS = {
  'provider.testConnection': {
    effect: 'write',
    description:
      '测试已保存供应商连接是否可用（向供应商 /models 发一次请求）；必须显式 confirmNetwork=true 才执行，否则拒绝且不发任何请求；外部只给供应商 id，密钥与地址由 main 从设备密钥库读取；回执只给可用性与模型数量',
    input: z
      .object({
        providerId: identifier,
        confirmNetwork: z.boolean().default(false)
      })
      .strict()
  },
  'model.validate': {
    effect: 'write',
    description:
      '对某个模型定义做真实能力验证（会向供应商发起真实请求、**可能产生费用**）；必须同时显式 confirmNetwork=true 与 confirmCost=true 才执行，否则拒绝且不发任何请求；外部只给连接与模型定义 id，不提供密钥',
    input: z
      .object({
        connectionId: identifier,
        modelDefinitionId: identifier,
        operation: z.string().min(1).max(60),
        confirmNetwork: z.boolean().optional(),
        confirmCost: z.boolean().optional()
      })
      .strict()
  },
  'model.discover': {
    effect: 'write',
    description:
      '拉取某个已保存连接在供应商侧的可用模型列表（与 GUI「拉取可用模型」同一实现：同一端点绑定校验、同一诊断事件）；会向供应商发请求，必须显式 confirmNetwork=true 才执行；外部只给 connectionId，不提供密钥或地址',
    input: z.object({ connectionId: identifier, confirmNetwork: z.boolean().optional() }).strict()
  },
  'model.validateAgentToolCalling': {
    effect: 'write',
    description:
      '验证某个文本模型是否支持 Agent 强制结构化工具调用与工具结果往返（与 GUI「验证 Agent 工具调用」同一实现）；会向供应商发真实请求、**可能产生费用**，必须同时显式 confirmNetwork=true 与 confirmCost=true；结果写入该模型的工具调用验证快照',
    input: z
      .object({
        connectionId: identifier,
        modelDefinitionId: identifier,
        confirmNetwork: z.boolean().optional(),
        confirmCost: z.boolean().optional()
      })
      .strict()
  }
} as const

export const PROVIDER_NETWORK_OUTPUTS = {
  'provider.testConnection': z
    .object({
      providerId: identifier,
      reachable: z.boolean(),
      modelCount: z.number().int().nonnegative(),
      /** 已去敏的结论文案（不含地址、密钥或响应正文）。 */
      message: z.string().max(400)
    })
    .strict(),
  'model.validate': z
    .object({
      connectionId: identifier,
      modelDefinitionId: identifier,
      operation: z.string().max(60),
      status: z.enum(['verified', 'failed', 'pending']),
      message: z.string().max(400)
    })
    .strict(),
  'model.discover': z
    .object({
      connectionId: identifier,
      models: z
        .array(z.object({ id: z.string().max(200), name: z.string().max(200) }).strict())
        .max(500),
      total: z.number().int().nonnegative()
    })
    .strict(),
  'model.validateAgentToolCalling': z
    .object({
      connectionId: identifier,
      modelDefinitionId: identifier,
      status: z.enum(['verified', 'failed']),
      message: z.string().max(400),
      action: z.string().max(200).optional(),
      checkedAt: z.string().max(60)
    })
    .strict()
} as const
