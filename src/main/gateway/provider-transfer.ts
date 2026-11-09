import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import type { GatewayModelInfo, ProviderConfig } from '../../shared/types'
import { PROVIDER_SPECS } from '../../shared/types'
import { getDb } from '../store/db'
import { getProvider, bootstrapLegacyProvidersToCatalog } from './providers.repo'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { assertLicenseActive, licenseSnapshot } from '../security/license/gate'
import { DISTRIBUTION_EDITION } from '../../shared/edition'
import { getActiveVault } from '../security/keystore/vault'
import { encryptSecret, vaultRef } from './keycrypto'

function originOfSafe(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.protocol}//${url.host}`
  } catch {
    return 'unknown'
  }
}

/**
 * 供应商配置传输（密码保护文件）。
 *
 * 用途：把发放员/运营方机器上的供应商配置（含 API Key）以密码加密文件交给
 * 发行版（免授权直发版）用户导入——两种模式都开放导出，发行版开放导入。
 * 授权版的使用者（仅 app.run 能力）不开放此通道（P2 §4.3：使用者无复制带 Key
 * 配置的路径）；发放员（credentials.export）与发行版可用。
 *
 * 与 P2 密钥包（.cskeys v2，绑定接收设备）的关系：直发版没有设备身份体系，
 * 密码保护文件是其唯一可行的接收通道；安全性等同「密码 + 你选择的交付渠道」。
 */

/** 授权版门控：使用者拒绝；发放员与发行版放行。 */
/**
 * 配置传输的权限判定。
 *
 * **导入与导出不是同一种权限**（2026-11-09 修正）：
 * - 导出 = 把本机密钥发给别人 → 需要 `credentials.export`（只有发放员/发行版具备）；
 * - 导入 = 接收别人给的配置，等价于手工填写密钥 → 只要求**授权有效且已激活**，
 *   不应要求 `credentials.export`。此前两者共用同一判定，导致普通已激活设备
 *   永远导不进自己之前导出的文件（用户实际遇到的故障）。
 */
function ensureTransferAllowed(operation: 'provider.export' | 'provider.import'): void {
  assertLicenseActive(operation)
  if (DISTRIBUTION_EDITION) return
  if (operation === 'provider.import') return
  const snapshot = licenseSnapshot()
  if (snapshot.state !== 'active' || !snapshot.capabilities.includes('credentials.export')) {
    throw new Error('当前授权不具备配置导出能力（credentials.export）')
  }
}

const FORMAT = 'canvas-studio-providers'
const VERSION = 1
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_PROVIDERS = 500
const MAX_MODELS_PER_PROVIDER = 2000
const AAD = Buffer.from(`${FORMAT}:${VERSION}`, 'utf8')

interface ProviderTransferEnvelope {
  format: typeof FORMAT
  version: typeof VERSION
  kdf: 'scrypt'
  cipher: 'aes-256-gcm'
  salt: string
  iv: string
  authTag: string
  ciphertext: string
}

interface PortableProvider {
  id: string
  name: string
  specId: ProviderConfig['specId']
  baseURL: string
  apiKey: string
  models: GatewayModelInfo[]
}

interface ProviderTransferPayload {
  format: typeof FORMAT
  version: typeof VERSION
  exportedAt: number
  providers: PortableProvider[]
}

function deriveKey(password: string, salt: Buffer): Buffer {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
    throw new Error('加密密码至少需要 8 个字符')
  }
  return scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

async function exportableProviders(providerIds: string[]): Promise<PortableProvider[]> {
  if (
    !Array.isArray(providerIds) ||
    !providerIds.length ||
    providerIds.length > MAX_PROVIDERS ||
    providerIds.some((id) => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) ||
    new Set(providerIds).size !== providerIds.length
  )
    throw new Error('请选择需要导出的供应商')
  const providers = await Promise.all(providerIds.map((id) => getProvider(id)))
  if (providers.some((provider) => !provider)) throw new Error('所选供应商不可用，请刷新列表后重试')
  const selected = providers as ProviderConfig[]
  const missingKeys = selected.filter((provider) => !provider.apiKey)
  if (missingKeys.length) {
    throw new Error(
      `这些供应商的 API Key 当前无法读取，请先重新填写密钥：${missingKeys.map((p) => p.name).join('、')}`
    )
  }
  return selected.map(({ id, name, specId, baseURL, apiKey, models }) => ({
    id,
    name,
    specId,
    baseURL,
    apiKey,
    models
  }))
}

/** Export supplier IDs, endpoints, model selections and API Keys into a password-encrypted file. */
export async function exportProviders(filePath: string, password: string, providerIds: string[]): Promise<number> {
  ensureTransferAllowed('provider.export')
  const providers = await exportableProviders(providerIds)
  const payload: ProviderTransferPayload = {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    providers
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const envelope: ProviderTransferEnvelope = {
    format: FORMAT,
    version: VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
  writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8')
  return providers.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('供应商配置文件格式无效')
  }
  const decoded = Buffer.from(value, 'base64')
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new Error('供应商配置文件格式无效')
  }
  return decoded
}

function parseModels(value: unknown, providerName: string): GatewayModelInfo[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS_PER_PROVIDER) {
    throw new Error(`供应商「${providerName}」的模型列表无效`)
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id.trim() ||
      entry.id.length > 512
    ) {
      throw new Error(`供应商「${providerName}」包含无效模型`)
    }
    const modality = entry.modality
    if (
      modality !== 'text' &&
      modality !== 'image' &&
      modality !== 'video' &&
      modality !== 'audio'
    ) {
      throw new Error(`供应商「${providerName}」包含无效模型类型`)
    }
    return {
      id: entry.id.trim(),
      ...(typeof entry.name === 'string' ? { name: entry.name.slice(0, 200) } : {}),
      modality,
      ...(typeof entry.contextLimit === 'number' && Number.isFinite(entry.contextLimit)
        ? { contextLimit: entry.contextLimit }
        : {}),
      ...(typeof entry.outputLimit === 'number' && Number.isFinite(entry.outputLimit)
        ? { outputLimit: entry.outputLimit }
        : {})
    }
  })
}

function parsePayload(value: unknown): ProviderTransferPayload {
  if (
    !isRecord(value) ||
    value.format !== FORMAT ||
    value.version !== VERSION ||
    !Array.isArray(value.providers) ||
    value.providers.length === 0 ||
    value.providers.length > MAX_PROVIDERS
  ) {
    throw new Error('供应商配置文件版本不受支持或内容无效')
  }
  const allowedSpecs = new Set(PROVIDER_SPECS.map((spec) => spec.id))
  const providers = value.providers.map((entry): PortableProvider => {
    if (!isRecord(entry)) throw new Error('供应商配置文件内容无效')
    const { id, name, specId, baseURL, apiKey } = entry
    if (
      typeof id !== 'string' ||
      !/^[\w-]{1,128}$/.test(id) ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 200 ||
      typeof specId !== 'string' ||
      !allowedSpecs.has(specId as ProviderConfig['specId']) ||
      typeof baseURL !== 'string' ||
      !baseURL.trim() ||
      baseURL.length > 4096 ||
      typeof apiKey !== 'string' ||
      !apiKey.trim() ||
      apiKey.length > 10000
    ) {
      throw new Error('供应商配置文件包含无效配置')
    }
    return {
      id,
      name: name.trim(),
      specId: specId as ProviderConfig['specId'],
      baseURL: baseURL.trim(),
      apiKey,
      models: parseModels(entry.models, name)
    }
  })
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) {
    throw new Error('供应商配置文件包含重复 ID')
  }
  return { format: FORMAT, version: VERSION, exportedAt: Date.now(), providers }
}

/** Decrypt and upsert imported suppliers; existing IDs are updated in place. */
export async function importProviders(
  filePath: string,
  password: string
): Promise<{
  added: number
  updated: number
  count: number
}> {
  ensureTransferAllowed('provider.import')
  const file = readFileSync(filePath)
  if (!file.byteLength || file.byteLength > MAX_FILE_BYTES) {
    throw new Error('供应商配置文件为空或超过 10 MB')
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(file.toString('utf8')) as unknown
  } catch {
    throw new Error('不是有效的供应商配置文件')
  }
  if (
    !isRecord(envelope) ||
    envelope.format !== FORMAT ||
    envelope.version !== VERSION ||
    envelope.kdf !== 'scrypt' ||
    envelope.cipher !== 'aes-256-gcm'
  ) {
    throw new Error('供应商配置文件版本不受支持')
  }

  let plaintext: string
  try {
    const salt = decodeBase64(envelope.salt, 16)
    const iv = decodeBase64(envelope.iv, 12)
    const authTag = decodeBase64(envelope.authTag, 16)
    const ciphertext = decodeBase64(envelope.ciphertext)
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(authTag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (error) {
    if (error instanceof Error && error.message === '加密密码至少需要 8 个字符') throw error
    throw new Error('密码错误，或供应商配置文件已损坏')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(plaintext) as unknown
  } catch {
    throw new Error('供应商配置文件内容损坏')
  }
  const payload = parsePayload(decoded)

  let added = 0
  let updated = 0
  const database = getDb()
  const vault = getActiveVault()

  // 1. 预处理（异步）：新密钥写入设备密钥库（发行版无 vault 时走 safeStorage 引用）
  const refs = new Map<string, string | null>()
  for (const provider of payload.providers) {
    if (await getProvider(provider.id)) updated++
    else added++
    const existingRow = database
      .prepare('SELECT api_key_ref FROM providers WHERE id = ?')
      .get(provider.id) as { api_key_ref: string | null } | undefined
    if (vault) {
      await vault.writeSecret({
        kind: 'provider',
        id: provider.id,
        origin: originOfSafe(provider.baseURL),
        source: 'local',
        scope: 'app.run',
        plain: provider.apiKey
      })
      refs.set(provider.id, vaultRef('provider', provider.id))
    } else {
      refs.set(provider.id, existingRow && !provider.apiKey ? existingRow.api_key_ref : encryptSecret(provider.apiKey))
    }
  }

  // 2. 行 upsert（单事务；引用指向刚写入的 vault/加密值）
  database.transaction(() => {
    for (const provider of payload.providers) {
      const now = Date.now()
      database
        .prepare(
          `INSERT INTO providers (id, name, spec_id, base_url, api_key_ref, models, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, spec_id = excluded.spec_id, base_url = excluded.base_url,
             api_key_ref = excluded.api_key_ref, models = excluded.models`
        )
        .run(
          provider.id,
          provider.name,
          provider.specId,
          provider.baseURL.replace(/\/+$/, ''),
          refs.get(provider.id) ?? null,
          JSON.stringify(provider.models),
          now
        )
    }
  })()

  // 3. 旧→目录连接同步（与 saveProvider 同一套语义，批处理一次）
  await bootstrapLegacyProvidersToCatalog(new SqliteModelHost(database))
  return { added, updated, count: payload.providers.length }
}
