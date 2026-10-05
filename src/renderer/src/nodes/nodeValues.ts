import type { NodeCardShape } from '../canvas/NodeCardShape'
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

import type { RawNodeOutputs } from '@shared/engine/values'
export type { NodeValue, RawNodeOutputs, MediaNodeValue } from '@shared/engine/values'
import { parseStoredNodeValue } from '@shared/engine/values'
export {
  parseStoredNodeValue,
  parseNodeRecord,
  parseStoredAiResult,
  parseStoredIterateResult,
  storyboardSummary
} from '@shared/engine/values'

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
  const pinned = readPinnedOutputs(shape.meta?.pinnedOutput)
  if (pinned) return pinned
  if (spec?.outputSource !== 'document') {
    const lastRun = readNodeRunRecord(shape.meta?.nodeRun)
    if (lastRun && lastRun.status !== 'success') return {}
  }
  return spec?.projectOutputs?.(shape) ?? {}
}

/** A pinned snapshot is independent of later runs/candidate selection and survives reopening. */
export function readPinnedOutputs(stored: unknown): RawNodeOutputs | null {
  if (typeof stored !== 'string') return null
  try {
    const parsed = JSON.parse(stored)
    if (parsed?.version !== 1 || !parsed.outputs || typeof parsed.outputs !== 'object') return null
    const outputs: RawNodeOutputs = {}
    for (const [portId, value] of Object.entries(parsed.outputs)) {
      const validated = parseStoredNodeValue(JSON.stringify(value))
      if (!validated) return null
      outputs[portId] = validated
    }
    return Object.keys(outputs).length ? outputs : null
  } catch {
    return null
  }
}
