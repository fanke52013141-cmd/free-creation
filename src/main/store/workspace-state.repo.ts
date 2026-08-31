// 本机工作区附属状态：用户工作流模板 + 按项目保存的手动历史版本。
// 它们只能经主进程 SQLite 访问，渲染进程不使用 localStorage 保存创作数据。
import { nanoid } from 'nanoid'
import type {
  HistorySnapshotRecord,
  SaveHistorySnapshotInput,
  SaveWorkflowTemplateInput,
  WorkflowTemplateRecord
} from '../../shared/contracts'
import {
  defaultPalettePreferences,
  normalizePalettePreferences,
  type PalettePreferences
} from '../../shared/palette-preferences'
import { getDb, getSetting, setSetting } from './db'

const MAX_HISTORY_SNAPSHOTS = 30
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const PALETTE_PREFERENCES_KEY = 'ui.palette-preferences.v1'

interface TemplateRow {
  id: string
  name: string
  payload: string
  created_at: number
}

interface SnapshotRow {
  id: string
  label: string
  snapshot: string
  node_count: number
  created_at: number
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function rowToTemplate(row: TemplateRow): WorkflowTemplateRecord | null {
  const payload = parseJson(row.payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return null
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    nodes: data.nodes,
    edges: data.edges,
    nodeCount: typeof data.nodeCount === 'number' ? data.nodeCount : data.nodes.length
  }
}

export function listWorkflowTemplates(): WorkflowTemplateRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM workflow_templates ORDER BY created_at DESC')
    .all() as TemplateRow[]
  return rows.map(rowToTemplate).filter((item): item is WorkflowTemplateRecord => item !== null)
}

export function saveWorkflowTemplate(input: SaveWorkflowTemplateInput): WorkflowTemplateRecord {
  if (!input.name.trim()) throw new Error('模板名称不能为空')
  if (!Array.isArray(input.nodes) || input.nodes.length === 0)
    throw new Error('模板至少需要一个节点')
  if (!Array.isArray(input.edges)) throw new Error('模板连线格式无效')
  const template: WorkflowTemplateRecord = {
    id: nanoid(12),
    name: input.name.trim(),
    createdAt: Date.now(),
    nodes: input.nodes,
    edges: input.edges,
    nodeCount: input.nodeCount
  }
  getDb()
    .prepare('INSERT INTO workflow_templates (id, name, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(template.id, template.name, JSON.stringify(template), template.createdAt)
  return template
}

export function deleteWorkflowTemplate(id: string): boolean {
  return getDb().prepare('DELETE FROM workflow_templates WHERE id = ?').run(id).changes > 0
}

export function listHistorySnapshots(projectId: string): HistorySnapshotRecord[] {
  const rows = getDb()
    .prepare(
      'SELECT id, label, snapshot, node_count, created_at FROM history_snapshots WHERE project_id = ? ORDER BY created_at DESC'
    )
    .all(projectId) as SnapshotRow[]
  return rows.flatMap((row) => {
    const snapshot = parseJson(row.snapshot)
    return snapshot === null
      ? []
      : [
          {
            id: row.id,
            label: row.label,
            timestamp: row.created_at,
            nodeCount: row.node_count,
            snapshot
          }
        ]
  })
}

export function saveHistorySnapshot(input: SaveHistorySnapshotInput): HistorySnapshotRecord {
  if (!input.projectId.trim()) throw new Error('项目 ID 不能为空')
  const serialized = JSON.stringify(input.snapshot)
  if (!serialized) throw new Error('版本快照不可序列化')
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('版本快照超过 8MB 限制，请减少画布内容后重试')
  }
  const entry: HistorySnapshotRecord = {
    id: nanoid(12),
    label: input.label.trim() || `版本 ${new Date().toLocaleTimeString('zh-CN')}`,
    timestamp: Date.now(),
    nodeCount: input.nodeCount,
    snapshot: input.snapshot
  }
  const db = getDb()
  const persist = db.transaction(() => {
    db.prepare(
      'INSERT INTO history_snapshots (id, project_id, label, snapshot, node_count, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(entry.id, input.projectId, entry.label, serialized, entry.nodeCount, entry.timestamp)
    db.prepare(
      `DELETE FROM history_snapshots
       WHERE project_id = ? AND id IN (
         SELECT id FROM history_snapshots
         WHERE project_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT -1 OFFSET ?
       )`
    ).run(input.projectId, input.projectId, MAX_HISTORY_SNAPSHOTS)
  })
  persist()
  return entry
}

export function deleteHistorySnapshot(projectId: string, id: string): boolean {
  return (
    getDb()
      .prepare('DELETE FROM history_snapshots WHERE id = ? AND project_id = ?')
      .run(id, projectId).changes > 0
  )
}

/** 左侧 Dock 是应用级本机偏好，不能污染项目快照或工作流导出。 */
export function getPalettePreferences(): PalettePreferences {
  const raw = getSetting(PALETTE_PREFERENCES_KEY)
  if (!raw) return defaultPalettePreferences()
  return normalizePalettePreferences(parseJson(raw))
}

export function savePalettePreferences(input: PalettePreferences): PalettePreferences {
  const normalized = normalizePalettePreferences(input)
  setSetting(PALETTE_PREFERENCES_KEY, JSON.stringify(normalized))
  return normalized
}
