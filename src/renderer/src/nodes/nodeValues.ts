import type { NodeCardShape } from '../canvas/NodeCardShape'
import type { DirectorCamera } from '@shared/director-data'
import { validateNodeSchema } from '@shared/node-schemas'
import { getNodeType } from './registry'
import { readNodeRunRecord } from '../engine/runRecord'
import type {
  GenParamSummary,
  MediaResultCollection,
  MediaResultItem,
  SourceSummary
} from '@shared/engine/values'
import {
  appendMediaResult,
  MEDIA_RESULT_LIMIT,
  parseMediaResultCollection,
  serializeMediaResultCollection
} from '@shared/engine/values'

export type NodeValue =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'json'; data: unknown }
  | { kind: 'camera'; data: Partial<DirectorCamera> }
  | MediaNodeValue<'image'>
  | MediaNodeValue<'video'>
  | MediaNodeValue<'audio'>
  | MediaNodeValue<'file'>

/** 媒体值统一携带可选的显示名（来源节点标题）；只用于产物命名与来源展示。 */
export interface MediaNodeValue<K extends 'image' | 'video' | 'audio' | 'file'> {
  kind: K
  mediaId: string
  mediaPath: string
  mime: string
  name?: string
}

export type RawNodeOutputs = Partial<Record<string, NodeValue>>

/**
 * 媒体结果集合的类型与「解析 / 追加」口径只保留一份实现。执行器
 * （`src/shared/engine/executors/*`）写它，资产索引与节点卡片读它；此前这里逐字复制
 * 了一份，于是给产物加溯源字段必须同步改两处，漏一处就是「执行器写进去了、UI 永远
 * 读不到」的静默丢失。删除与清空两个 UI 专属操作留在本文件。
 */
export type { GenParamSummary, MediaResultCollection, MediaResultItem, SourceSummary }
export {
  appendMediaResult,
  MEDIA_RESULT_LIMIT,
  parseMediaResultCollection,
  serializeMediaResultCollection
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
      value.kind === 'camera' &&
      'data' in value &&
      validateNodeSchema({ id: 'previs.camera', version: 1 }, value.data).ok
    ) {
      return { kind: 'camera', data: value.data as Partial<DirectorCamera> }
    }
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

/**
 * 解析 meta.nodeExtra：一次运行产生的非媒体端口值，按端口 ID 存放。
 * 配音节点的字幕、音色设计/复刻节点的音色档案都走这里，避免污染媒体结果集合。
 */
export function parseNodeExtra(stored: unknown): Record<string, unknown> {
  if (typeof stored !== 'string' || !stored) return {}
  try {
    const value = JSON.parse(stored) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 解析 AI 处理节点存在 meta.nodeResult 的运行结果。 */ export function parseStoredAiResult(
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
 *
 * `outputSource` 决定运行状态能不能把输出静音：缺省（run 型）下上一次运行没成功就不暴露，
 * 免得把旧产物伪装成新结果；document 型（文本正文、资产 mediaPath）的投影只读 props，
 * 用户改完即真值，与运行无关——这类节点此前被同一个闸门误伤：空正文点一次「运行」得到
 * skipped，之后照常用双击填好正文，下游却永远读不到，卡片上状态点还显示「未运行」。
 */
export function projectNodeOutputs(shape: NodeCardShape): RawNodeOutputs {
  const spec = getNodeType(shape.props.nodeType)
  if (spec?.outputSource !== 'document') {
    const lastRun = readNodeRunRecord(shape.meta?.nodeRun)
    if (lastRun && lastRun.status !== 'success') return {}
  }
  return spec?.projectOutputs?.(shape) ?? {}
}
