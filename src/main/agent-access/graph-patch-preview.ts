import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { GraphPatchOp } from '../../shared/agent-access/graph-ops'
import type { ProjectFile } from '../../shared/types'
import { layoutGraph } from '../../shared/flow-layout'

export interface GraphPatchPreviewNode {
  id: string
  type: string
  title: string
  text: string
  config: string
  contractVersion: number
  x: number
  y: number
}

export interface GraphPatchPreviewEdge {
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}

export interface GraphPatchPreviewSummary {
  nodeCreated: number
  nodeUpdated: number
  nodeDeleted: number
  edgeCreated: number
  edgeDeleted: number
}

/**
 * 方案 A：外部 Agent 全 34 节点 graph.patch 幽灵预览记录。
 * 复用既有 `flow_builds` 表（source='patch'），零数据库迁移，与 FlowGraph 预览共用同一幽灵渲染层与确认面板。
 */
export interface GraphPatchPreviewRecord {
  previewKind: 'patch'
  buildId: string
  projectId: string
  nodeId: string
  semanticRevision: string
  state: 'preview' | 'committed' | 'discarded'
  name: string
  expectedGraphVersion: number
  autoLayout: boolean
  ops: GraphPatchOp[]
  nodes: GraphPatchPreviewNode[]
  edges: GraphPatchPreviewEdge[]
  /** 拟修改的已有节点 ID 列表（画布叠加蓝色虚线高亮框）。 */
  updatedNodeIds: string[]
  /** 拟删除的已有节点 ID 列表（画布叠加红色删除高亮框）。 */
  deletedNodeIds: string[]
  summary: GraphPatchPreviewSummary
  createdAt: number
}

export function buildGraphPatchPreview(options: {
  projectId: string
  name?: string
  expectedGraphVersion: number
  autoLayout: boolean
  ops: GraphPatchOp[]
  currentFile: ProjectFile
}): GraphPatchPreviewRecord {
  const { projectId, expectedGraphVersion, autoLayout, ops, currentFile } = options
  const buildId = `patch:${randomUUID()}`
  const summary: GraphPatchPreviewSummary = {
    nodeCreated: 0,
    nodeUpdated: 0,
    nodeDeleted: 0,
    edgeCreated: 0,
    edgeDeleted: 0
  }

  const refToPreviewId = new Map<string, string>()
  const nodes: GraphPatchPreviewNode[] = []
  const edges: GraphPatchPreviewEdge[] = []
  const updatedNodeIdSet = new Set<string>()
  const deletedNodeIdSet = new Set<string>()

  for (const [index, op] of ops.entries()) {
    if (op.action === 'node.create') {
      summary.nodeCreated += 1
      const id = op.ref ? `preview:${op.ref}` : `preview:node-${index}`
      if (op.ref) refToPreviewId.set(op.ref, id)
      nodes.push({
        id,
        type: op.nodeType,
        title: op.title?.trim() || op.nodeType,
        text: (op.text ?? '').slice(0, 120),
        config: op.config ? JSON.stringify(op.config) : '',
        contractVersion: 1,
        x: op.x,
        y: op.y
      })
    } else if (op.action === 'node.duplicate') {
      summary.nodeCreated += 1
      const source = currentFile.nodes.find((n) => n.id === op.nodeId)
      const snapshotStore = (
        currentFile.tldrawSnapshot as { store?: Record<string, { x?: number; y?: number }> } | undefined
      )?.store
      const snap = snapshotStore?.[op.nodeId]
      const id = op.ref ? `preview:${op.ref}` : `preview:dup-${index}`
      if (op.ref) refToPreviewId.set(op.ref, id)
      nodes.push({
        id,
        type: source?.type ?? 'text',
        title: op.title?.trim() || (source?.title ? `${source.title} 副本` : '节点副本'),
        text: '',
        config: '',
        contractVersion: source?.contractVersion ?? 1,
        x: (typeof snap?.x === 'number' ? snap.x : 0) + (op.dx ?? 40),
        y: (typeof snap?.y === 'number' ? snap.y : 0) + (op.dy ?? 40)
      })
    } else if (
      op.action === 'node.update' ||
      op.action === 'chat.patch' ||
      op.action === 'node.select-result'
    ) {
      summary.nodeUpdated += 1
      if (!refToPreviewId.has(op.nodeId)) updatedNodeIdSet.add(op.nodeId)
    } else if (op.action === 'node.delete') {
      summary.nodeDeleted += 1
      updatedNodeIdSet.delete(op.nodeId)
      deletedNodeIdSet.add(op.nodeId)
    } else if (op.action === 'edge.create') {
      summary.edgeCreated += 1
      const fromId = refToPreviewId.get(op.from.nodeId) ?? op.from.nodeId
      const toId = refToPreviewId.get(op.to.nodeId) ?? op.to.nodeId
      edges.push({
        from: { nodeId: fromId, portId: op.from.portId },
        to: { nodeId: toId, portId: op.to.portId }
      })
    } else if (op.action === 'edge.delete') {
      summary.edgeDeleted += 1
    }
  }

  // 若启用 autoLayout 且本批新建了多个节点，用共享 layoutGraph 给出清晰预览位置。
  if (autoLayout && nodes.length >= 2) {
    const layout = layoutGraph(
      nodes.map((node) => ({
        id: node.id,
        type: node.type,
        x: node.x,
        y: node.y,
        w: 340,
        h: 300,
        title: node.title
      })),
      edges
        .filter(
          (edge) =>
            nodes.some((n) => n.id === edge.from.nodeId) &&
            nodes.some((n) => n.id === edge.to.nodeId)
        )
        .map((edge) => ({ from: edge.from.nodeId, to: edge.to.nodeId })),
      'flow',
      {
        origin: {
          x: Math.min(...nodes.map((n) => n.x)),
          y: Math.min(...nodes.map((n) => n.y))
        }
      }
    )
    const posMap = new Map(layout.positions.map((pos) => [pos.id, pos]))
    for (const node of nodes) {
      const pos = posMap.get(node.id)
      if (pos) {
        node.x = pos.x
        node.y = pos.y
      }
    }
  }

  const defaultNameParts: string[] = []
  if (summary.nodeCreated > 0) defaultNameParts.push(`+${summary.nodeCreated} 节点`)
  if (summary.nodeUpdated > 0) defaultNameParts.push(`改 ${summary.nodeUpdated} 节点`)
  if (summary.nodeDeleted > 0) defaultNameParts.push(`删 ${summary.nodeDeleted} 节点`)
  if (summary.edgeCreated > 0) defaultNameParts.push(`+${summary.edgeCreated} 连线`)
  if (summary.edgeDeleted > 0) defaultNameParts.push(`删 ${summary.edgeDeleted} 连线`)

  return {
    previewKind: 'patch',
    buildId,
    projectId,
    nodeId: buildId,
    semanticRevision: `graph-v${expectedGraphVersion}`,
    state: 'preview',
    name: options.name?.trim() || `外部画布变更（${defaultNameParts.join(' · ') || `${ops.length} 项`}）`,
    expectedGraphVersion,
    autoLayout,
    ops,
    nodes,
    edges,
    updatedNodeIds: [...updatedNodeIdSet],
    deletedNodeIds: [...deletedNodeIdSet],
    summary,
    createdAt: Date.now()
  }
}

export function saveGraphPatchPreview(db: Database.Database, record: GraphPatchPreviewRecord): void {
  db.prepare(
    `INSERT INTO flow_builds(project_id, node_id, build_id, body_json, source)
     VALUES (?, ?, ?, ?, 'patch')
     ON CONFLICT(project_id, build_id) DO UPDATE SET body_json = excluded.body_json, source = 'patch'`
  ).run(record.projectId, record.nodeId, record.buildId, JSON.stringify(record))
}

export function getGraphPatchPreview(
  db: Database.Database,
  projectId: string,
  previewId: string
): GraphPatchPreviewRecord | null {
  const row = db
    .prepare(
      `SELECT body_json FROM flow_builds WHERE project_id = ? AND build_id = ? AND source = 'patch'`
    )
    .get(projectId, previewId) as { body_json: string } | undefined
  if (!row) return null
  return JSON.parse(row.body_json) as GraphPatchPreviewRecord
}

export function listGraphPatchPreviews(
  db: Database.Database,
  projectId: string
): GraphPatchPreviewRecord[] {
  const rows = db
    .prepare(
      `SELECT body_json FROM flow_builds WHERE project_id = ? AND source = 'patch' ORDER BY rowid DESC`
    )
    .all(projectId) as Array<{ body_json: string }>
  return rows.map((row) => JSON.parse(row.body_json) as GraphPatchPreviewRecord)
}

export function updateGraphPatchPreviewState(
  db: Database.Database,
  projectId: string,
  previewId: string,
  state: 'committed' | 'discarded'
): GraphPatchPreviewRecord | null {
  const existing = getGraphPatchPreview(db, projectId, previewId)
  if (!existing) return null
  if (existing.state === 'committed' && state === 'discarded') return existing
  const updated: GraphPatchPreviewRecord = { ...existing, state }
  saveGraphPatchPreview(db, updated)
  return updated
}
