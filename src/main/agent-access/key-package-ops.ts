// F9：凭据包导出/预览侧的外部实现。
//
// 唯一实现：复用 `KeyPackageService`（GUI 密钥包面板同一实例，经 keys-bridge 发布）。
// 本模块只做边界：受控目录落位、密码透传、回执去敏（不回包正文/凭证正文/完整 URL）。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { exportProviders } from '../gateway/provider-transfer'
import { keysPackageAccessPort } from './keys-bridge'
import { DesktopAccessError } from './desktop'

export const KEY_PACKAGE_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'provider.credential.export',
  'provider.package.seal',
  'provider.package.preview'
] as AccessOperationId[])

export interface KeyPackageContext {
  exportRoot: string
}

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

/** 只保留主机名：预览需要"这是哪个服务"，但完整 URL 可能是内网地址，不该外传。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host.slice(0, 120)
  } catch {
    return ''
  }
}

/** 把文本写入受控导出目录并回执指纹；目标已存在时拒绝（不覆盖）。 */
function writeControlled(
  root: string,
  fileName: string,
  text: string
): { fileName: string; sha256: string; byteSize: number } {
  const target = join(root, fileName)
  if (existsSync(target)) refuse('OUTPUT_EXISTS', fileName)
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= 0) refuse('EXPORT_FAILED', 'empty-package')
  // 排他创建：并发下也不会覆盖已有文件。
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 排他写文件需同步 fs；此处 require 与模块其余 ESM 导入并存
  const { writeFileSync, openSync, closeSync, fsyncSync } = require('node:fs') as typeof import('node:fs')
  const fd = openSync(target, 'wx')
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return {
    fileName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length
  }
}

export async function runKeyPackageOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>,
  context: KeyPackageContext
): Promise<unknown> {
  if (operationId === 'provider.package.export') {
    // 导出走 GUI 同一 exportProviders（同一加密格式）；外部只给连接 id 与密码，
    // 目标路径由 main 固定在受控导出目录内。
    const target = join(context.exportRoot, input.fileName as string)
    if (existsSync(target)) refuse('OUTPUT_EXISTS', String(input.fileName))
    // 省略 providerIds 时导出全部连接（与 GUI 同一语义）。
    const providerIds = (input.providerIds as string[] | undefined) ?? []
    const count = await exportProviders(target, input.password as string, providerIds)
    if (!existsSync(target)) refuse('EXPORT_FAILED', 'package-missing')
    const bytes = readFileSync(target)
    if (bytes.length <= 0) refuse('EXPORT_FAILED', 'package-empty')
    return {
      fileName: input.fileName as string,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
      connectionCount: Number(count ?? 0)
    }
  }

  const port = keysPackageAccessPort()
  if (!port) refuse('KEYS_SERVICE_UNAVAILABLE', 'key package service is not published in this instance')

  if (operationId === 'provider.package.seal') {
    // 接收凭证从受控目录读（不接受任意路径），再交给同一服务封包。
    const recipientFile = join(context.exportRoot, input.recipientCredentialFileName as string)
    if (!existsSync(recipientFile)) refuse('INPUT_NOT_FOUND', String(input.recipientCredentialFileName))
    const recipientCredentialText = readFileSync(recipientFile, 'utf8')
    const sealed = await port.sealKeyPackageForRecipient({
      password: input.password as string,
      recipientCredentialText,
      connectionIds: input.connectionIds as string[]
    })
    const written = writeControlled(context.exportRoot, input.fileName as string, sealed.packageText)
    return {
      ...written,
      packageId: sealed.packageId,
      connectionCount: sealed.connectionCount,
      expiresAt: Math.floor(sealed.expiresAt)
    }
  }

  // provider.package.preview：只读预览，不落库。
  const packageFile = join(context.exportRoot, input.fileName as string)
  if (!existsSync(packageFile)) refuse('INPUT_NOT_FOUND', String(input.fileName))
  const packageText = readFileSync(packageFile, 'utf8')
  const preview = await port.openKeyPackagePreview({
    packageText,
    password: input.password as string
  })
  return {
    packageId: preview.packageId,
    issuerDeviceSummary: preview.issuerDeviceSummary,
    expiresAt: Math.floor(preview.expiresAt),
    alreadyImported: preview.alreadyImported === true,
    connections: preview.connections.slice(0, 200).map((connection) => ({
      id: connection.id,
      name: String(connection.name ?? '').slice(0, 120),
      protocol: String(connection.protocol ?? '').slice(0, 60),
      modelCount: Number(connection.modelCount ?? 0),
      host: hostOf(String(connection.baseUrl ?? ''))
    }))
  }
}
