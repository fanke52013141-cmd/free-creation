import { z } from 'zod'
import { identifier } from './common'

/**
 * 供应商目录（F9 收尾）：只读投影，复用 GUI 模型设置页的同一 main 服务。
 *
 * 去敏口径与 model.connection.list 一致——**字段白名单**：
 * 只给 id / 名称 / 协议 / 模型数 / 是否有密钥 / 是否遗留档案；
 * 不返回 baseURL、鉴权头、密钥密文或密钥引用（这些都是攻击面，不是业务信息）。
 */
const providerDto = z
  .object({
    id: identifier,
    name: z.string().max(120),
    specId: z.string().max(60),
    modelCount: z.number().int().nonnegative(),
    hasApiKey: z.boolean(),
    /** true = 来自旧 providers 表的遗留档案（仅可见，不参与节点执行）。 */
    legacy: z.boolean()
  })
  .strict()

export const PROVIDER_OPERATIONS = {
  'provider.list': {
    effect: 'read',
    description:
      '分页读取供应商目录（新目录优先，旧 providers 表保留为遗留档案）；只返回 id/名称/协议/模型数/是否有密钥/是否遗留，不返回地址、鉴权头或密钥材料，不联网探测',
    input: z
      .object({
        offset: z.number().int().min(0).max(100000).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        includeLegacy: z.boolean().default(true)
      })
      .strict()
  },
  'provider.listExecutable': {
    effect: 'read',
    description:
      '只读读取**节点执行实际可用**的供应商目录（已验证接管的目录档案）；与 GUI 节点模型选择器同一来源，不返回地址或密钥，不联网探测',
    input: z.object({}).strict()
  },
  'provider.exportableConnections': {
    effect: 'read',
    description:
      '读取"可导出为凭据包"的连接清单（用于凭据包导出前的选择）；只返回连接 id/名称/协议与模型数，不返回任何密钥材料或地址',
    input: z.object({}).strict()
  }
} as const

export const PROVIDER_OUTPUTS = {
  'provider.list': z
    .object({
      items: z.array(providerDto).max(100),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      nextOffset: z.number().int().nonnegative().nullable()
    })
    .strict(),
  'provider.listExecutable': z.object({ items: z.array(providerDto).max(100) }).strict(),
  'provider.exportableConnections': z
    .object({ items: z.array(providerDto).max(200) })
    .strict()
} as const
