import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename } from 'path'
import type { ProjectMeta } from '../../shared/types'
import * as projects from './projects.repo'

const FORMAT = 'canvas-studio-canvas-structure'
const VERSION = 1
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_STORE_RECORDS = 100_000
const MAX_GRAPH_NODES = 20_000
const MAX_GRAPH_EDGES = 100_000
const MAX_GROUPS = 10_000
const MAX_DEPTH = 100

export interface CanvasStructureExportInput {
  id: string
  name: string
  snapshot: unknown
  graph: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
}

const OMIT_KEYS = new Set([
  'nodeResult',
  'nodeRun',
  'nodeRunHistory',
  'apikey',
  'apitoken',
  'secret',
  'secretkey',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'password',
  'bearertoken',
  'media',
  'assets',
  'blob',
  'dataurl'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mediaReferenceKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase()
  return /(?:media|asset)(?:id|ids|path|mime|url|data)$/.test(normalized)
}

function cleanValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new Error('画布结构嵌套过深，无法导入')
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, depth + 1))
  if (!isRecord(value)) return value
  const clean: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase()
    if (OMIT_KEYS.has(normalized) || mediaReferenceKey(key)) continue
    clean[key] = cleanValue(child, depth + 1)
  }
  return clean
}

function cleanSerializedJson(value: unknown, nodeType?: string): unknown {
  if (typeof value !== 'string') return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return value
    const clean = cleanValue(parsed) as Record<string, unknown>
    if (nodeType === 'chat') {
      // Keep the chat node's reusable setup, while leaving personal conversation data behind.
      clean.messages = []
      clean.conversations = []
      clean.documents = []
      clean.summary = ''
      delete clean.activeConversationId
    }
    return JSON.stringify(clean)
  } catch {
    return value
  }
}

function cleanGraph(graph: CanvasStructureExportInput['graph']): {
  nodes: unknown[]
  edges: unknown[]
  groups: unknown[]
} {
  if (
    !isRecord(graph) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.groups) ||
    graph.nodes.length > MAX_GRAPH_NODES ||
    graph.edges.length > MAX_GRAPH_EDGES ||
    graph.groups.length > MAX_GROUPS
  ) {
    throw new Error('画布结构中的节点或连线列表无效')
  }
  const nodes = graph.nodes.map((node) => {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.type !== 'string') {
      throw new Error('画布结构包含无效节点')
    }
    const cleanNode = cleanValue(node) as Record<string, unknown>
    const params = (isRecord(node.params) ? cleanValue(node.params) : {}) as Record<string, unknown>
    if (typeof params.config === 'string') {
      params.config = cleanSerializedJson(params.config, node.type)
    }
    return {
      ...cleanNode,
      params,
      content: { kind: 'empty' },
      exec: { status: 'idle' },
      meta: {
        source: ['upload', 'generate', 'derive', 'input'].includes(String((node.meta as Record<string, unknown> | undefined)?.source))
          ? (node.meta as Record<string, unknown>).source
          : 'input',
        createdAt: 0
      }
    }
  })
  const edges = graph.edges.map((edge) => {
    if (!isRecord(edge) || typeof edge.id !== 'string' || !isRecord(edge.from) || !isRecord(edge.to)) {
      throw new Error('画布结构包含无效连线')
    }
    return cleanValue(edge)
  })
  const groups = graph.groups.map((group) => {
    if (!isRecord(group) || typeof group.id !== 'string' || !Array.isArray(group.nodeIds)) {
      throw new Error('画布结构包含无效分组')
    }
    return cleanValue(group)
  })
  return { nodes, edges, groups }
}

function cleanSnapshot(snapshot: unknown): unknown {
  if (!isRecord(snapshot) || !isRecord(snapshot.store)) {
    throw new Error('画布快照无效或版本不受支持')
  }
  const sourceStore = snapshot.store
  const entries = Object.entries(sourceStore)
  if (entries.length > MAX_STORE_RECORDS) throw new Error('画布快照记录过多')
  if (
    !entries.some(([, record]) => isRecord(record) && record.typeName === 'document') ||
    !entries.some(([, record]) => isRecord(record) && record.typeName === 'page')
  ) {
    throw new Error('画布快照缺少页面数据')
  }
  const removedShapeIds = new Set<string>()
  for (const [, record] of entries) {
    if (!isRecord(record)) continue
    if (record.typeName === 'shape' && record.type === 'image' && typeof record.id === 'string') {
      removedShapeIds.add(record.id)
    }
  }

  const store: Record<string, unknown> = {}
  for (const [id, raw] of entries) {
    if (!isRecord(raw) || raw.typeName === 'asset') continue
    if (raw.typeName === 'shape' && raw.type === 'image') continue
    const bindingProps = isRecord(raw.props) ? raw.props : {}
    if (
      raw.typeName === 'binding' &&
      (removedShapeIds.has(String(raw.fromId ?? bindingProps.fromId ?? '')) ||
        removedShapeIds.has(String(raw.toId ?? bindingProps.toId ?? '')))
    ) continue

    const record = cleanValue(raw) as Record<string, unknown>
    if (record.typeName === 'shape' && record.type === 'node-card') {
      const props = isRecord(record.props) ? { ...record.props } : {}
      const nodeType = typeof props.nodeType === 'string' ? props.nodeType : undefined
      props.config = cleanSerializedJson(props.config, nodeType)
      props.text = cleanSerializedJson(props.text, nodeType)
      props.mediaId = ''
      props.mediaPath = ''
      props.mediaMime = ''
      props.exec = 'idle'
      record.props = props
      record.meta = {}
    }
    store[id] = record
  }
  return { ...cleanValue(snapshot) as Record<string, unknown>, store }
}

function sanitizedBundle(input: CanvasStructureExportInput): {
  format: typeof FORMAT
  version: typeof VERSION
  projectName: string
  exportedAt: number
  graph: ReturnType<typeof cleanGraph>
  tldrawSnapshot: unknown
} {
  if (!input?.id || typeof input.name !== 'string') throw new Error('项目参数不完整')
  return {
    format: FORMAT,
    version: VERSION,
    projectName: input.name.trim().slice(0, 120) || '未命名画布',
    exportedAt: Date.now(),
    graph: cleanGraph(input.graph),
    tldrawSnapshot: cleanSnapshot(input.snapshot)
  }
}

/** Export the live canvas layout and workflow setup, excluding media files and runtime outputs. */
export function exportCanvasStructure(filePath: string, input: CanvasStructureExportInput): {
  path: string
  nodeCount: number
} {
  const bundle = sanitizedBundle(input)
  writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
  return { path: filePath, nodeCount: bundle.graph.nodes.length }
}

function parseBundle(value: unknown): {
  projectName: string
  graph: ReturnType<typeof cleanGraph>
  tldrawSnapshot: unknown
} {
  if (!isRecord(value) || value.format !== FORMAT || value.version !== VERSION) {
    throw new Error('画布结构文件版本不受支持')
  }
  if (typeof value.projectName !== 'string' || !value.projectName.trim()) {
    throw new Error('画布结构文件缺少项目名称')
  }
  const graph = cleanGraph(value.graph as CanvasStructureExportInput['graph'])
  const tldrawSnapshot = cleanSnapshot(value.tldrawSnapshot)
  return {
    projectName: value.projectName.trim().slice(0, 120),
    graph,
    tldrawSnapshot
  }
}

/** Import as a new project so the current canvas stays intact and available for undo/history. */
export function importCanvasStructure(filePath: string): ProjectMeta {
  if (!existsSync(filePath)) throw new Error('画布结构文件不存在')
  const file = readFileSync(filePath)
  if (!file.byteLength || file.byteLength > MAX_FILE_BYTES) {
    throw new Error('画布结构文件为空或超过 50 MB')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(file.toString('utf8')) as unknown
  } catch {
    throw new Error('不是有效的画布结构 JSON 文件')
  }
  const bundle = parseBundle(parsed)
  const projectName = `${basename(bundle.projectName).slice(0, 112)}（导入）`
  const meta = projects.createProject(projectName)
  try {
    const saved = projects.saveProject({
      id: meta.id,
      graph: bundle.graph,
      tldrawSnapshot: bundle.tldrawSnapshot
    })
    if (!saved) throw new Error('无法保存导入的画布结构')
    return projects.getProject(meta.id) ?? meta
  } catch (error) {
    projects.deleteProject(meta.id)
    projects.purgeProjectFiles(meta.id)
    throw error
  }
}
