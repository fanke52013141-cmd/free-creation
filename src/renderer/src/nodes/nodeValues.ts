import type { NodeCardShape } from '../canvas/NodeCardShape'
import { getNodeType } from './registry'
import { readNodeRunRecord } from '../engine/runRecord'

export type NodeValue =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'json'; data: unknown }
  | { kind: 'image'; mediaId: string; mediaPath: string; mime: string }
  | { kind: 'video'; mediaId: string; mediaPath: string; mime: string }
  | { kind: 'audio'; mediaId: string; mediaPath: string; mime: string }
  | { kind: 'file'; mediaId: string; mediaPath: string; mime: string }

export type RawNodeOutputs = Partial<Record<string, NodeValue>>

export interface MediaResultItem {
  mediaId: string
  mediaPath: string
  mime: string
  createdAt: number
  modelKey?: string
  prompt?: string
  /** 生成该媒体的工作流运行 ID；旧结果可能没有此字段。 */
  runId?: string
}

export interface MediaResultCollection {
  kind: 'media-source'
  version: 1
  nodeId?: string
  modelKey?: string
  prompt?: string
  at?: number
  selectedMediaId?: string
  results: MediaResultItem[]
}

/** 防止长期重复生成导致 nodeResult 无限增长；最新结果优先保留。 */
export const MEDIA_RESULT_LIMIT = 12

export function parseMediaResultCollection(text: string): MediaResultCollection | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<MediaResultCollection>
    if (value.kind !== 'media-source') return null
    const results = Array.isArray(value.results)
      ? value.results.filter(
          (item): item is MediaResultItem =>
            Boolean(item) &&
            typeof item.mediaId === 'string' &&
            typeof item.mediaPath === 'string' &&
            typeof item.mime === 'string' &&
            typeof item.createdAt === 'number'
        )
      : []
    return {
      kind: 'media-source',
      version: 1,
      ...(typeof value.nodeId === 'string' ? { nodeId: value.nodeId } : {}),
      ...(typeof value.modelKey === 'string' ? { modelKey: value.modelKey } : {}),
      ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
      ...(typeof value.at === 'number' ? { at: value.at } : {}),
      ...(typeof value.selectedMediaId === 'string'
        ? { selectedMediaId: value.selectedMediaId }
        : {}),
      results
    }
  } catch {
    return null
  }
}

export function serializeMediaResultCollection(value: MediaResultCollection): string {
  return JSON.stringify(value)
}

export function appendMediaResult(
  previous: string,
  item: Omit<MediaResultItem, 'createdAt'> & { createdAt?: number },
  meta: Pick<MediaResultCollection, 'nodeId' | 'modelKey' | 'prompt'> & { runId?: string } = {}
): MediaResultCollection {
  const current = parseMediaResultCollection(previous)
  const results = current?.results.filter((result) => result.mediaId !== item.mediaId) ?? []
  const nextItem: MediaResultItem = {
    ...item,
    createdAt: item.createdAt ?? Date.now(),
    ...(meta.runId ? { runId: meta.runId } : {})
  }
  return {
    kind: 'media-source',
    version: 1,
    ...(current?.nodeId || meta.nodeId ? { nodeId: meta.nodeId || current?.nodeId } : {}),
    ...(meta.modelKey || current?.modelKey ? { modelKey: meta.modelKey || current?.modelKey } : {}),
    ...(meta.prompt || current?.prompt ? { prompt: meta.prompt || current?.prompt } : {}),
    at: nextItem.createdAt,
    selectedMediaId: nextItem.mediaId,
    results: [...results, nextItem].slice(-MEDIA_RESULT_LIMIT)
  }
}

/** 删除一个非当前结果；若误删当前结果，调用方应先切换到其他结果。 */
export function removeMediaResult(previous: string, mediaId: string): MediaResultCollection | null {
  const current = parseMediaResultCollection(previous)
  if (!current) return null
  const results = current.results.filter((item) => item.mediaId !== mediaId)
  const selectedMediaId =
    current.selectedMediaId && results.some((item) => item.mediaId === current.selectedMediaId)
      ? current.selectedMediaId
      : results.at(-1)?.mediaId
  return {
    ...current,
    at: results.at(-1)?.createdAt ?? current.at,
    ...(selectedMediaId ? { selectedMediaId } : { selectedMediaId: undefined }),
    results
  }
}

/** 清理历史候选但保留当前输出，确保下游端口和当前媒体资产不变。 */
export function clearMediaResultHistory(previous: string): MediaResultCollection | null {
  const current = parseMediaResultCollection(previous)
  if (!current) return null
  const selected =
    current.results.find((item) => item.mediaId === current.selectedMediaId) ??
    current.results.at(-1)
  return {
    ...current,
    results: selected ? [selected] : [],
    ...(selected ? { selectedMediaId: selected.mediaId, at: selected.createdAt } : {})
  }
}

export function parseStoredNodeValue(text: string): NodeValue | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if ((value.kind === 'text' || value.kind === 'markdown') && typeof value.text === 'string') {
      return { kind: value.kind, text: value.text }
    }
    if (value.kind === 'json' && 'data' in value) return { kind: 'json', data: value.data }
    if (
      (value.kind === 'image' ||
        value.kind === 'video' ||
        value.kind === 'audio' ||
        value.kind === 'file') &&
      typeof value.mediaId === 'string' &&
      typeof value.mediaPath === 'string' &&
      typeof value.mime === 'string'
    ) {
      return {
        kind: value.kind,
        mediaId: value.mediaId,
        mediaPath: value.mediaPath,
        mime: value.mime
      }
    }
  } catch {
    // 未产生过有效运行结果。
  }
  return null
}

export function parseNodeRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 解析 AI 处理节点存在 meta.nodeResult 的运行结果。 */
export function parseStoredAiResult(
  stored: string
): { kind: 'text' | 'markdown' | 'json'; text?: string; data?: unknown } | null {
  if (!stored) return null
  try {
    const value = JSON.parse(stored) as Record<string, unknown>
    if (value.kind === 'text' || value.kind === 'markdown' || value.kind === 'json') {
      return {
        kind: value.kind,
        ...(typeof value.text === 'string' ? { text: value.text } : {}),
        ...('data' in value ? { data: value.data } : {})
      }
    }
  } catch {
    // 未产生过有效运行结果。
  }
  return null
}

/** 解析迭代节点存在 meta.nodeResult 的运行结果 { items: [...] }。 */
export function parseStoredIterateResult(stored: string): { items: unknown[] } | null {
  if (!stored) return null
  try {
    const value = JSON.parse(stored) as { items?: unknown }
    if (Array.isArray(value.items)) return { items: value.items }
  } catch {
    // 未产生过有效运行结果。
  }
  return null
}

export function storyboardSummary(shots: unknown[]): string {
  return shots
    .map((shot, index) => {
      if (typeof shot !== 'object' || shot === null) return ''
      const item = shot as Record<string, unknown>
      const detail = [item.scene, item.dialogue, item.duration]
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .join('｜')
      return detail ? `${index + 1}. ${detail}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 统一输出入口。节点具体投影由各自 Spec 注册，运行器永远不根据 nodeType 猜测。
 */
export function projectNodeOutputs(shape: NodeCardShape): RawNodeOutputs {
  const lastRun = readNodeRunRecord(shape.meta?.nodeRun)
  if (lastRun && lastRun.status !== 'success') return {}
  return getNodeType(shape.props.nodeType)?.projectOutputs?.(shape) ?? {}
}
