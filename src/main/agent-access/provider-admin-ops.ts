// F9 收尾：供应商管理 + 凭据包导入 + 即梦设备流登录的外部实现。
//
// 唯一实现：复用 GUI 同一批函数——providers.repo.saveProvider/deleteProvider/getProvider、
// provider-check.probeProvider、KeyPackageService.applyKeyPackageImport（经 keys-bridge）、
// provider-transfer.importProviders、dreamina-cli.startDreaminaLogin/checkDreaminaLogin。
// 本模块只做边界：确认闸门、人工确认、去敏回执。
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  deleteProvider,
  getProvider,
  saveProvider
} from '../gateway/providers.repo'
import { probeProvider } from '../gateway/provider-check'
import { importProviders } from '../gateway/provider-transfer'
import { checkDreaminaLogin, logoutDreamina, startDreaminaLogin } from '../gateway/dreamina-cli'
import { keysPackageAccessPort } from './keys-bridge'
import { DesktopAccessError, type AccessDesktop } from './desktop'

export const PROVIDER_ADMIN_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'provider.save',
  'provider.delete',
  'provider.probe',
  'provider.package.import',
  'provider.package.importProviders',
  'dreamina.logout', 'dreamina.login.start',
  'dreamina.login.check'
] as AccessOperationId[])

export interface ProviderAdminContext {
  exportRoot: string
  activeProjectId: () => string | null
  desktop?: AccessDesktop
}

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

/** 文案去敏：抹协议 URL、域名/IP 与常见密钥形态（供应商错误里常夹带地址）。 */
function safeMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : ''
  return String(text ?? '')
    .replace(/https?:\/\/[^\s)"']+/gi, '[地址]')
    .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b(:\d+)?/gi, '[地址]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[密钥]')
    .slice(0, 600)
}

/**
 * 让人在 GUI 上确认一次敏感动作。没有打开的画布时无法弹确认（桌面请求绑定到当前画布），
 * 此时如实拒绝而不是悄悄放行。
 */
async function requireHumanConfirmation(
  context: ProviderAdminContext,
  title: string,
  message: string,
  confirmText: string
): Promise<void> {
  const projectId = context.activeProjectId()
  if (!projectId) refuse('ACTIVE_PROJECT_REQUIRED', 'open a project first: confirmation needs the canvas')
  if (!context.desktop) refuse('DESKTOP_UNAVAILABLE', 'authoritative host is not running')
  const reply = await context.desktop.ask(
    {
      action: 'confirm-sensitive',
      projectId,
      confirmTitle: title,
      confirmMessage: message,
      confirmText,
      cancelText: '拒绝'
    } as never,
    5 * 60 * 1000
  )
  if (!reply.authorized) refuse('HUMAN_DENIED', 'the user rejected this action in the GUI')
}

export async function runProviderAdminOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>,
  context: ProviderAdminContext
): Promise<unknown> {
  if (operationId === 'provider.save') {
    const id = (input.id as string | undefined) ?? `acc-${Date.now().toString(36)}`
    const saved = await saveProvider({
      id,
      name: input.name as string,
      specId: input.specId as never,
      baseURL: input.baseUrl as string,
      ...(typeof input.apiKey === 'string' ? { apiKey: input.apiKey } : {}),
      models: ((input.models as Array<{ id: string; name?: string }> | undefined) ?? []).map(
        (model) => ({ id: model.id, name: model.name ?? model.id, modality: 'text' })
      ) as never
    })
    // hasApiKey 以 getProvider 为准：P2 起密钥写入设备绑定 vault，
    // 旧逻辑用 decryptSecret(api_key_ref) 判断会把「vault: 指针」误判成没有密钥
    // （providers.repo 的 toSummary 仍按旧逻辑，属既有缺陷，本操作如实修正）。
    const verified = await getProvider(id)
    return {
      id: String(saved.id),
      name: String(verified?.name ?? saved.name ?? '').slice(0, 120),
      specId: String(verified?.specId ?? saved.specId ?? ''),
      modelCount: Array.isArray(verified?.models) ? verified.models.length : 0,
      hasApiKey: Boolean(verified?.apiKey)
    }
  }

  if (operationId === 'provider.delete') {
    const id = input.id as string
    const existing = await getProvider(id)
    if (!existing) refuse('NOT_FOUND', id)
    const removed = await deleteProvider(id)
    if (!removed) refuse('NOT_FOUND', id)
    return { id, deleted: true as const }
  }

  if (operationId === 'provider.probe') {
    if (input.confirmNetwork !== true)
      refuse('NETWORK_CONFIRM_REQUIRED', 'pass confirmNetwork: true to allow supplier requests')
    const providerId = input.providerId as string
    const provider = await getProvider(providerId)
    if (!provider) refuse('NOT_FOUND', providerId)
    // 只对已保存供应商探测：外部无法借这里探测任意地址；allowCost 恒 false（不发起计费调用）。
    const result = await probeProvider({
      id: provider.id,
      name: provider.name,
      specId: provider.specId as never,
      baseURL: provider.baseURL,
      models: provider.models as never,
      allowCost: false
    } as never)
    const items = (result?.items ?? []).slice(0, 100).map((item) => ({
      id: String(item.id ?? '').slice(0, 120),
      label: String(item.label ?? '').slice(0, 200),
      outcome: String(item.probe ?? 'unknown').slice(0, 60),
      ...(item.cost ? { cost: String(item.cost).slice(0, 20) } : {})
    }))
    // 空结果必须说清楚：分不清"探测通过但无项目"和"该供应商根本不支持探测"会让调用方误判。
    const summary = items.length
      ? safeMessage(result?.summary ?? '')
      : '该供应商没有可用的免费探测项（未发起任何请求）；如需验证可用性请用 provider.testConnection 或 model.validate'
    return { providerId, probeSupported: items.length > 0, summary, items }
  }

  if (operationId === 'provider.package.import') {
    if (input.confirmImport !== true)
      refuse('IMPORT_CONFIRM_REQUIRED', 'pass confirmImport: true (a human must still approve in the GUI)')
    const port = keysPackageAccessPort()
    if (!port) refuse('KEYS_SERVICE_UNAVAILABLE', 'key package service is not published')
    const fileName = input.fileName as string
    const target = join(context.exportRoot, fileName)
    if (!existsSync(target)) refuse('INPUT_NOT_FOUND', fileName)
    const packageText = readFileSync(target, 'utf8')
    // 先预览并让**人**确认，确认后才真正落库。
    // 预览失败必须给稳定码：否则写操作在"已准入但宿主抛错"时会落到 unknown，
    // 调用方无法区分"没发生"和"不确定"。
    let preview: Awaited<ReturnType<typeof port.openKeyPackagePreview>>
    try {
      preview = await port.openKeyPackagePreview({
        packageText,
        password: input.password as string
      })
    } catch (error) {
      refuse('PACKAGE_INVALID', safeMessage(error))
    }
    await requireHumanConfirmation(
      context,
      '外部请求导入凭据包',
      `外部 Agent 请求导入凭据包「${preview.packageId}」（签发设备：${preview.issuerDeviceSummary}，` +
        `包含 ${preview.connections.length} 个连接${preview.alreadyImported ? '，此前已导入过' : ''}）。` +
        '只有你点「允许导入」才会解密并写入本机连接。',
      '允许导入'
    )
    let applied: Awaited<ReturnType<typeof port.applyKeyPackageImport>>
    try {
      applied = await port.applyKeyPackageImport({
        packageText,
        password: input.password as string,
        overwriteConfirmed: true
      })
    } catch (error) {
      refuse('PACKAGE_IMPORT_FAILED', safeMessage(error))
    }
    return {
      packageId: String(applied.packageId).slice(0, 200),
      added: Number(applied.added ?? 0),
      updated: Number(applied.updated ?? 0),
      modelCount: Number(applied.modelCount ?? 0),
      humanConfirmed: true as const
    }
  }

  if (operationId === 'provider.package.importProviders') {
    if (input.confirmImport !== true)
      refuse('IMPORT_CONFIRM_REQUIRED', 'pass confirmImport: true (a human must still approve in the GUI)')
    const fileName = input.fileName as string
    const target = join(context.exportRoot, fileName)
    if (!existsSync(target)) refuse('INPUT_NOT_FOUND', fileName)
    await requireHumanConfirmation(
      context,
      '外部请求导入供应商包',
      `外部 Agent 请求导入旧版供应商包「${fileName}」。只有你点「允许导入」才会写入本机连接。`,
      '允许导入'
    )
    const imported = await importProviders(target, input.password as string)
    return { imported: Number(imported ?? 0), humanConfirmed: true as const }
  }

  if (operationId === 'dreamina.logout') {
    if (input.confirmLogout !== true)
      refuse('LOGOUT_CONFIRM_REQUIRED', 'pass confirmLogout: true to clear the local Dreamina session')
    return logoutDreamina()
  }

  if (operationId === 'dreamina.login.start') {
    if (input.confirmNetwork !== true)
      refuse('NETWORK_CONFIRM_REQUIRED', 'pass confirmNetwork: true to request a device login code')
    const material = await startDreaminaLogin()
    // 绝不伪造：already/pending/failed 一律照实返回，成功与否由人是否完成浏览器授权决定。
    return {
      status: material.status,
      ...(material.verificationUri ? { verificationUri: String(material.verificationUri).slice(0, 400) } : {}),
      ...(material.userCode ? { userCode: String(material.userCode).slice(0, 80) } : {}),
      ...(material.deviceCode ? { deviceCode: String(material.deviceCode).slice(0, 400) } : {}),
      ...(material.expiresAt ? { expiresAt: String(material.expiresAt).slice(0, 60) } : {}),
      message: safeMessage(material.message ?? '')
    }
  }

  // dreamina.login.check
  if (input.confirmNetwork !== true)
    refuse('NETWORK_CONFIRM_REQUIRED', 'pass confirmNetwork: true to query the login state')
  const result = await checkDreaminaLogin(input.deviceCode as string)
  return { status: result.status, message: safeMessage(result.message ?? '') }
}
