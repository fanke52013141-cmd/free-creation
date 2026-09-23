import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import type { GatewayModelInfo, ProviderConfig } from '../../shared/types'
import { PROVIDER_SPECS } from '../../shared/types'
import { getDb } from '../store/db'
import { getProvider, listProviders, saveProvider } from './providers.repo'

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

function exportableProviders(): PortableProvider[] {
  const byId = new Map<string, ProviderConfig>()
  for (const summary of listProviders()) {
    const provider = getProvider(summary.id)
    if (provider) byId.set(provider.id, provider)
  }
  const providers = [...byId.values()]
  if (!providers.length) throw new Error('当前没有可导出的供应商')
  const missingKeys = providers.filter((provider) => !provider.apiKey)
  if (missingKeys.length) {
    throw new Error(`这些供应商的 API Key 当前无法读取，请先重新填写密钥：${missingKeys.map((p) => p.name).join('、')}`)
  }
  return providers.map(({ id, name, specId, baseURL, apiKey, models }) => ({
    id,
    name,
    specId,
    baseURL,
    apiKey,
    models
  }))
}

/** Export supplier IDs, endpoints, model selections and API Keys into a password-encrypted file. */
export function exportProviders(filePath: string, password: string): number {
  const providers = exportableProviders()
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
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ])
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
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 512) {
      throw new Error(`供应商「${providerName}」包含无效模型`)
    }
    const modality = entry.modality
    if (modality !== 'text' && modality !== 'image' && modality !== 'video' && modality !== 'audio') {
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
      typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) ||
      typeof name !== 'string' || !name.trim() || name.length > 200 ||
      typeof specId !== 'string' || !allowedSpecs.has(specId as ProviderConfig['specId']) ||
      typeof baseURL !== 'string' || !baseURL.trim() || baseURL.length > 4096 ||
      typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 10000
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

/** Decrypt and atomically upsert imported suppliers; existing IDs are updated in place. */
export function importProviders(filePath: string, password: string): {
  added: number
  updated: number
  count: number
} {
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
  database.transaction(() => {
    for (const provider of payload.providers) {
      if (getProvider(provider.id)) updated++
      else added++
      saveProvider(provider)
    }
  })()
  return { added, updated, count: payload.providers.length }
}
