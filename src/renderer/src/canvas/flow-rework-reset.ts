import type { Editor, JsonObject, TLShapeId } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { deriveGraph } from './graph'
import { markUndoPoint } from './history'

export interface ArchivedDeliverySnapshot {
  archiveId: string
  archivedAt: number
  reason: 'upstream-rework'
  sourceNodeId: string
  text?: string
  mediaId?: string
  mediaPath?: string
  mediaMime?: string
  nodeResult?: string
  humanTask?: string
  agentTask?: string
}

const MAX_ARCHIVED_SNAPSHOTS = 10

/** 沿有向数据边 BFS 收集所有受 startNodeId 路径依赖影响的下游节点 id（不含无关并行分支）。 */
export function collectDownstreamNodeIds(
  edges: ReadonlyArray<{ from: string; to: string }>,
  startNodeId: string
): string[] {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.from)
    if (list) list.push(edge.to)
    else adjacency.set(edge.from, [edge.to])
  }
  const visited = new Set<string>([startNodeId])
  const result: string[] = []
  const queue: string[] = [startNodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      result.push(next)
      queue.push(next)
    }
  }
  return result
}

export function readArchivedDeliveries(shape: NodeCardShape): ArchivedDeliverySnapshot[] {
  const raw = (shape.meta as Record<string, unknown> | undefined)?.archivedDeliveries
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ArchivedDeliverySnapshot[]) : []
  } catch {
    return []
  }
}

function hasLiveDelivery(shape: NodeCardShape): boolean {
  const meta = (shape.meta as Record<string, unknown> | undefined) ?? {}
  if (typeof meta.nodeResult === 'string' && meta.nodeResult.trim()) return true
  if (typeof meta.humanTask === 'string' && meta.humanTask.trim()) return true
  if (typeof meta.agentTask === 'string' && meta.agentTask.trim()) return true
  if (shape.props.mediaId || shape.props.mediaPath) return true
  if (shape.props.exec && shape.props.exec !== 'idle') return true
  return false
}

/** 仅清理下游“执行产出”，不破坏用户填写的提示词/任务说明配置。 */
const MEDIA_OUTPUT_NODE_TYPES = new Set([
  'image-gen',
  'image-edit',
  'image-crop',
  'video',
  'video-clip',
  'video-depth',
  'video-clay',
  'video-frame',
  'speech',
  'tts',
  'sound-adjust',
  'silence-trim',
  'vocal-separate'
])

/**
 * 上游撤销/重做时的下游失效处理：
 * 1. 将每个受影响下游节点的当前有效产物归档进 meta.archivedDeliveries（软归档，不物理删毁）；
 * 2. 立即清空当前界面态的下游产出并将 exec 重置为 idle，避免脏数据混入流程。
 */
export function archiveAndClearDownstreamCanvasNodes(
  editor: Editor,
  startNodeId: string
): { clearedIds: string[]; archivedCount: number } {
  const graph = deriveGraph(editor)
  const downstreamIds = collectDownstreamNodeIds(
    graph.edges.map((e) => ({ from: e.from.nodeId, to: e.to.nodeId })),
    startNodeId
  )
  if (downstreamIds.length === 0) return { clearedIds: [], archivedCount: 0 }

  markUndoPoint(editor, 'flow-upstream-rework-reset')
  const clearedIds: string[] = []
  let archivedCount = 0

  for (const id of downstreamIds) {
    const shape = editor.getShape<NodeCardShape>(id as TLShapeId)
    if (!shape || shape.type !== 'node-card') continue
    const meta: JsonObject = { ...(shape.meta ?? {}) }
    const existing = readArchivedDeliveries(shape)

    if (hasLiveDelivery(shape)) {
      const snapshot: ArchivedDeliverySnapshot = {
        archiveId: crypto.randomUUID(),
        archivedAt: Date.now(),
        reason: 'upstream-rework',
        sourceNodeId: startNodeId,
        ...(shape.props.mediaId ? { mediaId: shape.props.mediaId } : {}),
        ...(shape.props.mediaPath ? { mediaPath: shape.props.mediaPath } : {}),
        ...(shape.props.mediaMime ? { mediaMime: shape.props.mediaMime } : {}),
        ...(typeof meta.nodeResult === 'string' ? { nodeResult: meta.nodeResult } : {}),
        ...(typeof meta.humanTask === 'string' ? { humanTask: meta.humanTask } : {}),
        ...(typeof meta.agentTask === 'string' ? { agentTask: meta.agentTask } : {})
      }
      meta.archivedDeliveries = JSON.stringify([snapshot, ...existing].slice(0, MAX_ARCHIVED_SNAPSHOTS))
      archivedCount += 1
    }

    delete meta.nodeResult
    delete meta.humanTask
    delete meta.humanTaskPending
    delete meta.agentTask
    delete meta.agentAssetVersionId
    delete meta.agentTaskId

    const clearMedia = MEDIA_OUTPUT_NODE_TYPES.has(shape.props.nodeType)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        exec: 'idle',
        ...(clearMedia ? { mediaId: '', mediaPath: '', mediaMime: '' } : {})
      },
      meta
    })
    clearedIds.push(id)
  }

  return { clearedIds, archivedCount }
}

/** 从历史归档中恢复某一条旧交付物到当前节点。 */
export function restoreArchivedDelivery(
  editor: Editor,
  nodeId: TLShapeId,
  archiveId: string
): boolean {
  const shape = editor.getShape<NodeCardShape>(nodeId)
  if (!shape || shape.type !== 'node-card') return false
  const list = readArchivedDeliveries(shape)
  const target = list.find((item) => item.archiveId === archiveId)
  if (!target) return false
  markUndoPoint(editor, 'flow-restore-archived-delivery')
  const meta: JsonObject = { ...(shape.meta ?? {}) }
  if (target.nodeResult !== undefined) meta.nodeResult = target.nodeResult
  if (target.humanTask !== undefined) meta.humanTask = target.humanTask
  if (target.agentTask !== undefined) meta.agentTask = target.agentTask
  editor.updateShape({
    id: shape.id,
    type: 'node-card',
    props: {
      exec: 'success',
      ...(target.mediaId !== undefined ? { mediaId: target.mediaId } : {}),
      ...(target.mediaPath !== undefined ? { mediaPath: target.mediaPath } : {}),
      ...(target.mediaMime !== undefined ? { mediaMime: target.mediaMime } : {})
    },
    meta
  })
  return true
}
