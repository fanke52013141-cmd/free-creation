import type { NodeCardShape } from '../canvas/NodeCardShape'
import { getNodeType } from './registry'

export type NodeValue =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'json'; data: unknown }
  | { kind: 'image'; mediaId: string; mediaPath: string; mime: string }
  | { kind: 'video'; mediaId: string; mediaPath: string; mime: string }
  | { kind: 'audio'; mediaId: string; mediaPath: string; mime: string }
  | { kind: 'file'; mediaId: string; mediaPath: string; mime: string }

export type RawNodeOutputs = Partial<Record<string, NodeValue>>

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
  return getNodeType(shape.props.nodeType)?.projectOutputs?.(shape) ?? {}
}
