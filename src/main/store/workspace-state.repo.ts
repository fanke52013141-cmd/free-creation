// 本机工作区附属状态：用户工作流模板 + 按项目保存的手动历史版本。
// 它们只能经主进程 SQLite 访问，渲染进程不使用 localStorage 保存创作数据。
import { nanoid } from 'nanoid'
import type {
  HistorySnapshotRecord,
  GenerationTimingSample,
  ImageGenerationTimingSample,
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
import { openProject } from './projects.repo'

const MAX_HISTORY_SNAPSHOTS = 30
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const PALETTE_PREFERENCES_KEY = 'ui.palette-preferences.v1'
const IMAGE_GENERATION_TIMINGS_KEY = 'metrics.image-generation-timings.v1'
const GENERATION_TIMINGS_KEY = 'metrics.generation-timings.v1'
export const MAX_IMAGE_GENERATION_TIMING_SAMPLES_PER_MODEL = 20
export const MAX_IMAGE_GENERATION_TIMING_MODELS = 100
export const MIN_IMAGE_GENERATION_DURATION_MS = 100
export const MAX_IMAGE_GENERATION_DURATION_MS = 30 * 60 * 1000
const MAX_TIMING_KEY_LENGTH = 96
const TIMING_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

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
  graph_json: string | null
}

/** 快照对应的“已持久化图数据”（与 project.json 的 nodes/edges/groups 同构）。 */
export interface HistorySnapshotGraph {
  nodes: unknown[]
  edges: unknown[]
  groups: unknown[]
}

/** 历史版本目录项：不加载 snapshot/graph_json 大字段。 */
export interface HistorySnapshotSummary {
  id: string
  label: string
  timestamp: number
  nodeCount: number
  /** true 表示该快照带 graph_json，可由外部恢复到正式项目文件。 */
  restorable: boolean
}

export interface HistorySnapshotDetail {
  id: string
  label: string
  timestamp: number
  nodeCount: number
  snapshot: unknown
  graph: HistorySnapshotGraph | null
}

function parseGraphJson(value: string | null): HistorySnapshotGraph | null {
  if (!value) return null
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const graph = parsed as Record<string, unknown>
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.groups))
    return null
  return { nodes: graph.nodes, edges: graph.edges, groups: graph.groups }
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isTimingKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TIMING_KEY_LENGTH &&
    TIMING_KEY_PATTERN.test(value)
  )
}

function isTimingDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_IMAGE_GENERATION_DURATION_MS &&
    value <= MAX_IMAGE_GENERATION_DURATION_MS
  )
}

function isTimingRecordedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isWorkloadNumber(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
}

function normalizeGenerationTimingSample(value: unknown): GenerationTimingSample | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    !isTimingKey(item.sampleId) ||
    !isTimingKey(item.operation) ||
    !isTimingKey(item.providerKey) ||
    !isTimingKey(item.modelKey) ||
    !Number.isInteger(item.durationMs) ||
    !isWorkloadNumber(item.durationMs, 4 * 60 * 60 * 1000) ||
    item.durationMs < 100 ||
    !isTimingRecordedAt(item.recordedAt)
  ) return null
  const numericFields = {
    textUnits: 1_000_000,
    targetDurationSec: 4 * 60 * 60,
    sourceDurationSec: 4 * 60 * 60,
    sourceFps: 240,
    imageCount: 100
  } as const
  const features: Partial<GenerationTimingSample> = {}
  for (const [key, max] of Object.entries(numericFields)) {
    const field = key as keyof typeof numericFields
    if (item[field] === undefined) continue
    if (!isWorkloadNumber(item[field], max)) return null
    ;(features as Record<string, number>)[field] = item[field] as number
  }
  for (const field of ['resolution', 'mode'] as const) {
    if (item[field] === undefined) continue
    if (!isTimingKey(item[field])) return null
    features[field] = item[field]
  }
  return {
    sampleId: item.sampleId,
    operation: item.operation,
    providerKey: item.providerKey,
    modelKey: item.modelKey,
    durationMs: item.durationMs as number,
    recordedAt: item.recordedAt,
    ...features
  }
}

export function compactGenerationTimingSamples(value: unknown): GenerationTimingSample[] {
  if (!Array.isArray(value)) return []
  const groups = new Map<string, GenerationTimingSample[]>()
  const sampleIds = new Set<string>()
  for (const sample of value
    .map(normalizeGenerationTimingSample)
    .filter((item): item is GenerationTimingSample => item !== null)
    .sort((a, b) => b.recordedAt - a.recordedAt)) {
    if (sampleIds.has(sample.sampleId)) continue
    sampleIds.add(sample.sampleId)
    const key = `${sample.operation}\u0000${sample.providerKey}\u0000${sample.modelKey}`
    const group = groups.get(key)
    if (group) {
      if (group.length < 20) group.push(sample)
    } else if (groups.size < 100) {
      groups.set(key, [sample])
    }
  }
  return [...groups.values()].flat()
}

/** 仅接受无敏感正文的五字段历史记录；损坏/旧设置不会阻断工作区启动。 */
export function parseImageGenerationTimingSamples(value: unknown): ImageGenerationTimingSample[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const sample = item as Record<string, unknown>
    return isTimingKey(sample.runId) &&
      isTimingKey(sample.providerKey) &&
      isTimingKey(sample.modelKey) &&
      isTimingDuration(sample.durationMs) &&
      isTimingRecordedAt(sample.recordedAt)
      ? [
          {
            runId: sample.runId,
            providerKey: sample.providerKey,
            modelKey: sample.modelKey,
            durationMs: sample.durationMs,
            recordedAt: sample.recordedAt
          }
        ]
      : []
  })
}

/**
 * 每个 provider/model 只保留最近 20 条，同时限制最多 100 组，避免任意 IPC 写入
 * 将 settings 记录无限膨胀。按时间降序输出，查询与持久化都使用相同的稳定顺序。
 */
export function compactImageGenerationTimingSamples(
  samples: readonly ImageGenerationTimingSample[]
): ImageGenerationTimingSample[] {
  const groups = new Map<string, ImageGenerationTimingSample[]>()
  const runIds = new Set<string>()
  for (const sample of [...samples].sort((a, b) => b.recordedAt - a.recordedAt)) {
    if (runIds.has(sample.runId)) continue
    runIds.add(sample.runId)
    const key = `${sample.providerKey}\u0000${sample.modelKey}`
    const group = groups.get(key)
    if (group) {
      if (group.length < MAX_IMAGE_GENERATION_TIMING_SAMPLES_PER_MODEL) group.push(sample)
    } else if (groups.size < MAX_IMAGE_GENERATION_TIMING_MODELS) {
      groups.set(key, [sample])
    }
  }
  return [...groups.values()].flat()
}

function assertTimingKeys(input: { runId: unknown; providerKey: unknown; modelKey: unknown }): void {
  if (!isTimingKey(input.runId)) {
    throw new Error('运行标识格式无效')
  }
  if (!isTimingKey(input.providerKey)) {
    throw new Error('供应商标识格式无效')
  }
  if (!isTimingKey(input.modelKey)) {
    throw new Error('模型标识格式无效')
  }
}

function readImageGenerationTimingSamples(): ImageGenerationTimingSample[] {
  const raw = getSetting(IMAGE_GENERATION_TIMINGS_KEY)
  return compactImageGenerationTimingSamples(parseImageGenerationTimingSamples(raw ? parseJson(raw) : null))
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

export function getWorkflowTemplate(id: string): WorkflowTemplateRecord | null {
  const row = getDb().prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id) as
    | TemplateRow
    | undefined
  return row ? rowToTemplate(row) : null
}

/** 只改条目名称；内容（nodes/edges）与画布不受影响。 */
export function renameWorkflowTemplate(id: string, name: string): WorkflowTemplateRecord | null {
  const existing = getWorkflowTemplate(id)
  if (!existing) return null
  const trimmed = name.trim()
  if (!trimmed) throw new Error('模板名称不能为空')
  const record: WorkflowTemplateRecord = { ...existing, name: trimmed.slice(0, 120) }
  getDb()
    .prepare('UPDATE workflow_templates SET name = ?, payload = ? WHERE id = ?')
    .run(record.name, JSON.stringify(record), id)
  return record
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

/** 历史版本目录：不加载 snapshot/graph_json 大字段，只回报是否可由外部恢复。 */
export function listHistorySnapshotSummaries(projectId: string): HistorySnapshotSummary[] {
  const rows = getDb()
    .prepare(
      'SELECT id, label, node_count, created_at, graph_json FROM history_snapshots WHERE project_id = ? ORDER BY created_at DESC'
    )
    .all(projectId) as Array<Omit<SnapshotRow, 'snapshot'>>
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    timestamp: row.created_at,
    nodeCount: row.node_count,
    restorable: parseGraphJson(row.graph_json ?? null) !== null
  }))
}

/** 单个历史版本详情（含快照正文与可恢复图数据）。项目隔离：id 必须属于该项目。 */
export function readHistorySnapshot(
  projectId: string,
  id: string
): HistorySnapshotDetail | null {
  const row = getDb()
    .prepare('SELECT * FROM history_snapshots WHERE id = ? AND project_id = ?')
    .get(id, projectId) as SnapshotRow | undefined
  if (!row) return null
  const snapshot = parseJson(row.snapshot)
  if (snapshot === null) return null
  return {
    id: row.id,
    label: row.label,
    timestamp: row.created_at,
    nodeCount: row.node_count,
    snapshot,
    graph: parseGraphJson(row.graph_json ?? null)
  }
}

/**
 * 快照对应的已持久化图数据。
 *
 * GUI 历史坞捕获的是编辑器内存状态，未保存的编辑会让内存快照与磁盘图不一致；
 * 这种快照仍能被 GUI 在画布内恢复，但不能作为外部恢复的图事实（否则会把旧图
 * 写进项目文件）。因此只有“快照内容与磁盘 tldrawSnapshot 完全一致”时才附带
 * 图数据；外部 `history.snapshot.create` 直接给出显式 graph。
 */
function persistedSnapshotGraph(
  projectId: string,
  serializedSnapshot: string
): HistorySnapshotGraph | null {
  const file = openProject(projectId)
  if (!file || file.tldrawSnapshot === undefined) return null
  let persisted: string
  try {
    persisted = JSON.stringify(file.tldrawSnapshot)
  } catch {
    return null
  }
  if (persisted !== serializedSnapshot) return null
  return { nodes: file.nodes, edges: file.edges, groups: file.groups }
}

export function saveHistorySnapshot(
  input: SaveHistorySnapshotInput,
  options: { graph?: HistorySnapshotGraph } = {}
): HistorySnapshotRecord {
  if (!input.projectId.trim()) throw new Error('项目 ID 不能为空')
  const serialized = JSON.stringify(input.snapshot)
  if (!serialized) throw new Error('版本快照不可序列化')
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('版本快照超过 8MB 限制，请减少画布内容后重试')
  }
  const graph = options.graph ?? persistedSnapshotGraph(input.projectId, serialized)
  let graphJson: string | null = graph ? JSON.stringify(graph) : null
  // 图谱超过同一上限时不写恢复图数据：GUI 保存快照不能因此失败，只是不可外部恢复。
  if (graphJson && Buffer.byteLength(graphJson, 'utf8') > MAX_SNAPSHOT_BYTES) graphJson = null
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
      'INSERT INTO history_snapshots (id, project_id, label, snapshot, node_count, created_at, graph_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      entry.id,
      input.projectId,
      entry.label,
      serialized,
      entry.nodeCount,
      entry.timestamp,
      graphJson
    )
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

/** 返回全部受上限保护的本机样本；renderer 可据此计算模型/供应商聚合均值。 */
export function getImageGenerationTimings(): ImageGenerationTimingSample[] {
  return readImageGenerationTimingSamples()
}

/** 在 SQLite settings 中记录单张生成耗时；runId 幂等，不接受 prompt/API Key/媒体信息。 */
export function recordImageGenerationTiming(
  input: ImageGenerationTimingSample
): ImageGenerationTimingSample[] {
  assertTimingKeys(input)
  if (!isTimingDuration(input.durationMs)) {
    throw new Error(
      `图片生成耗时必须是 ${MIN_IMAGE_GENERATION_DURATION_MS} 到 ${MAX_IMAGE_GENERATION_DURATION_MS} 毫秒之间的整数`
    )
  }
  if (!isTimingRecordedAt(input.recordedAt)) throw new Error('图片生成记录时间格式无效')
  const current = readImageGenerationTimingSamples()
  if (current.some((sample) => sample.runId === input.runId)) return current
  // 输入来自 renderer，运行时可能携带未声明的字段；持久化前白名单重建对象，
  // 以确保 prompt、API key、媒体标识等永远不会落入 settings。
  const sample: ImageGenerationTimingSample = {
    runId: input.runId,
    providerKey: input.providerKey,
    modelKey: input.modelKey,
    durationMs: input.durationMs,
    recordedAt: input.recordedAt
  }
  const next = compactImageGenerationTimingSamples([sample, ...current])
  setSetting(IMAGE_GENERATION_TIMINGS_KEY, JSON.stringify(next))
  return next
}

/** 所有任务共用的本机估时样本；仅持久化白名单字段。 */
export function getGenerationTimings(): GenerationTimingSample[] {
  const raw = getSetting(GENERATION_TIMINGS_KEY)
  return compactGenerationTimingSamples(raw ? parseJson(raw) : null)
}

export function recordGenerationTiming(input: GenerationTimingSample): GenerationTimingSample[] {
  const sample = normalizeGenerationTimingSample(input)
  if (!sample) throw new Error('生成耗时样本格式无效')
  const current = getGenerationTimings()
  if (current.some((item) => item.sampleId === sample.sampleId)) return current
  const next = compactGenerationTimingSamples([sample, ...current])
  setSetting(GENERATION_TIMINGS_KEY, JSON.stringify(next))
  return next
}
