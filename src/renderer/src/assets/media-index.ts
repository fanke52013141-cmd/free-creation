// 项目级媒体索引：仅从已持久化的资产、节点结果和运行记录推导查询视图。
// 不写入项目、不扫描节点标题猜测数据流，也不读取 API Key 或完整提示词。
import type { MediaAsset } from '@shared/types'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { readNodeRunHistory, readNodeRunRecord, type NodeRunStatus } from '../engine/runRecord'
import { parseMediaResultCollection } from '../nodes/nodeValues'

export type MediaRunFilter = NodeRunStatus | 'unavailable' | 'all'
export type MediaTimeFilter = 'all' | 'today' | '7d' | '30d'

export interface MediaSourceSummary {
  nodeId: string
  nodeTitle: string
  nodeType: string
  modelKey?: string
  resultCount: number
  isCurrentOutput: boolean
  /** 产物对应的真实运行 ID；旧产物没有时回退到节点最近一次运行。 */
  runId?: string
  runStatus?: NodeRunStatus
  runStartedAt?: number
}

export interface IndexedMediaAsset extends MediaAsset {
  source?: MediaSourceSummary
}

export interface MediaIndexFilters {
  filter: MediaAsset['kind'] | 'all'
  keyword: string
  sourceNodeId: string | 'all'
  runStatus: MediaRunFilter
  timeRange: MediaTimeFilter
}

type SourceCandidate = MediaSourceSummary & { priority: number; createdAt: number }

function sourceForShape(
  shape: NodeCardShape,
  resultCount: number,
  isCurrentOutput: boolean,
  modelKey?: string,
  resultRunId?: string
): MediaSourceSummary {
  const currentRun = readNodeRunRecord(shape.meta?.nodeRun)
  const run =
    (resultRunId && currentRun?.runId === resultRunId ? currentRun : undefined) ??
    (resultRunId
      ? readNodeRunHistory(shape.meta?.nodeRunHistory).find(
          (record) => record.runId === resultRunId
        )
      : currentRun)
  return {
    nodeId: shape.id,
    nodeTitle: shape.props.title,
    nodeType: shape.props.nodeType,
    ...(modelKey ? { modelKey } : {}),
    resultCount,
    isCurrentOutput,
    ...(run
      ? {
          runId: run.runId,
          runStatus: run.status,
          runStartedAt: run.startedAt
        }
      : resultRunId
        ? { runId: resultRunId }
        : {})
  }
}

/**
 * 从媒体节点的持久化状态建立来源索引。集合结果优先于普通 mediaId 引用，
 * 同一个媒体被多个节点引用时取最新生成记录；这只影响展示和筛选，不改变端口输出。
 */
export function buildMediaAssetIndex(
  assets: readonly MediaAsset[],
  shapes: readonly NodeCardShape[]
): IndexedMediaAsset[] {
  const candidates = new Map<string, SourceCandidate>()
  const setCandidate = (mediaId: string, next: SourceCandidate): void => {
    if (!mediaId) return
    const current = candidates.get(mediaId)
    if (
      !current ||
      next.priority > current.priority ||
      (next.priority === current.priority && next.createdAt > current.createdAt)
    ) {
      candidates.set(mediaId, next)
    }
  }

  for (const shape of shapes) {
    const collection = parseMediaResultCollection(
      typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
    )
    const selectedMediaId = collection?.selectedMediaId || shape.props.mediaId
    if (collection?.results.length) {
      for (const result of collection.results) {
        setCandidate(result.mediaId, {
          ...sourceForShape(
            shape,
            collection.results.length,
            result.mediaId === selectedMediaId,
            result.modelKey || collection.modelKey,
            result.runId
          ),
          priority: 2,
          createdAt: result.createdAt
        })
      }
    }
    if (shape.props.mediaId) {
      setCandidate(shape.props.mediaId, {
        ...sourceForShape(
          shape,
          collection?.results.length ?? 1,
          shape.props.mediaId === selectedMediaId,
          collection?.modelKey
        ),
        priority: 1,
        createdAt: collection?.at ?? 0
      })
    }
  }

  return assets
    .map((asset) => {
      const candidate = candidates.get(asset.id)
      if (!candidate) return asset
      return {
        ...asset,
        source: {
          nodeId: candidate.nodeId,
          nodeTitle: candidate.nodeTitle,
          nodeType: candidate.nodeType,
          ...(candidate.modelKey ? { modelKey: candidate.modelKey } : {}),
          resultCount: candidate.resultCount,
          isCurrentOutput: candidate.isCurrentOutput,
          ...(candidate.runId ? { runId: candidate.runId } : {}),
          ...(candidate.runStatus ? { runStatus: candidate.runStatus } : {}),
          ...(candidate.runStartedAt ? { runStartedAt: candidate.runStartedAt } : {})
        }
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** 可供筛选的来源节点，稳定 nodeId 是值，标题仅用于显示。 */
export function mediaSourceOptions(assets: readonly IndexedMediaAsset[]): MediaSourceSummary[] {
  const options = new Map<string, MediaSourceSummary>()
  for (const asset of assets) {
    if (asset.source && !options.has(asset.source.nodeId))
      options.set(asset.source.nodeId, asset.source)
  }
  return [...options.values()].sort((a, b) => a.nodeTitle.localeCompare(b.nodeTitle, 'zh-CN'))
}

function timeStart(range: MediaTimeFilter, now: number): number | null {
  if (range === 'all') return null
  if (range === 'today') {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  return now - (range === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000
}

/** 资产筛选只使用资产字段和安全来源摘要，不搜索路径、密钥或完整提示词。 */
export function filterMediaAssets(
  assets: readonly IndexedMediaAsset[],
  filters: MediaIndexFilters,
  now = Date.now()
): IndexedMediaAsset[] {
  const keyword = filters.keyword.trim().toLocaleLowerCase()
  const start = timeStart(filters.timeRange, now)
  return assets.filter((asset) => {
    if (filters.filter !== 'all' && asset.kind !== filters.filter) return false
    if (filters.sourceNodeId !== 'all' && asset.source?.nodeId !== filters.sourceNodeId)
      return false
    const status = asset.source?.runStatus ?? 'unavailable'
    if (filters.runStatus !== 'all' && status !== filters.runStatus) return false
    if (start !== null && asset.createdAt < start) return false
    if (!keyword) return true
    return [asset.name, asset.id, asset.source?.nodeTitle, asset.source?.modelKey]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLocaleLowerCase().includes(keyword))
  })
}
