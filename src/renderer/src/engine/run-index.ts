// 跨节点运行中心的只读索引：把各节点 meta 中已持久化的运行记录扁平化为可筛选列表。
// 输入仅保留 nodeId/portId 来源，不复制正文、媒体二进制、API Key 或完整模型配置。
import type { NodeCardShape } from '../canvas/NodeCardShape'
import {
  readNodeRunHistory,
  readNodeRunRecord,
  type NodeRunRecord,
  type NodeRunStatus
} from './runRecord'

export interface IndexedNodeRun extends NodeRunRecord {
  nodeId: string
  nodeTitle: string
  nodeType: string
  isLatest: boolean
}

export type RunStatusFilter = NodeRunStatus | 'all'

export interface RunIndexFilters {
  status: RunStatusFilter
  keyword: string
  nodeId?: string
  runId?: string
}

function entryFor(shape: NodeCardShape, record: NodeRunRecord, isLatest: boolean): IndexedNodeRun {
  return {
    ...record,
    nodeId: shape.id,
    nodeTitle: shape.props.title,
    nodeType: shape.props.nodeType,
    isLatest
  }
}

/** 将当前记录与最近历史合并，按 runId 去重；运行中记录可显示在最前。 */
export function buildRunIndex(shapes: readonly NodeCardShape[]): IndexedNodeRun[] {
  const entries: IndexedNodeRun[] = []
  for (const shape of shapes) {
    const current = readNodeRunRecord(shape.meta?.nodeRun)
    const seen = new Set<string>()
    if (current) {
      entries.push(entryFor(shape, current, true))
      seen.add(current.runId)
    }
    for (const record of readNodeRunHistory(shape.meta?.nodeRunHistory)) {
      if (seen.has(record.runId)) continue
      entries.push(entryFor(shape, record, false))
      seen.add(record.runId)
    }
  }
  return entries.sort((a, b) => b.startedAt - a.startedAt)
}

/** 运行中心搜索节点标题、节点类型、运行 ID 和端口 ID，不读取输入正文。 */
export function filterRunIndex(
  entries: readonly IndexedNodeRun[],
  filters: RunIndexFilters
): IndexedNodeRun[] {
  const keyword = filters.keyword.trim().toLocaleLowerCase()
  return entries.filter((entry) => {
    if (filters.status !== 'all' && entry.status !== filters.status) return false
    if (filters.nodeId && entry.nodeId !== filters.nodeId) return false
    if (filters.runId && entry.runId !== filters.runId) return false
    if (!keyword) return true
    const sourcePorts = Object.entries(entry.inputs).flatMap(([target, sources]) => [
      target,
      ...sources.flatMap((source) => [source.nodeId, source.portId])
    ])
    return [entry.runId, entry.nodeTitle, entry.nodeType, ...sourcePorts].some((value) =>
      value.toLocaleLowerCase().includes(keyword)
    )
  })
}
