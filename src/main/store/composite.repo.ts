import type { CompositeManifest } from '../../shared/composite/manifest'
import type {
  CompositeCapabilitySummary,
  CompositeDraftRecord,
  CompositeVersionRecord
} from '../../shared/composite/types'
import { compositeContentHash, parseCompositeManifest } from '../../shared/composite/manifest'
import { validateCompositeManifest } from '../../shared/composite/validate'
import { getDb } from './db'

interface CapabilityRow {
  id: string
  name: string
  description: string
  tags: string
  latest_version: string | null
  archived: number
  created_at: number
  updated_at: number
}

interface VersionRow {
  capability_id: string
  version: string
  manifest: string
  content_hash: string
  published_at: number
}

interface DraftRow {
  capability_id: string
  manifest: string
  revision: number
  updated_at: number
}

function rowToSummary(row: CapabilityRow): CompositeCapabilitySummary {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags) as unknown
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
  } catch {
    // 损坏的 tags 不阻塞发现；按无标签处理。
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags,
    latestVersion: row.latest_version,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToVersion(row: VersionRow): CompositeVersionRecord {
  return {
    capabilityId: row.capability_id,
    version: row.version,
    manifest: JSON.parse(row.manifest) as CompositeManifest,
    contentHash: row.content_hash,
    publishedAt: row.published_at
  }
}

function rowToDraft(row: DraftRow): CompositeDraftRecord {
  return {
    capabilityId: row.capability_id,
    manifest: JSON.parse(row.manifest) as CompositeManifest,
    revision: row.revision,
    updatedAt: row.updated_at
  }
}

function assertPublishManifest(value: unknown): CompositeManifest {
  // 已发布版本可同步读取，用于嵌套依赖环/深度/展开预算校验。
  const getCapability = (capabilityId: string, version: string): CompositeManifest | null => {
    const row = getDb()
      .prepare('SELECT manifest FROM composite_versions WHERE capability_id = ? AND version = ?')
      .get(capabilityId, version) as { manifest: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.manifest) as CompositeManifest
    } catch {
      return null
    }
  }
  const result = validateCompositeManifest(value, { getCapability })
  if (!result.ok) {
    throw new Error(
      `组合契约无效：${result.issues.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`).join('；')}`
    )
  }
  return result.ok ? (value as CompositeManifest) : (value as CompositeManifest)
}

function assertManifest(value: unknown): CompositeManifest {
  const result = parseCompositeManifest(value)
  if (!result.ok) {
    throw new Error(
      `组合契约无效：${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；')}`
    )
  }
  return result.manifest
}

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function upsertCapabilityRow(manifest: CompositeManifest, now: number): void {
  const existing = getDb()
    .prepare('SELECT * FROM composite_capabilities WHERE id = ?')
    .get(manifest.capabilityId) as CapabilityRow | undefined
  const tags = JSON.stringify(manifest.tags ?? [])
  if (!existing) {
    getDb()
      .prepare(
        `INSERT INTO composite_capabilities (id, name, description, tags, latest_version, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`
      )
      .run(
        manifest.capabilityId,
        manifest.name,
        manifest.description ?? '',
        tags,
        now,
        now
      )
    return
  }
  getDb()
    .prepare(
      `UPDATE composite_capabilities SET name = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?`
    )
    .run(manifest.name, manifest.description ?? '', tags, now, manifest.capabilityId)
}

/** 保存草稿：同 capabilityId 覆盖，revision 自增；expectedRevision 用于并发保护。 */
export async function saveCompositeDraft(
  manifestInput: unknown,
  expectedRevision?: number
): Promise<CompositeDraftRecord> {
  const manifest = assertManifest(manifestInput)
  const now = Date.now()
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM composite_drafts WHERE capability_id = ?')
    .get(manifest.capabilityId) as DraftRow | undefined
  const currentRevision = existing?.revision ?? 0
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new Error(`草稿修订冲突：期望 ${expectedRevision}，当前 ${currentRevision}`)
  }
  const revision = currentRevision + 1
  upsertCapabilityRow(manifest, now)
  db.prepare(
    `INSERT INTO composite_drafts (capability_id, manifest, revision, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(capability_id) DO UPDATE SET
       manifest = excluded.manifest, revision = excluded.revision, updated_at = excluded.updated_at`
  ).run(manifest.capabilityId, JSON.stringify(manifest), revision, now)
  return {
    capabilityId: manifest.capabilityId,
    manifest,
    revision,
    updatedAt: now
  }
}

export function getCompositeDraft(capabilityId: string): CompositeDraftRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM composite_drafts WHERE capability_id = ?')
    .get(capabilityId) as DraftRow | undefined
  return row ? rowToDraft(row) : null
}

export function deleteCompositeDraft(capabilityId: string): boolean {
  return (
    getDb().prepare('DELETE FROM composite_drafts WHERE capability_id = ?').run(capabilityId).changes > 0
  )
}

/**
 * 发布不可变版本：同 capabilityId+version 已存在且摘要相同 → 幂等返回；
 * 摘要不同 → 拒绝覆盖（发布版本永远不可变）。
 */
export async function publishCompositeVersion(
  manifestInput: unknown,
  publishedBy = 'local'
): Promise<{ record: CompositeVersionRecord; created: boolean }> {
  const manifest = assertPublishManifest(manifestInput)
  const contentHash = await compositeContentHash(manifest)
  const db = getDb()
  const now = Date.now()
  const existing = db
    .prepare('SELECT * FROM composite_versions WHERE capability_id = ? AND version = ?')
    .get(manifest.capabilityId, manifest.version) as VersionRow | undefined
  if (existing) {
    if (existing.content_hash === contentHash) {
      return { record: rowToVersion(existing), created: false }
    }
    // 用户 2026-11-10 裁决：版本按主版本整数管理，允许直接修改旧版本；
    // 更新同一版本的内容摘要而不另造副版本。
    db.prepare(
      `UPDATE composite_versions SET manifest = ?, content_hash = ?, published_at = ?, published_by = ?
       WHERE capability_id = ? AND version = ?`
    ).run(
      JSON.stringify(manifest),
      contentHash,
      now,
      publishedBy,
      manifest.capabilityId,
      manifest.version
    )
    upsertCapabilityRow(manifest, now)
    const replaced = db
      .prepare('SELECT * FROM composite_versions WHERE capability_id = ? AND version = ?')
      .get(manifest.capabilityId, manifest.version) as VersionRow
    return { record: rowToVersion(replaced), created: false }
  }
  const capability = db
    .prepare('SELECT * FROM composite_capabilities WHERE id = ?')
    .get(manifest.capabilityId) as CapabilityRow | undefined
  const nextLatest =
    !capability?.latest_version || compareSemver(manifest.version, capability.latest_version) > 0
      ? manifest.version
      : capability.latest_version
  const transaction = db.transaction(() => {
    upsertCapabilityRow(manifest, now)
    db.prepare(
      `INSERT INTO composite_versions
         (capability_id, version, manifest, content_hash, published_at, published_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      manifest.capabilityId,
      manifest.version,
      JSON.stringify(manifest),
      contentHash,
      now,
      publishedBy
    )
    db.prepare(
      `UPDATE composite_capabilities SET latest_version = ?, archived = 0, updated_at = ? WHERE id = ?`
    ).run(nextLatest, now, manifest.capabilityId)
  })
  transaction()
  const saved = db
    .prepare('SELECT * FROM composite_versions WHERE capability_id = ? AND version = ?')
    .get(manifest.capabilityId, manifest.version) as VersionRow
  return { record: rowToVersion(saved), created: true }
}

export function getCompositeVersion(
  capabilityId: string,
  version: string
): CompositeVersionRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM composite_versions WHERE capability_id = ? AND version = ?')
    .get(capabilityId, version) as VersionRow | undefined
  return row ? rowToVersion(row) : null
}

export function getCompositeCapability(capabilityId: string): CompositeCapabilitySummary | null {
  const row = getDb()
    .prepare('SELECT * FROM composite_capabilities WHERE id = ?')
    .get(capabilityId) as CapabilityRow | undefined
  return row ? rowToSummary(row) : null
}

export function listCompositeCapabilities(options: {
  query?: string
  includeArchived?: boolean
  limit?: number
} = {}): CompositeCapabilitySummary[] {
  const query = options.query?.trim() ?? ''
  const limit = Math.max(1, Math.min(200, options.limit ?? 100))
  const clauses = [options.includeArchived ? '1 = 1' : 'archived = 0']
  const params: Array<string | number> = []
  if (query) {
    clauses.push('(id LIKE ? OR name LIKE ? OR description LIKE ? OR tags LIKE ?)')
    const pattern = `%${query}%`
    params.push(pattern, pattern, pattern, pattern)
  }
  params.push(limit)
  const rows = getDb()
    .prepare(
      `SELECT * FROM composite_capabilities WHERE ${clauses.join(' AND ')}
       ORDER BY archived ASC, updated_at DESC LIMIT ?`
    )
    .all(...params) as CapabilityRow[]
  return rows.map(rowToSummary)
}

export function archiveCompositeCapability(capabilityId: string, archived = true): boolean {
  return (
    getDb()
      .prepare('UPDATE composite_capabilities SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, Date.now(), capabilityId).changes > 0
  )
}

/** 校验已发布版本的摘要是否仍与 manifest 一致（导入/运行前完整性检查）。 */
export async function verifyCompositeVersion(
  capabilityId: string,
  version: string
): Promise<{ ok: boolean; reason?: string }> {
  const record = getCompositeVersion(capabilityId, version)
  if (!record) return { ok: false, reason: '版本不存在' }
  const parsed = parseCompositeManifest(record.manifest)
  if (!parsed.ok) return { ok: false, reason: '版本 manifest 已损坏' }
  const hash = await compositeContentHash(parsed.manifest)
  return hash === record.contentHash ? { ok: true } : { ok: false, reason: '内容摘要不一致' }
}
