// 图写入事务的共享协议：Agent 写入图数据时，同步维护 tldraw 快照。
//
// 背景（HANDOFF_2026_09_01_AGENT_SAFETY_BASELINE P2）：桌面画布的 node-card /
// arrow / binding 是 project.json 里 nodes/edges 的可视载体。若 Agent 只写图数据
// 不写快照，会出现"图数据存在、画布不可见、下次保存被覆盖"。本模块让无界面
// 入口（CLI/MCP/应用服务层）以纯 JSON 方式维护两份数据的一致性，不依赖
// tldraw 运行时。
//
// 注意：record 结构对齐 tldraw 4.5.12 的 store snapshot 序列化格式（实测真实
// 项目文件）。升级 tldraw 时必须同步核对本文件的默认 props 与 schema 常量。

import { nanoid } from 'nanoid'
import type { CanvasEdge, CanvasNode, GroupDecl } from './types'

// ── 版本冲突错误 ─────────────────────────────────────────────

/** 保存时检测到 graphVersion 已前进（其他主体先写入）。事务整体失败，文件未动。 */
export class GraphVersionConflictError extends Error {
  readonly expectedVersion: number
  readonly actualVersion: number

  constructor(expectedVersion: number, actualVersion: number) {
    super(`项目版本冲突：期望 ${expectedVersion}，当前 ${actualVersion}`)
    this.name = 'GraphVersionConflictError'
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
  }
}

/**
 * 另一个进程正持有同一项目的图写入锁。
 *
 * 这不是一个可重试的“成功”：调用者应重新读取项目，并使用新的 revision 重试。
 * 通过明确的错误类型避免把跨进程竞争误报成普通 I/O 故障。
 */
export class GraphWriteInProgressError extends Error {
  constructor() {
    super('项目正在被另一项写入操作更新，请重新读取后再试')
    this.name = 'GraphWriteInProgressError'
  }
}

// ── tldraw 快照基础结构 ──────────────────────────────────────

/**
 * tldraw 4.5.12 序列化 schema。migrateSnapshot 会读取 snapshot.schema 判断
 * 迁移路径，缺失该键会在升级检查时抛 TypeError 导致整份快照加载失败，
 * 因此新建快照必须带上。升级 tldraw 后需用真实保存的快照核对此常量。
 */
const TL_SNAPSHOT_SCHEMA = {
  schemaVersion: 2,
  sequences: {
    'com.tldraw.store': 5,
    'com.tldraw.asset': 1,
    'com.tldraw.camera': 1,
    'com.tldraw.document': 2,
    'com.tldraw.instance': 26,
    'com.tldraw.instance_page_state': 5,
    'com.tldraw.page': 1,
    'com.tldraw.instance_presence': 6,
    'com.tldraw.pointer': 1,
    'com.tldraw.shape': 4,
    'com.tldraw.asset.bookmark': 2,
    'com.tldraw.asset.image': 6,
    'com.tldraw.asset.video': 5,
    'com.tldraw.shape.group': 0,
    'com.tldraw.shape.text': 4,
    'com.tldraw.shape.bookmark': 2,
    'com.tldraw.shape.draw': 4,
    'com.tldraw.shape.geo': 11,
    'com.tldraw.shape.note': 10,
    'com.tldraw.shape.line': 5,
    'com.tldraw.shape.frame': 1,
    'com.tldraw.shape.arrow': 8,
    'com.tldraw.shape.highlight': 3,
    'com.tldraw.shape.embed': 4,
    'com.tldraw.shape.image': 5,
    'com.tldraw.shape.video': 4,
    'com.tldraw.shape.node-card': 1,
    'com.tldraw.binding.arrow': 1
  }
} as const

const PAGE_ID = 'page:page'
const DOCUMENT_ID = 'document:document'

const PAGE_RECORD = {
  typeName: 'page',
  id: PAGE_ID,
  name: 'Page 1',
  index: 'a1',
  meta: {}
}

const DOCUMENT_RECORD = {
  typeName: 'document',
  id: DOCUMENT_ID,
  gridSize: 10,
  name: '',
  meta: {}
}

// ── 内部工具 ─────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 图数据 id 与 tldraw shape id 同源：renderer 侧 deriveGraph 直接用 shape.id。 */
function toShapeId(id: string): string {
  return id.startsWith('shape:') ? id : `shape:${id}`
}

/** 与 renderer registry.portOffsets 相同的端口纵向落点算法（不引入 React 依赖）。 */
function portOffsets(count: number, cardH: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [cardH / 2]
  if (count === 2) return [cardH / 4, (cardH * 3) / 4]
  return Array.from({ length: count }, (_, i) => (cardH * (i + 1)) / (count + 1))
}

function clamp01(v: number): number {
  return Math.max(0.02, Math.min(0.98, v))
}

/**
 * 生成排在所有现有同级 shape 之后的新 fractional index。
 * tldraw 用字符串 index 决定 z-order；同前缀追加字符必然更大。
 */
function nextSiblingIndex(store: UnknownRecord): string {
  let max = ''
  for (const record of Object.values(store)) {
    if (!isRecord(record) || record.typeName !== 'shape') continue
    const index = record.index
    if (typeof index === 'string' && index > max) max = index
  }
  return max ? `${max}a1` : 'a1'
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** node-card 默认 props：与 renderer NodeCardShape 的默认值对齐。 */
function nodeCardProps(node: CanvasNode): UnknownRecord {
  const config = typeof node.params?.config === 'string' ? node.params.config : ''
  const content = node.content ?? { kind: 'empty' }
  return {
    w: node.w,
    h: node.h,
    nodeType: node.type,
    title: node.title,
    config,
    text: content.kind === 'text' ? content.text : '',
    mediaId: content.kind === 'media' ? content.mediaId : '',
    mediaPath: '',
    mediaMime: '',
    exec: node.exec?.status ?? 'idle'
  }
}

function makeNodeCardRecord(node: CanvasNode, index: string): UnknownRecord {
  return {
    id: toShapeId(node.id),
    typeName: 'shape',
    type: 'node-card',
    x: node.x,
    y: node.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    parentId: PAGE_ID,
    index,
    meta: {},
    props: nodeCardProps(node)
  }
}

function arrowRecord(
  edge: CanvasEdge,
  start: { x: number; y: number },
  end: { x: number; y: number },
  bend: number,
  index: string
): UnknownRecord {
  return {
    id: toShapeId(edge.id),
    typeName: 'shape',
    type: 'arrow',
    x: start.x,
    y: start.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    parentId: PAGE_ID,
    index,
    meta: { fromPort: edge.from.portId, toPort: edge.to.portId },
    props: {
      kind: 'arc',
      elbowMidPoint: 0.5,
      dash: 'dashed',
      size: 'm',
      fill: 'none',
      color: 'grey',
      labelColor: 'black',
      bend,
      start: { x: 0, y: 0 },
      end: { x: end.x - start.x, y: end.y - start.y },
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      richText: { type: 'doc', content: [{ type: 'paragraph' }] },
      labelPosition: 0.5,
      font: 'sans',
      scale: 1
    }
  }
}

function bindingRecord(
  arrowShapeId: string,
  nodeShapeId: string,
  terminal: 'start' | 'end',
  anchor: { x: number; y: number }
): UnknownRecord {
  return {
    id: `binding:${nanoid(17)}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: arrowShapeId,
    toId: nodeShapeId,
    props: {
      terminal,
      normalizedAnchor: anchor,
      isExact: false,
      isPrecise: true,
      snap: 'none'
    },
    meta: {}
  }
}

/** 图数据中该边源/目标端口的纵向落点；端口声明缺失时退回卡片中线。 */
function portY(node: CanvasNode, portId: string, dir: 'in' | 'out'): number {
  const ports = (node.ports ?? []).filter((p) => p.dir === dir)
  const idx = ports.findIndex((p) => p.id === portId)
  if (idx === -1) return node.h / 2
  return portOffsets(ports.length, node.h)[idx] ?? node.h / 2
}

// ── 主流程 ───────────────────────────────────────────────────

export interface GraphSnapshotSyncResult {
  /** 同步后的完整快照（原快照的其他 record 与顶层键原样保留）。 */
  snapshot: unknown
  /** 本次同步是否改变了快照内容（幂等性判定用）。 */
  changed: boolean
}

/**
 * 把图数据（nodes/edges/groups）同步进 tldraw 快照：
 * - 新节点 → 新增 node-card record；已有节点 → 原位更新位置与 props，
 *   保留 meta.nodeResult / nodeRun 等运行数据
 * - 新边 → 新增 arrow record + start/end 两条 binding；已有边 → 更新端口与几何
 * - 图数据中已删除的节点/边 → 快照中对应 node-card / arrow / binding 一并移除
 * - 无有效快照时构建可被 renderer loadStoreSnapshot 直接加载的最小快照
 *
 * groups 暂不生成 tldraw group record：Agent 服务层没有分组操作，画布分组仍由
 * renderer 侧创建与维护；此处仅保证已有分组 record 不被误删。
 */
export function syncGraphSnapshot(
  snapshot: unknown,
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[]; groups: GroupDecl[] }
): GraphSnapshotSyncResult {
  const baseStore = isRecord(snapshot) && isRecord(snapshot.store) ? snapshot.store : null
  const base = isRecord(snapshot) && baseStore !== null ? snapshot : null
  const originalStore = baseStore ? { ...baseStore } : null

  const store: UnknownRecord = baseStore ? { ...baseStore } : {}
  // 快照缺 page/document record 时补齐：loadStoreSnapshot 后 editor 依赖两者存在。
  if (!isRecord(store[PAGE_ID])) store[PAGE_ID] = PAGE_RECORD
  if (!isRecord(store[DOCUMENT_ID])) store[DOCUMENT_ID] = DOCUMENT_RECORD

  const nodeById = new Map<string, CanvasNode>()
  for (const node of graph.nodes) nodeById.set(node.id, node)

  // 1) 节点：新增或原位更新 node-card
  const keepShapeIds = new Set<string>()
  for (const node of graph.nodes) {
    const shapeId = toShapeId(node.id)
    keepShapeIds.add(shapeId)
    const existing = store[shapeId]
    if (isRecord(existing) && existing.type === 'node-card') {
      const existingProps = isRecord(existing.props) ? existing.props : {}
      store[shapeId] = {
        ...existing,
        x: node.x,
        y: node.y,
        props: { ...existingProps, ...nodeCardProps(node) }
      }
    } else {
      store[shapeId] = makeNodeCardRecord(node, nextSiblingIndex(store))
    }
  }

  // 2) 边：新增或更新 arrow + 两条 binding（跳过端点节点缺失的悬空边）
  const keepArrowIds = new Set<string>()
  for (const edge of graph.edges) {
    const fromNode = nodeById.get(edge.from.nodeId)
    const toNode = nodeById.get(edge.to.nodeId)
    if (!fromNode || !toNode) continue

    const arrowId = toShapeId(edge.id)
    keepArrowIds.add(arrowId)
    const fromShapeId = toShapeId(fromNode.id)
    const toShapeId2 = toShapeId(toNode.id)

    const fromY = portY(fromNode, edge.from.portId, 'out')
    const toY = portY(toNode, edge.to.portId, 'in')
    const start = { x: fromNode.x + fromNode.w, y: fromNode.y + fromY }
    const end = { x: toNode.x, y: toNode.y + toY }
    const connDist = Math.hypot(end.x - start.x, end.y - start.y)
    const bend = Math.max(20, Math.min(84, connDist * 0.16))

    const existing = store[arrowId]
    if (isRecord(existing) && existing.type === 'arrow') {
      const existingMeta = isRecord(existing.meta) ? existing.meta : {}
      const existingProps = isRecord(existing.props) ? existing.props : {}
      store[arrowId] = {
        ...existing,
        x: start.x,
        y: start.y,
        meta: { ...existingMeta, fromPort: edge.from.portId, toPort: edge.to.portId },
        props: {
          ...existingProps,
          bend,
          start: { x: 0, y: 0 },
          end: { x: end.x - start.x, y: end.y - start.y }
        }
      }
    } else {
      store[arrowId] = arrowRecord(edge, start, end, bend, nextSiblingIndex(store))
    }

    upsertArrowBinding(store, arrowId, fromShapeId, 'start', {
      x: 0.98,
      y: clamp01(fromY / fromNode.h)
    })
    upsertArrowBinding(store, arrowId, toShapeId2, 'end', { x: 0.02, y: clamp01(toY / toNode.h) })
  }

  // 3) 清理：图数据不再引用的 node-card / arrow，以及随之悬空的 binding
  const keepNodeShapeIds = new Set(graph.nodes.map((n) => toShapeId(n.id)))
  for (const [key, record] of Object.entries(store)) {
    if (!isRecord(record)) continue
    if (record.typeName === 'shape' && record.type === 'node-card') {
      if (!keepNodeShapeIds.has(key)) delete store[key]
    } else if (record.typeName === 'shape' && record.type === 'arrow') {
      if (!keepArrowIds.has(key)) delete store[key]
    }
  }
  for (const [key, record] of Object.entries(store)) {
    if (!isRecord(record) || record.typeName !== 'binding') continue
    const fromId = record.fromId
    const toId = record.toId
    const fromAlive =
      typeof fromId === 'string' && isRecord(store[fromId]) && store[fromId].typeName === 'shape'
    const toAlive =
      typeof toId === 'string' && isRecord(store[toId]) && store[toId].typeName === 'shape'
    if (!fromAlive || !toAlive) delete store[key]
  }

  const changed = originalStore === null || JSON.stringify(store) !== JSON.stringify(originalStore)
  const resultSnapshot = base ? { ...base, store } : { store, schema: TL_SNAPSHOT_SCHEMA }

  return { snapshot: resultSnapshot, changed }
}

/** 保证某条 arrow 恰好有一条指向目标节点、指定 terminal 的 binding。 */
function upsertArrowBinding(
  store: UnknownRecord,
  arrowShapeId: string,
  nodeShapeId: string,
  terminal: 'start' | 'end',
  anchor: { x: number; y: number }
): void {
  let found = false
  for (const [key, record] of Object.entries(store)) {
    if (!isRecord(record) || record.typeName !== 'binding') continue
    if (record.fromId !== arrowShapeId) continue
    const props = isRecord(record.props) ? record.props : {}
    if (props.terminal !== terminal) continue
    if (found || record.toId !== nodeShapeId) {
      // 同 terminal 的多余/错位 binding：删除后统一重建
      delete store[key]
      continue
    }
    store[key] = {
      ...record,
      toId: nodeShapeId,
      props: { ...props, terminal, normalizedAnchor: anchor }
    }
    found = true
  }
  if (!found) {
    const binding = bindingRecord(arrowShapeId, nodeShapeId, terminal, anchor)
    store[stringOr(binding.id, `binding:${nanoid(17)}`)] = binding
  }
}
