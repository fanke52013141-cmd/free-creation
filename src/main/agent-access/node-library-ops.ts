// F7 节点库通用化：组合保存 / 命名更新 / 删除 / 详情 / 搜索 / 跨画布实例化。
//
// 与 GUI 的关系：
// - 存储仍是 `workflow_templates`（workspace-state.repo 的 saveWorkflowTemplate /
//   renameWorkflowTemplate / deleteWorkflowTemplate），GUI 节点库面板读同一张表。
// - 组合保存的节点/连线拓扑与 GUI「保存节点 → 流程模板」同构（nodeType/title/dx/dy/
//   w/h/text/config + fromIdx/toIdx/fromPort/toPort），额外记录媒体引用（media/
//   mediaRefs），GUI 插入仍按"纯结构预设"清空媒体（既有行为，未在本包改变）。
// - 实例化不另建画布执行器：把条目翻译成一批 typed graph.patch 操作，走与
//   graph.patch 完全相同的权威宿主握手（renderer 校验 + 原子应用 + 正式保存 +
//   main 重读核对）；媒体先复制进目标项目再以 mediaId 注入 mediaResolutions，
//   外部输入始终只有 mediaId，不含路径。
// - 幂等由 dispatch 的 local_agent_operations 账本承担：同一幂等键重放原回执，
//   不产生第二份节点/媒体。
import { extensionForMime } from '../../shared/mime'
import { remapMediaReferences } from '../../shared/media-reference-remap'
import {
  resolvePatchReferences,
  type GraphPatchOp,
  type MediaResolutionMap
} from '../../shared/agent-access/graph-ops'
import {
  NODE_LIBRARY_MAX_EDGES,
  NODE_LIBRARY_MAX_NODES
} from '../../shared/agent-access/ops/node-library'
import { ACTIVE_NODE_TYPE_IDS, type ProjectFile } from '../../shared/types'
import { GraphVersionConflictError } from '../../shared/graph-snapshot-sync'
import { deleteMedia, listMedia, readMediaBuffer, saveBufferAsset } from '../store/media.repo'
import * as projects from '../store/projects.repo'
import {
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  renameWorkflowTemplate,
  saveWorkflowTemplate
} from '../store/workspace-state.repo'
import type { WorkflowTemplateRecord } from '../../shared/contracts'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { chatNodeAgent } from './skills'
import { DesktopAccessError, type AccessDesktop } from './desktop'

/** 条目 payload 的硬上限：超限明确拒绝，不静默截断用户正文。 */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024

type ActiveNodeType = (typeof ACTIVE_NODE_TYPE_IDS)[number]
type MediaDescriptor = { mediaId: string; mime: string; name?: string }

export interface NodeLibraryContext {
  activeProjectId: () => string | null
  desktop?: AccessDesktop
  /** agent.access 的 trace/span，供媒体复制事件关联；不新增事件类型。 */
  diagnostics?: { traceId: string; spanId: string }
}

/** 条目里的单个节点（GUI TemplateNode 的超集；额外键 GUI 侧忽略）。 */
interface LibraryNode {
  nodeType: string
  title: string
  dx: number
  dy: number
  w: number
  h: number
  text?: string
  config?: string
  media?: MediaDescriptor
  mediaRefs?: MediaDescriptor[]
}

interface LibraryEdge {
  fromIdx: number
  toIdx: number
  fromPort?: string
  toPort?: string
  connectOrder?: number
}

interface LibraryEntry {
  nodes: LibraryNode[]
  edges: LibraryEdge[]
}

function refuse(code: string, phase: string, detail?: string): never {
  throw new DesktopAccessError(code, false, `${phase}${detail ? `:${detail.slice(0, 240)}` : ''}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireEntry(entryId: string): WorkflowTemplateRecord {
  const entry = getWorkflowTemplate(entryId)
  if (!entry) refuse('NOT_FOUND', 'entry-read', entryId)
  return entry
}

function summary(entry: WorkflowTemplateRecord): {
  id: string
  name: string
  createdAt: number
  nodeCount: number
} {
  return {
    id: entry.id,
    name: entry.name.slice(0, 200),
    createdAt: entry.createdAt,
    nodeCount: entry.nodeCount
  }
}

/** 解析并校验条目 payload；损坏或超出实例化上限的条目明确拒绝（不静默截断）。 */
function parseEntry(entry: WorkflowTemplateRecord): LibraryEntry {
  if (entry.nodes.length > NODE_LIBRARY_MAX_NODES)
    refuse('ENTRY_TOO_LARGE', 'entry-read', 'nodes')
  if (entry.edges.length > NODE_LIBRARY_MAX_EDGES)
    refuse('ENTRY_TOO_LARGE', 'entry-read', 'edges')
  const nodes: LibraryNode[] = []
  for (const raw of entry.nodes) {
    if (!isRecord(raw)) refuse('ENTRY_INVALID', 'entry-read', 'node')
    if (
      typeof raw.nodeType !== 'string' ||
      !raw.nodeType ||
      typeof raw.title !== 'string' ||
      typeof raw.dx !== 'number' ||
      typeof raw.dy !== 'number' ||
      typeof raw.w !== 'number' ||
      typeof raw.h !== 'number'
    )
      refuse('ENTRY_INVALID', 'entry-read', 'node-fields')
    const media = isRecord(raw.media) && typeof raw.media.mediaId === 'string' ? raw.media : null
    nodes.push({
      nodeType: raw.nodeType,
      title: raw.title,
      dx: raw.dx,
      dy: raw.dy,
      w: raw.w,
      h: raw.h,
      ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
      ...(typeof raw.config === 'string' ? { config: raw.config } : {}),
      ...(media
        ? {
            media: {
              mediaId: media.mediaId as string,
              mime: typeof media.mime === 'string' ? media.mime : '',
              ...(typeof media.name === 'string' ? { name: media.name } : {})
            }
          }
        : {}),
      ...(Array.isArray(raw.mediaRefs)
        ? {
            mediaRefs: raw.mediaRefs.flatMap((ref): MediaDescriptor[] =>
              isRecord(ref) && typeof ref.mediaId === 'string'
                ? [
                    {
                      mediaId: ref.mediaId,
                      mime: typeof ref.mime === 'string' ? ref.mime : '',
                      ...(typeof ref.name === 'string' ? { name: ref.name } : {})
                    }
                  ]
                : []
            )
          }
        : {})
    })
  }
  if (nodes.length === 0) refuse('ENTRY_INVALID', 'entry-read', 'empty')
  const edges: LibraryEdge[] = []
  for (const raw of entry.edges) {
    if (!isRecord(raw)) refuse('ENTRY_INVALID', 'entry-read', 'edge')
    if (
      typeof raw.fromIdx !== 'number' ||
      typeof raw.toIdx !== 'number' ||
      !Number.isInteger(raw.fromIdx) ||
      !Number.isInteger(raw.toIdx) ||
      raw.fromIdx < 0 ||
      raw.toIdx < 0 ||
      raw.fromIdx >= nodes.length ||
      raw.toIdx >= nodes.length
    )
      refuse('ENTRY_INVALID', 'entry-read', 'edge-index')
    edges.push({
      fromIdx: raw.fromIdx,
      toIdx: raw.toIdx,
      ...(typeof raw.fromPort === 'string' ? { fromPort: raw.fromPort } : {}),
      ...(typeof raw.toPort === 'string' ? { toPort: raw.toPort } : {}),
      ...(typeof raw.connectOrder === 'number' && Number.isInteger(raw.connectOrder)
        ? { connectOrder: raw.connectOrder }
        : {})
    })
  }
  return { nodes, edges }
}

/** 条目引用的全部媒体（节点内容媒体 + 配置内声明的媒体引用），按首次出现去重。 */
function entryMediaRefs(entry: LibraryEntry): MediaDescriptor[] {
  const out: MediaDescriptor[] = []
  const seen = new Set<string>()
  const add = (ref: MediaDescriptor | undefined): void => {
    if (!ref || seen.has(ref.mediaId)) return
    seen.add(ref.mediaId)
    out.push(ref)
  }
  for (const node of entry.nodes) {
    add(node.media)
    for (const ref of node.mediaRefs ?? []) add(ref)
  }
  return out
}

/** 递归收集 JSON 里"恰好是源项目媒体 ID"的字符串（配置内嵌媒体引用）。 */
function configMediaRefs(
  value: unknown,
  known: ReadonlyMap<string, { mime: string; name?: string }>,
  out: Map<string, MediaDescriptor>
): void {
  if (typeof value === 'string') {
    const hit = known.get(value)
    if (hit && !out.has(value))
      out.set(value, { mediaId: value, mime: hit.mime, ...(hit.name ? { name: hit.name } : {}) })
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) configMediaRefs(item, known, out)
    return
  }
  if (!isRecord(value)) return
  for (const item of Object.values(value)) configMediaRefs(item, known, out)
}

/** 已持久化 tldraw 快照里的 node-card props（与 GUI 保存模板读取的 props 同源）。 */
function snapshotNodeProps(
  file: ProjectFile,
  nodeId: string
): Record<string, unknown> | null {
  const snapshot = file.tldrawSnapshot as { store?: unknown } | undefined
  const store = snapshot && isRecord(snapshot) ? snapshot.store : undefined
  if (!isRecord(store)) return null
  const record = store[nodeId]
  if (!isRecord(record) || record.type !== 'node-card' || !isRecord(record.props)) return null
  return record.props
}

function mediaDescriptor(
  mediaById: ReadonlyMap<string, { mime: string; name?: string }>,
  mediaId: string
): MediaDescriptor {
  const asset = mediaById.get(mediaId)
  return {
    mediaId,
    mime: asset?.mime ?? '',
    ...(asset?.name ? { name: asset.name } : {})
  }
}

/** 组合保存：选中节点（全类型）+ 它们之间的连线 → 节点库条目。 */
function composeEntry(input: Record<string, unknown>): unknown {
  const projectId = input.projectId as string
  const file = projects.openProject(projectId)
  if (!file) refuse('NOT_FOUND', 'read')
  const expected = input.expectedGraphVersion as number
  if (file.meta.graphVersion !== expected)
    throw new GraphVersionConflictError(expected, file.meta.graphVersion)
  const requested = input.nodeIds as string[]
  const unique: string[] = []
  for (const nodeId of requested) if (!unique.includes(nodeId)) unique.push(nodeId)
  if (unique.length === 0 || unique.length > NODE_LIBRARY_MAX_NODES)
    refuse('INVALID_INPUT', 'validate', 'nodeIds')
  const selected = unique.map((nodeId) => {
    const node = file.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) refuse('NODE_NOT_FOUND', 'precheck', nodeId)
    return node
  })
  const mediaById = new Map(
    listMedia(projectId).map((asset) => [
      asset.id,
      { mime: asset.mime, ...(asset.name ? { name: asset.name } : {}) }
    ])
  )
  const cx = selected.reduce((sum, node) => sum + node.x, 0) / selected.length
  const cy = selected.reduce((sum, node) => sum + node.y, 0) / selected.length
  const nodes: LibraryNode[] = selected.map((node) => {
    // 对话节点：只保存可复用的技能预设（与既有 node.library.save 同一策略），
    // 聊天历史/附件留在正文里，一律不进节点库。
    if (node.type === 'chat') {
      let agent: unknown
      try {
        agent = chatNodeAgent(node)
      } catch {
        refuse('CHAT_CONFIG_INVALID', 'template-validation', node.id)
      }
      return {
        nodeType: node.type,
        title: node.title.slice(0, 200),
        dx: round2(node.x - cx),
        dy: round2(node.y - cy),
        w: node.w,
        h: node.h,
        text: '',
        config: JSON.stringify({ agent })
      }
    }
    const props = snapshotNodeProps(file, node.id)
    const rawConfig =
      props && typeof props.config === 'string'
        ? props.config
        : typeof node.params.config === 'string'
          ? node.params.config
          : ''
    const refs = new Map<string, MediaDescriptor>()
    if (rawConfig.trim()) {
      try {
        configMediaRefs(JSON.parse(rawConfig), mediaById, refs)
      } catch {
        // 非 JSON 配置不属于结构化媒体引用；原样保存配置字符串。
      }
    }
    const contentMediaId =
      props && typeof props.mediaId === 'string' && props.mediaId
        ? props.mediaId
        : node.content.kind === 'media' && node.content.mediaId
          ? node.content.mediaId
          : undefined
    if (contentMediaId) refs.delete(contentMediaId)
    const text =
      props && typeof props.text === 'string'
        ? props.text
        : node.content.kind === 'text'
          ? node.content.text
          : ''
    return {
      nodeType: node.type,
      title: (props && typeof props.title === 'string' ? props.title : node.title).slice(0, 200),
      dx: round2(node.x - cx),
      dy: round2(node.y - cy),
      w: props && typeof props.w === 'number' ? props.w : node.w,
      h: props && typeof props.h === 'number' ? props.h : node.h,
      text,
      ...(rawConfig ? { config: rawConfig } : {}),
      ...(contentMediaId ? { media: mediaDescriptor(mediaById, contentMediaId) } : {}),
      ...(refs.size ? { mediaRefs: [...refs.values()] } : {})
    }
  })
  const indexOf = new Map(unique.map((nodeId, index) => [nodeId, index]))
  const selectedEdges = file.edges
    .filter((edge) => indexOf.has(edge.from.nodeId) && indexOf.has(edge.to.nodeId))
    .sort((a, b) => a.id.localeCompare(b.id))
  // 超出实例化批量上限时明确拒绝，不静默丢弃连线（拓扑缺失比失败更难发现）。
  if (selectedEdges.length > NODE_LIBRARY_MAX_EDGES)
    refuse('ENTRY_TOO_LARGE', 'template-validation', 'edges')
  const edges: LibraryEdge[] = selectedEdges.map((edge) => ({
      fromIdx: indexOf.get(edge.from.nodeId)!,
      toIdx: indexOf.get(edge.to.nodeId)!,
      ...(edge.from.portId ? { fromPort: edge.from.portId } : {}),
      ...(edge.to.portId ? { toPort: edge.to.portId } : {}),
      ...(edge.connectOrder !== undefined ? { connectOrder: edge.connectOrder } : {})
    }))
  const payload = { nodes, edges, nodeCount: nodes.length }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_ENTRY_BYTES)
    refuse('ENTRY_TOO_LARGE', 'template-validation')
  const entry = saveWorkflowTemplate({
    name: input.name as string,
    nodes: payload.nodes as unknown[],
    edges: payload.edges as unknown[],
    nodeCount: payload.nodeCount
  })
  return summary(entry)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function updateEntry(input: Record<string, unknown>): unknown {
  const entry = renameWorkflowTemplate(input.entryId as string, input.name as string)
  if (!entry) refuse('NOT_FOUND', 'entry-read', input.entryId as string)
  return summary(entry)
}

function deleteEntry(input: Record<string, unknown>): unknown {
  const entryId = input.entryId as string
  if (!deleteWorkflowTemplate(entryId)) refuse('NOT_FOUND', 'entry-read', entryId)
  return { entryId, deleted: true as const }
}

function getEntry(input: Record<string, unknown>): unknown {
  const entry = requireEntry(input.entryId as string)
  const payload = parseEntry(entry)
  return {
    entryId: entry.id,
    name: entry.name.slice(0, 200),
    createdAt: entry.createdAt,
    nodeCount: payload.nodes.length,
    impact: {
      nodeCount: payload.nodes.length,
      edgeCount: payload.edges.length,
      groupCount: 0
    },
    nodes: payload.nodes.map((node) => ({
      nodeType: node.nodeType,
      title: node.title,
      dx: node.dx,
      dy: node.dy,
      w: node.w,
      h: node.h,
      hasText: Boolean(node.text && node.text.trim()),
      configBytes: Buffer.byteLength(node.config ?? '', 'utf8'),
      ...(node.media ? { mediaId: node.media.mediaId } : {}),
      mediaRefCount: node.mediaRefs?.length ?? 0
    })),
    edges: payload.edges.map((edge) => ({
      fromIdx: edge.fromIdx,
      toIdx: edge.toIdx,
      ...(edge.fromPort ? { fromPort: edge.fromPort } : {}),
      ...(edge.toPort ? { toPort: edge.toPort } : {}),
      ...(edge.connectOrder !== undefined ? { connectOrder: edge.connectOrder } : {})
    }))
  }
}

function searchEntries(input: Record<string, unknown>): unknown {
  const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : ''
  const nodeType = typeof input.nodeType === 'string' ? input.nodeType : ''
  const all = listWorkflowTemplates().map((entry) => {
    const types = new Set<string>()
    for (const raw of entry.nodes)
      if (isRecord(raw) && typeof raw.nodeType === 'string') types.add(raw.nodeType)
    return { entry, types: [...types] }
  })
  const matched = all.filter(({ entry, types }) => {
    if (nodeType && !types.includes(nodeType)) return false
    if (!query) return true
    const haystack = [
      entry.name,
      ...types,
      ...entry.nodes.flatMap((raw): string[] =>
        isRecord(raw) && typeof raw.title === 'string' ? [raw.title] : []
      )
    ]
    return haystack.some((value) => value.toLocaleLowerCase().includes(query))
  })
  const offset = input.offset as number
  const limit = input.limit as number
  return {
    total: matched.length,
    items: matched.slice(offset, offset + limit).map(({ entry, types }) => ({
      id: entry.id,
      name: entry.name.slice(0, 200),
      createdAt: entry.createdAt,
      nodeCount: entry.nodeCount,
      nodeTypes: types.slice(0, NODE_LIBRARY_MAX_NODES)
    }))
  }
}

/** 把条目翻译成 typed 图操作；mediaMap 给出重映射后的目标项目媒体 ID。 */
function buildInsertOps(
  entry: LibraryEntry,
  origin: { x: number; y: number },
  mediaMap: ReadonlyMap<string, string>,
  includeMedia: boolean
): { ops: GraphPatchOp[]; skippedEdges: number } {
  const ops: GraphPatchOp[] = []
  entry.nodes.forEach((node, index) => {
    let config: Record<string, unknown> | undefined
    if (node.config && node.config.trim()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(node.config)
      } catch {
        refuse('ENTRY_INVALID', 'entry-read', 'config-json')
      }
      if (!isRecord(parsed)) refuse('ENTRY_INVALID', 'entry-read', 'config-shape')
      config = remapMediaReferences(parsed, { ids: mediaMap, paths: new Map() })
    }
    const mediaId = node.media ? mediaMap.get(node.media.mediaId) : undefined
    if (includeMedia && node.media && !mediaId)
      refuse('MEDIA_NOT_FOUND', 'media-copy', node.media.mediaId)
    ops.push({
      action: 'node.create',
      ref: `n${index}`,
      nodeType: node.nodeType as ActiveNodeType,
      title: node.title,
      x: origin.x + node.dx,
      y: origin.y + node.dy,
      w: node.w,
      h: node.h,
      ...(node.text !== undefined ? { text: node.text } : {}),
      ...(config ? { config } : {}),
      ...(mediaId ? { media: { mediaId } } : {})
    })
  })
  let skippedEdges = 0
  entry.edges.forEach((edge, index) => {
    if (!edge.fromPort || !edge.toPort) {
      skippedEdges += 1
      return
    }
    ops.push({
      action: 'edge.create',
      ref: `e${index}`,
      from: { nodeId: `n${edge.fromIdx}`, portId: edge.fromPort },
      to: { nodeId: `n${edge.toIdx}`, portId: edge.toPort },
      ...(edge.connectOrder !== undefined ? { connectOrder: edge.connectOrder } : {})
    })
  })
  return { ops, skippedEdges }
}

/** 实例化到目标项目画布：媒体复制 → 权威宿主 graph-patch 握手 → 重读核对。 */
async function insertEntry(
  input: Record<string, unknown>,
  context: NodeLibraryContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const entryId = input.entryId as string
  if (context.activeProjectId() !== projectId || !context.desktop)
    refuse(
      'ACTIVE_PROJECT_REQUIRED',
      'desktop-ownership',
      'project.open the target canvas first, then retry node.library.insert'
    )
  const entry = requireEntry(entryId)
  const payload = parseEntry(entry)
  const file = projects.openProject(projectId)
  if (!file) refuse('NOT_FOUND', 'read')
  const expected = input.expectedGraphVersion as number
  if (file.meta.graphVersion !== expected)
    throw new GraphVersionConflictError(expected, file.meta.graphVersion)
  const origin = {
    x: typeof input.x === 'number' ? input.x : 0,
    y: typeof input.y === 'number' ? input.y : 0
  }
  // 结构预检在任何副作用之前：引用可解析、条目配置可迁移（此时还没有复制媒体）。
  const structural = buildInsertOps(payload, origin, new Map(), false)
  const resolved = resolvePatchReferences(structural.ops, {
    nodes: file.nodes,
    edges: file.edges
  })
  if (!resolved.ok)
    refuse(
      'PATCH_REFERENCE_INVALID',
      'precheck',
      resolved.errors
        .slice(0, 5)
        .map((error) => `op[${error.index}]:${error.code}`)
        .join(',')
    )
  const diagnostics = {
    ...(context.diagnostics?.traceId ? { traceId: context.diagnostics.traceId } : {}),
    ...(context.diagnostics?.spanId ? { spanId: context.diagnostics.spanId } : {}),
    projectId
  }
  // 媒体：把条目引用的源媒体复制进目标项目（每个项目一份受控媒体，跨画布不串用）。
  const mediaMap = new Map<string, string>()
  const copied: Array<{ entryMediaId: string; mediaId: string }> = []
  const rollbackCopies = async (): Promise<void> => {
    for (const item of copied) {
      try {
        await deleteMedia(item.mediaId)
      } catch {
        // 补偿失败不掩盖原始错误；残留媒体归属目标项目，不会被其他项目引用。
      }
    }
    copied.length = 0
    mediaMap.clear()
  }
  try {
    for (const ref of entryMediaRefs(payload)) {
      if (mediaMap.has(ref.mediaId)) continue
      const read = await readMediaBuffer(ref.mediaId)
      if (!read) refuse('MEDIA_NOT_FOUND', 'media-copy', ref.mediaId)
      emitGatewayEvent('media.buffer_import.started', '节点库媒体复制开始', diagnostics, {
        byteSize: read.buf.length,
        mime: read.mime || 'application/octet-stream'
      })
      let asset: Awaited<ReturnType<typeof saveBufferAsset>> | null = null
      try {
        asset = await saveBufferAsset(
          projectId,
          read.buf,
          extensionForMime(read.mime) || '.bin',
          ref.name ?? ref.mediaId
        )
      } catch {
        asset = null
      }
      if (!asset) {
        emitGatewayEvent('media.buffer_import.failed', '节点库媒体复制失败', diagnostics, {
          phase: 'media-copy'
        })
        refuse('MEDIA_NOT_FOUND', 'media-copy', ref.mediaId)
      }
      mediaMap.set(ref.mediaId, asset.id)
      copied.push({ entryMediaId: ref.mediaId, mediaId: asset.id })
      emitGatewayEvent('media.buffer_import.completed', '节点库媒体复制完成', diagnostics, {
        mediaId: asset.id,
        byteSize: asset.sizeBytes,
        mime: asset.mime
      })
    }
  } catch (error) {
    await rollbackCopies()
    throw error
  }
  let handshake: { graphVersion: number; result?: unknown }
  let admitted = false
  try {
    const targetMedia = new Map(listMedia(projectId).map((asset) => [asset.id, asset]))
    const mediaResolutions: MediaResolutionMap = {}
    for (const item of copied) {
      const asset = targetMedia.get(item.mediaId)
      if (!asset) refuse('MEDIA_NOT_FOUND', 'media-copy', item.mediaId)
      mediaResolutions[item.mediaId] = {
        mediaId: asset.id,
        mediaPath: asset.path,
        mediaMime: asset.mime,
        ...(asset.name ? { name: asset.name.slice(0, 200) } : {})
      }
    }
    const final = buildInsertOps(payload, origin, mediaMap, true)
    handshake = await context.desktop.run(
      {
        action: 'graph-patch',
        projectId,
        ops: final.ops,
        expectedGraphVersion: expected,
        ...(Object.keys(mediaResolutions).length ? { mediaResolutions } : {})
      },
      (version) => {
        if (context.activeProjectId() !== projectId)
          throw new DesktopAccessError('RESOURCE_BUSY', false, 'desktop-ownership')
        const admittedFile = projects.openProject(projectId)
        if (!admittedFile || admittedFile.meta.graphVersion !== version)
          throw new DesktopAccessError('REVISION_CONFLICT', false, `admission expected ${version}`)
        admitted = true
        return admittedFile.meta
      }
    )
  } catch (error) {
    // 准入前失败：宿主尚未应用任何编辑，回收本次复制的媒体（不留孤儿）。
    // 准入后失败按 unknown 语义保留媒体——它可能已被恢复出来的节点引用。
    if (!admitted) await rollbackCopies()
    throw error
  }
  const saved = projects.openProject(projectId)
  if (!saved || saved.meta.graphVersion !== handshake.graphVersion)
    throw new DesktopAccessError('STORAGE_INCONSISTENT', true, 'insert-verify')
  const outcome = (handshake.result ?? {}) as {
    created?: Array<{ ref?: string; nodeId?: string }>
    counts?: Partial<
      Record<'nodeCreated' | 'nodeUpdated' | 'nodeDeleted' | 'edgeCreated' | 'edgeDeleted', number>
    >
  }
  const createdIds = (outcome.created ?? []).filter(
    (item): item is { ref?: string; nodeId: string } => typeof item.nodeId === 'string'
  )
  for (const item of createdIds) {
    const persisted =
      saved.nodes.some((node) => node.id === item.nodeId) ||
      saved.edges.some((edge) => edge.id === item.nodeId)
    if (!persisted)
      throw new DesktopAccessError(
        'STORAGE_INCONSISTENT',
        true,
        `missing ${item.nodeId.slice(0, 60)}`
      )
  }
  const skippedEdges = structural.skippedEdges
  const zero = { nodeCreated: 0, nodeUpdated: 0, nodeDeleted: 0, edgeCreated: 0, edgeDeleted: 0 }
  return {
    projectId,
    graphVersion: handshake.graphVersion,
    saved: true as const,
    entryId,
    created: createdIds.map((item) => ({
      ...(item.ref ? { ref: item.ref } : {}),
      nodeId: item.nodeId
    })),
    applied: { ...zero, ...(outcome.counts ?? {}) },
    media: copied,
    skippedEdges
  }
}

/** node.library.* 的统一入口；未知分支由类型系统与 dispatch 双重兜底。 */
export function runNodeLibraryOperation(
  operation: string,
  input: Record<string, unknown>,
  context: NodeLibraryContext
): unknown {
  switch (operation) {
    case 'node.library.compose':
      return composeEntry(input)
    case 'node.library.update':
      return updateEntry(input)
    case 'node.library.delete':
      return deleteEntry(input)
    case 'node.library.get':
      return getEntry(input)
    case 'node.library.search':
      return searchEntries(input)
    case 'node.library.insert':
      return insertEntry(input, context)
    default:
      throw new DesktopAccessError('UNSUPPORTED_OPERATION', false, 'node-library-dispatch')
  }
}
