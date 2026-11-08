import { z } from 'zod'
import { identifier } from './common'

/**
 * 供应商管理与凭据包导入（F9 收尾，用户已授权"导入必须人工确认"）。
 *
 * 安全口径：
 * - `provider.save` 只接受密钥**明文入参**（与 GUI 设置页一致），但**回执永不回显密钥**；
 * - `provider.delete` / `provider.probe` 只作用于已保存供应商；
 * - `provider.probe` 需要显式 confirmNetwork（会向供应商发请求）；
 * - 两个导入操作必须 `confirmImport: true`，并且会在 GUI 弹出**人工确认框**，
 *   只有人点「允许导入」才真正落库（外部不能自己给自己确认）；
 * - `dreamina.login.*` 只发起/查询设备流登录，**绝不伪造登录成功**。
 */
const password = z.string().min(1).max(200)
const fileName = z.string().regex(/^[a-zA-Z0-9_-]{1,100}\.[a-z]{2,10}$/)

export const PROVIDER_ADMIN_OPERATIONS = {
  'provider.save': {
    effect: 'write',
    description:
      '新建或更新供应商连接（与 GUI 设置页同一 saveProvider）：id 缺省=新建；更新时 apiKey 留空表示保留已保存密钥；回执只给 id/名称/协议/模型数/是否有密钥，**不回显密钥**',
    input: z
      .object({
        id: identifier.optional(),
        name: z.string().trim().min(1).max(120),
        specId: z.string().min(1).max(60),
        baseUrl: z.string().trim().min(1).max(500),
        apiKey: z.string().min(1).max(400).optional(),
        models: z
          .array(z.object({ id: z.string().min(1).max(200), name: z.string().max(200).optional() }).strict())
          .max(200)
          .optional()
      })
      .strict()
  },
  'provider.delete': {
    effect: 'delete',
    description: '删除已保存的供应商连接；不存在时如实 NOT_FOUND，不静默成功',
    input: z.object({ id: identifier }).strict()
  },
  'provider.probe': {
    effect: 'write',
    description:
      '对**已保存**的供应商做连通性探测（复用 GUI 同一 probeProvider）：只做免费/只读探测，不发起计费调用；必须显式 confirmNetwork=true；外部只给 providerId，密钥由 main 读取',
    input: z.object({ providerId: identifier, confirmNetwork: z.boolean().optional() }).strict()
  },
  'provider.package.import': {
    effect: 'write',
    description:
      '导入受控目录内的凭据包（.cskeys）：必须显式 confirmImport=true，并会在 GUI 弹人工确认框；只有人点允许才解密并写入连接，回执给包ID/新增/更新/模型数，不含密钥',
    input: z.object({ fileName, password, confirmImport: z.boolean().optional() }).strict()
  },
  'provider.package.importProviders': {
    effect: 'write',
    description:
      '导入受控目录内的旧版供应商包（.cskeys 旧格式）：必须显式 confirmImport=true，并会在 GUI 弹人工确认框；只有人点允许才写入，回执给新增数量，不含密钥',
    input: z.object({ fileName, password, confirmImport: z.boolean().optional() }).strict()
  },
  'dreamina.login.start': {
    effect: 'write',
    description:
      '发起即梦（Dreamina）设备流登录：返回需要在浏览器打开的验证地址与用户码；若本机已有有效登录则直接返回 already。**不伪造登录状态**，登录必须由人完成；需 confirmNetwork=true',
    input: z.object({ confirmNetwork: z.boolean().optional() }).strict()
  },
  'dreamina.login.check': {
    effect: 'write',
    description:
      '查询即梦设备流登录结果（pending/success/expired/failed）；只如实反映本机 CLI 的真实状态，成功与否由人是否真的在浏览器完成授权决定；需 confirmNetwork=true',
    input: z.object({ deviceCode: z.string().min(1).max(400), confirmNetwork: z.boolean().optional() }).strict()
  }
} as const

const providerSummary = z
  .object({
    id: identifier,
    name: z.string().max(120),
    specId: z.string().max(60),
    modelCount: z.number().int().nonnegative(),
    hasApiKey: z.boolean()
  })
  .strict()

export const PROVIDER_ADMIN_OUTPUTS = {
  'provider.save': providerSummary,
  'provider.delete': z.object({ id: identifier, deleted: z.literal(true) }).strict(),
  'provider.probe': z
    .object({
      providerId: identifier,
      /** false = 该供应商没有可用的免费探测项（未发起任何请求），并不代表"探测通过"。 */
      probeSupported: z.boolean(),
      /** 汇总文案（已去敏，不含地址与密钥）。 */
      summary: z.string().max(600),
      items: z
        .array(
          z
            .object({
              id: z.string().max(120),
              label: z.string().max(200),
              outcome: z.string().max(60),
              cost: z.string().max(20).optional()
            })
            .strict()
        )
        .max(100)
    })
    .strict(),
  'provider.package.import': z
    .object({
      packageId: z.string().max(200),
      added: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      modelCount: z.number().int().nonnegative(),
      /** 人工确认确实是本次导入的放行条件。 */
      humanConfirmed: z.literal(true)
    })
    .strict(),
  'provider.package.importProviders': z
    .object({
      imported: z.number().int().nonnegative(),
      humanConfirmed: z.literal(true)
    })
    .strict(),
  'dreamina.login.start': z
    .object({
      status: z.enum(['already', 'pending', 'failed']),
      verificationUri: z.string().max(400).optional(),
      userCode: z.string().max(80).optional(),
      deviceCode: z.string().max(400).optional(),
      expiresAt: z.string().max(60).optional(),
      message: z.string().max(600)
    })
    .strict(),
  'dreamina.login.check': z
    .object({
      status: z.enum(['pending', 'success', 'expired', 'failed']),
      message: z.string().max(600)
    })
    .strict()
} as const
