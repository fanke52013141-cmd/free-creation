// F9 收尾：供应商目录只读投影。
//
// 唯一实现：复用 `providers.repo` 的 listProviders / listVerifiedProviders（GUI 模型设置页
// 与节点模型选择器的同一来源），本模块只做**字段白名单投影**：不返回 baseURL、鉴权头、
// 密钥密文或密钥引用。
import type { ProviderSummary } from '../../shared/types'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { getProvider, listProviders, listVerifiedProviders } from '../gateway/providers.repo'
import { DesktopAccessError } from './desktop'

export const PROVIDER_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'provider.list',
  'provider.listExecutable',
  'provider.exportableConnections'
] as AccessOperationId[])

function dto(provider: ProviderSummary, legacy: boolean): {
  id: string
  name: string
  specId: string
  modelCount: number
  hasApiKey: boolean
  legacy: boolean
} {
  return {
    id: String(provider.id),
    name: String(provider.name ?? '').slice(0, 120),
    specId: String(provider.specId ?? ''),
    modelCount: Array.isArray(provider.models) ? provider.models.length : 0,
    hasApiKey: provider.hasApiKey === true,
    legacy
  }
}

/**
 * 目录摘要 + `hasApiKey` 校正。
 *
 * 为什么需要校正：`providers.repo.toSummary()` 用 `decryptSecret(api_key_ref)` 判断是否有密钥，
 * 但 P2 起密钥写进设备绑定 vault、`api_key_ref` 是 `vault:provider:<id>` 指针 →
 * **明明有密钥却报 false**（既有缺陷）。这里以 `getProvider()`（能正确解 vault 指针）为准，
 * 让外部看到的"是否有密钥"是真实的，避免 Agent 误判后重复写入凭据。
 */
async function toDtoVerified(
  provider: ProviderSummary,
  legacy = false
): Promise<{
  id: string
  name: string
  specId: string
  modelCount: number
  hasApiKey: boolean
  legacy: boolean
}> {
  const base = dto(provider, legacy)
  if (base.hasApiKey) return base
  try {
    const verified = await getProvider(base.id)
    return { ...base, hasApiKey: Boolean(verified?.apiKey) }
  } catch {
    return base
  }
}

export async function runProviderOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>
): Promise<unknown> {
  if (operationId === 'provider.listExecutable') {
    const providers = await listVerifiedProviders()
    return { items: await Promise.all(providers.slice(0, 100).map((provider) => toDtoVerified(provider, false))) }
  }
  if (operationId === 'provider.exportableConnections') {
    const providers = await listVerifiedProviders()
    return { items: await Promise.all(providers.slice(0, 200).map((provider) => toDtoVerified(provider, false))) }
  }
  // provider.list：新目录 + 遗留档案合并（与 GUI 同一 listProviders 语义）。
  const includeLegacy = input.includeLegacy !== false
  const offset = Number(input.offset ?? 0)
  const limit = Number(input.limit ?? 50)
  const verified = await listVerifiedProviders()
  const verifiedIds = new Set(verified.map((provider) => String(provider.id)))
  const all = includeLegacy ? await listProviders() : verified
  if (!Array.isArray(all)) throw new DesktopAccessError('PROVIDER_CATALOG_FAILED', false)
  const items = await Promise.all(
    all.map((provider) => toDtoVerified(provider, !verifiedIds.has(String(provider.id))))
  )
  const page = items.slice(offset, offset + limit)
  return {
    items: page,
    total: items.length,
    offset,
    limit,
    nextOffset: offset + page.length < items.length ? offset + page.length : null
  }
}
