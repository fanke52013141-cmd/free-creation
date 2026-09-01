/**
 * Runs 仓库：运行记录与产出索引的 SQLite CRUD（P3）。
 *
 * 与 media.repo.ts 同一套 getDb() 模式：同步 prepared statements，
 * 调用方通过 DesktopProjectStore 的 async 方法间接访问。
 */
import { nanoid } from 'nanoid'
import { getDb } from './db'
import type {
  RunRecord,
  RunStatus,
  RunUpdatePatch,
  RunArtifactRecord,
  AuditActor
} from '../../application/types'

// ── Run CRUD ──────────────────────────────────────────────

interface RunRow {
  id: string
  project_id: string
  scope_type: string
  scope_node_ids: string
  status: string
  actor: string
  started_at: number | null
  finished_at: number | null
  duration_ms: number | null
  error_code: string | null
  error_message: string | null
  created_at: number
}

function rowToRecord(row: RunRow): RunRecord {
  return {
    runId: row.id,
    projectId: row.project_id,
    scope: {
      type: row.scope_type as RunRecord['scope']['type'],
      nodeIds: row.scope_node_ids ? (JSON.parse(row.scope_node_ids) as string[]) : undefined
    },
    status: row.status as RunStatus,
    actor: row.actor as AuditActor,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    error:
      row.error_code != null
        ? { code: row.error_code, message: row.error_message ?? '' }
        : undefined,
    createdAt: row.created_at
  }
}

export function createRun(record: Omit<RunRecord, 'createdAt'>): RunRecord {
  const createdAt = Date.now()
  getDb()
    .prepare(
      `INSERT INTO runs (id, project_id, scope_type, scope_node_ids, status, actor, started_at, finished_at, duration_ms, error_code, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.runId,
      record.projectId,
      record.scope.type,
      JSON.stringify(record.scope.nodeIds ?? []),
      record.status,
      record.actor,
      record.startedAt ?? null,
      record.finishedAt ?? null,
      record.durationMs ?? null,
      record.error?.code ?? null,
      record.error?.message ?? null,
      createdAt
    )
  return { ...record, createdAt }
}

export function updateRun(runId: string, patch: RunUpdatePatch): RunRecord | null {
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.status !== undefined) {
    sets.push('status = ?')
    values.push(patch.status)
  }
  if (patch.startedAt !== undefined) {
    sets.push('started_at = ?')
    values.push(patch.startedAt)
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = ?')
    values.push(patch.finishedAt)
  }
  if (patch.durationMs !== undefined) {
    sets.push('duration_ms = ?')
    values.push(patch.durationMs)
  }
  if (patch.error !== undefined) {
    sets.push('error_code = ?', 'error_message = ?')
    values.push(patch.error.code, patch.error.message)
  }
  if (sets.length === 0) {
    return getRun(runId)
  }

  values.push(runId)
  getDb()
    .prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values)

  return getRun(runId)
}

export function getRun(runId: string): RunRecord | null {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined
  return row ? rowToRecord(row) : null
}

export function listRuns(projectId: string, filter?: { status?: RunStatus }): RunRecord[] {
  const conditions = ['project_id = ?']
  const params: unknown[] = [projectId]
  if (filter?.status) {
    conditions.push('status = ?')
    params.push(filter.status)
  }
  const rows = getDb()
    .prepare(`SELECT * FROM runs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`)
    .all(...params) as RunRow[]
  return rows.map(rowToRecord)
}

// ── Run Artifact CRUD ─────────────────────────────────────

interface ArtifactRow {
  id: string
  run_id: string
  project_id: string
  node_id: string
  port_id: string | null
  media_id: string | null
  artifact_type: string
  mime_type: string | null
  label: string | null
  input_summary: string | null
  model_key: string | null
  created_at: number
}

function artifactRowToRecord(row: ArtifactRow): RunArtifactRecord {
  return {
    artifactId: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    portId: row.port_id ?? undefined,
    mediaId: row.media_id ?? undefined,
    artifactType: row.artifact_type as RunArtifactRecord['artifactType'],
    mimeType: row.mime_type ?? undefined,
    label: row.label ?? undefined,
    inputSummary: row.input_summary ? (JSON.parse(row.input_summary) as Record<string, unknown>) : undefined,
    modelKey: row.model_key ?? undefined,
    createdAt: row.created_at
  }
}

export function createRunArtifact(
  record: Omit<RunArtifactRecord, 'artifactId' | 'createdAt'>
): RunArtifactRecord {
  const artifactId = nanoid(12)
  const createdAt = Date.now()
  getDb()
    .prepare(
      `INSERT INTO run_artifacts (id, run_id, project_id, node_id, port_id, media_id, artifact_type, mime_type, label, input_summary, model_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      artifactId,
      record.runId,
      record.projectId,
      record.nodeId,
      record.portId ?? null,
      record.mediaId ?? null,
      record.artifactType,
      record.mimeType ?? null,
      record.label ?? null,
      record.inputSummary ? JSON.stringify(record.inputSummary) : null,
      record.modelKey ?? null,
      createdAt
    )
  return { ...record, artifactId, createdAt }
}

export function listRunArtifacts(runId: string): RunArtifactRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at ASC')
    .all(runId) as ArtifactRow[]
  return rows.map(artifactRowToRecord)
}
