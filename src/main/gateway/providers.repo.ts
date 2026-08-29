// 供应商配置仓库：providers 表 CRUD（表结构 db.ts 迁移已建）
// api_key_ref 列存明文 key：本地单用户应用，DPAPI 加密列为 P2 增强项
import { nanoid } from 'nanoid'
import type { GatewayModelInfo, ProviderConfig, ProviderSummary } from '../../shared/types'
import type { SaveProviderInput } from '../../shared/contracts'
import { getDb } from '../store/db'
import { decryptSecret, encryptSecret } from './keycrypto'

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

function rowToConfig(row: ProviderRow): ProviderConfig {
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
    apiKey: decryptSecret(row.api_key_ref),
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
  return row ? rowToConfig(row) : null
}

export function saveProvider(input: SaveProviderInput): ProviderSummary {
  const models = input.models.map(normalizeModel).filter((m): m is GatewayModelInfo => m !== null)
  const id = input.id ?? nanoid(10)
  const existing = input.id ? getProvider(input.id) : null
  const apiKey = input.apiKey?.trim() ?? ''
  if (!apiKey && !existing) throw new Error('新建供应商必须提供 API Key')
  const row: ProviderRow = {
    id,
    name: input.name.trim(),
    spec_id: input.specId,
    base_url: input.baseURL.trim().replace(/\/+$/, ''),
    // 编辑表单不会回显密钥；空值明确表示保留旧密钥，而不是写入 NULL。
    api_key_ref: apiKey
      ? encryptSecret(apiKey)
      : existing?.apiKey
        ? encryptSecret(existing.apiKey)
        : null,
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
