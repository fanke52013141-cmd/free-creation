import { z } from 'zod'
import { identifier } from './common'

/**
 * 凭据包（F9 收尾）：导出/预览侧。用户已确认"允许导出与预览到受控目录；导入必须人工确认"。
 *
 * 安全口径：
 * - 密码由调用方提供（它是用户为这个包设的解封密码，不是设备密钥）；
 * - **回执不返回包正文**：只写到受控目录并给文件名 + sha256 + 字节数 + 包 ID/连接数；
 * - 接收凭证文本同样只落受控目录，不回传正文（避免经由 MCP 报文把凭证扩散到日志/历史）；
 * - 未发布凭据包服务（未激活/无 vault）时如实拒绝。
 */
const password = z.string().min(1).max(200)
const fileName = z.string().regex(/^[a-zA-Z0-9_-]{1,100}\.[a-z]{2,10}$/)

export const KEY_PACKAGE_OPERATIONS = {
  'provider.package.export': {
    effect: 'export',
    description:
      '把选定的供应商连接导出为凭据包（.cskeys）到受控导出目录（复用 GUI 同一 exportProviders 与加密格式）：需要解封密码；回执给文件名/sha256/字节数/连接数，不回传包正文',
    input: z
      .object({
        fileName,
        password,
        /** 省略=导出全部连接；显式给出时必须全部存在。 */
        providerIds: z.array(identifier).min(1).max(200).optional()
      })
      .strict()
  },
  'provider.package.seal': {
    effect: 'export',
    description:
      '把选定的已保存连接封成凭据包（.cskeys）写入受控导出目录：需要解封密码与接收设备的凭证文件名（服务端从受控目录读取，不接受任意路径）；回执给文件名/sha256/字节数/包ID/连接数/到期时间，不回传包正文',
    input: z
      .object({
        fileName,
        password,
        recipientCredentialFileName: fileName,
        connectionIds: z.array(identifier).min(1).max(200)
      })
      .strict()
  },
  'provider.package.preview': {
    effect: 'read',
    description:
      '预览受控目录内的凭据包（只读，不解密落库）：需要解封密码；返回包 ID/签发设备摘要/到期/连接清单/是否已导入，不含任何密钥材料',
    input: z.object({ fileName, password }).strict()
  }
} as const

const exportedFile = {
  fileName: z.string().max(160),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive()
}

export const KEY_PACKAGE_OUTPUTS = {
  'provider.package.export': z
    .object({
      ...exportedFile,
      connectionCount: z.number().int().nonnegative()
    })
    .strict(),
  'provider.package.seal': z
    .object({
      ...exportedFile,
      packageId: z.string().max(200),
      connectionCount: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative()
    })
    .strict(),
  'provider.package.preview': z
    .object({
      packageId: z.string().max(200),
      issuerDeviceSummary: z.string().max(200),
      expiresAt: z.number().int().nonnegative(),
      alreadyImported: z.boolean(),
      connections: z
        .array(
          z
            .object({
              id: identifier,
              name: z.string().max(120),
              protocol: z.string().max(60),
              modelCount: z.number().int().nonnegative(),
              /** 只暴露主机名，不暴露完整 URL（预览用于判断"这是哪台/哪个服务"）。 */
              host: z.string().max(120)
            })
            .strict()
        )
        .max(200)
    })
    .strict()
} as const
