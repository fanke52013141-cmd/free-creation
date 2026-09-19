// 供应商配置仓库：providers 表 CRUD（表结构 db.ts 迁移已建）
// api_key_ref 存 safeStorage 密文（enc:）；加密上线前写入的裸明文行由
// upgradeLegacyApiKeys() 在启动时收口。
import { nanoid } from 'nanoid'
import type { GatewayModelInfo, ProviderConfig, ProviderSummary } from '../../shared/types'
import type { SaveProviderInput } from '../../shared/contracts'
import { getDb } from '../store/db'
import { decryptSecret, encryptionAvailable, encryptSecret, isEncryptedSecret } from './keycrypto'

interface ProviderRow {
  id: string
  name: string
  spec_id: string
  base_url: string
  api_key_ref: string | null
  models: string
  created_at: number
}

function normalizeModel(v: unknown): GatewayModelInfo | null {
  if (typeof v === 'string') return { id: v, modality: 'text' }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id.trim()) return null
    const modality =
      o.modality === 'image' || o.modality === 'video' || o.modality === 'audio'
        ? o.modality
        : 'text'
    return {
      id: o.id.trim(),
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : undefined,
      modality,
      contextLimit: typeof o.contextLimit === 'number' ? o.contextLimit : undefined,
      outputLimit: typeof o.outputLimit === 'number' ? o.outputLimit : undefined
    }
  }
  return null
}

function toConfig(row: ProviderRow, decryptedApiKey: string): ProviderConfig {
  let models: unknown = []
  try {
    models = JSON.parse(row.models || '[]')
  } catch {
    // 损坏数据按空处理
  }
  const list = Array.isArray(models)
    ? models.map(normalizeModel).filter((m): m is GatewayModelInfo => m !== null)
    : []
  return {
    id: row.id,
    name: row.name,
    specId: row.spec_id as ProviderConfig['specId'],
    baseURL: row.base_url,
    apiKey: decryptedApiKey,
    models: list,
    createdAt: row.created_at
  }
}

function toSummary(row: ProviderRow): ProviderSummary {
  let models: unknown = []
  try {
    models = JSON.parse(row.models || '[]')
  } catch {
    // 损坏数据按空处理
  }
  return {
    id: row.id,
    name: row.name,
    specId: row.spec_id as ProviderSummary['specId'],
    baseURL: row.base_url,
    models: Array.isArray(models)
      ? models.map(normalizeModel).filter((model): model is GatewayModelInfo => model !== null)
      : [],
    createdAt: row.created_at,
    hasApiKey: Boolean(row.api_key_ref)
  }
}

/** 渲染进程只能读取此公开摘要，不能接触 api_key_ref 的解密值。 */
export function listProviders(): ProviderSummary[] {
  const rows = getDb()
    .prepare('SELECT * FROM providers ORDER BY created_at ASC')
    .all() as ProviderRow[]
  return rows.map(toSummary)
}

export function getProvider(id: string): ProviderConfig | null {
  const row = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as
    ProviderRow | undefined
  return row ? toConfig(row, decryptSecret(row.api_key_ref)) : null
}

export function saveProvider(input: SaveProviderInput): ProviderSummary {
  const models = input.models.map(normalizeModel).filter((m): m is GatewayModelInfo => m !== null)
  const id = input.id ?? nanoid(10)
  const existing = input.id ? getProvider(input.id) : null
  const apiKey = input.apiKey?.trim() ?? ''
  if (!apiKey && !existing) throw new Error('新建供应商必须提供 API Key')

  // F11 修复：读取原始行（而非解密后的 ProviderConfig），编辑未提交新 key 时
  // 把库里的 api_key_ref 逐字节原样写回。此前经 decryptSecret → encryptSecret
  // 往返，safeStorage 暂不可用时解密返回空串，空串被当作"用户清除"重新加密
  // 落盘，密文永久丢失。
  const existingRow = input.id
    ? (getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined)
    : undefined
  const apiKeyRef = apiKey ? encryptSecret(apiKey) : existingRow ? existingRow.api_key_ref : null

  const row: ProviderRow = {
    id,
    name: input.name.trim(),
    spec_id: input.specId,
    base_url: input.baseURL.trim().replace(/\/+$/, ''),
    api_key_ref: apiKeyRef,
    models: JSON.stringify(models),
    created_at: existing?.createdAt ?? Date.now()
  }
  getDb()
    .prepare(
      `INSERT INTO providers (id, name, spec_id, base_url, api_key_ref, models, created_at)
       VALUES (@id, @name, @spec_id, @base_url, @api_key_ref, @models, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, spec_id = excluded.spec_id, base_url = excluded.base_url,
         api_key_ref = excluded.api_key_ref, models = excluded.models`
    )
    .run(row)
  const saved = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow
  return toSummary(saved)
}

export function deleteProvider(id: string): boolean {
  const res = getDb().prepare('DELETE FROM providers WHERE id = ?').run(id)
  return res.changes > 0
}

/**
 * safeStorage 上线前写入的 Key 是裸明文（或 plain: 降级串），它们至今明文躺在 app.db 里。
 * 启动时把这些行重新加密成 enc:；本机暂无加密能力时一行都不写——写成 plain: 不是升级，
 * 只是把「也许还能读」换成「一定更糟」。
 */
export function upgradeLegacyApiKeys(): number {
  if (!encryptionAvailable()) return 0
  const db = getDb()
  const rows = db.prepare('SELECT id, api_key_ref FROM providers').all() as Array<{
    id: string
    api_key_ref: string | null
  }>
  let upgraded = 0
  for (const row of rows) {
    const stored = row.api_key_ref
    if (!stored || isEncryptedSecret(stored)) continue
    const cipher = encryptSecret(decryptSecret(stored))
    if (!isEncryptedSecret(cipher)) continue
    db.prepare('UPDATE providers SET api_key_ref = ? WHERE id = ?').run(cipher, row.id)
    upgraded++
  }
  return upgraded
}
