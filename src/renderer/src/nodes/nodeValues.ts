import type { NodeCardShape } from '../canvas/NodeCardShape'

export type NodeValue =
  | { kind: 'text'; text: string }
  | { kind: 'json'; data: unknown }
  | { kind: 'image'; mediaId: string; mediaPath: string; mime: string }
  | { kind: 'video'; mediaId: string; mediaPath: string; mime: string }
  | { kind: 'audio'; mediaId: string; mediaPath: string; mime: string }

export type RawNodeOutputs = Partial<Record<string, NodeValue>>

function parseStoredNodeValue(text: string): NodeValue | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value.kind === 'text' && typeof value.text === 'string') {
      return { kind: 'text', text: value.text }
    }
    if (value.kind === 'json' && 'data' in value) return { kind: 'json', data: value.data }
    if (
      (value.kind === 'image' || value.kind === 'video' || value.kind === 'audio') &&
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

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function storyboardSummary(shots: unknown[]): string {
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
 * 把节点的持久化状态投影成稳定端口输出。全局运行与卡片内手动触发共用这一入口，
 * 避免两套代码分别按节点类型猜测上游内容。
 */
export function projectNodeOutputs(shape: NodeCardShape): RawNodeOutputs {
  const props = shape.props
  switch (props.nodeType) {
    case 'text':
      return props.text.trim() ? { 'out-text': { kind: 'text', text: props.text.trim() } } : {}
    case 'image':
    case 'image-gen':
      return props.mediaPath
        ? {
            'out-image': {
              kind: 'image',
              mediaId: props.mediaId,
              mediaPath: props.mediaPath,
              mime: props.mediaMime
            }
          }
        : {}
    case 'video':
      return props.mediaPath
        ? {
            'out-video': {
              kind: 'video',
              mediaId: props.mediaId,
              mediaPath: props.mediaPath,
              mime: props.mediaMime
            }
          }
        : {}
    case 'audio':
      return props.mediaPath
        ? {
            'out-audio': {
              kind: 'audio',
              mediaId: props.mediaId,
              mediaPath: props.mediaPath,
              mime: props.mediaMime
            }
          }
        : {}
    case 'chat': {
      const data = parseRecord(props.text)
      const messages = Array.isArray(data?.messages)
        ? (data.messages as { role?: unknown; content?: unknown }[])
        : []
      const reply = [...messages]
        .reverse()
        .find((message) => message.role === 'assistant' && typeof message.content === 'string')
      return typeof reply?.content === 'string' && reply.content.trim()
        ? { 'out-markdown': { kind: 'text', text: reply.content } }
        : {}
    }
    case 'script': {
      const data = parseRecord(props.text)
      const source = typeof data?.source === 'string' ? data.source : props.text
      const shots = Array.isArray(data?.shots) ? data.shots : []
      return {
        ...(shots.length > 0 ? { 'out-json': { kind: 'json' as const, data: { shots } } } : {}),
        ...(source.trim() ? { 'out-text': { kind: 'text' as const, text: source.trim() } } : {})
      }
    }
    case 'json':
      try {
        return props.text.trim()
          ? { 'out-json': { kind: 'json', data: JSON.parse(props.text) } }
          : {}
      } catch {
        return {}
      }
    case 'code': {
      const result = parseStoredNodeValue(
        typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
      )
      if (result?.kind === 'text') return { 'out-text': result }
      if (result?.kind === 'json') return { 'out-json': result }
      return {}
    }
    case 'processor': {
      const result = parseStoredNodeValue(
        typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
      )
      return result ? { 'out-value': result } : {}
    }
    case 'storyboard': {
      const data = parseRecord(props.text)
      if (!data || !Array.isArray(data.shots)) return {}
      const text = storyboardSummary(data.shots)
      return {
        'out-json': { kind: 'json', data },
        ...(text ? { 'out-text': { kind: 'text' as const, text } } : {})
      }
    }
    case 'ai-process': {
      const data = parseRecord(props.text)
      const result = data?.result as
        { kind: 'text' | 'markdown' | 'json'; text?: string; data?: unknown } | undefined
      if (!result) return {}
      if (result.kind === 'text' && typeof result.text === 'string') {
        return result.text.trim() ? { 'out-text': { kind: 'text', text: result.text } } : {}
      }
      if (result.kind === 'markdown' && typeof result.text === 'string') {
        return result.text.trim() ? { 'out-markdown': { kind: 'text', text: result.text } } : {}
      }
      if (result.kind === 'json') return { 'out-json': { kind: 'json', data: result.data } }
      return {}
    }
    case 'iterate': {
      const data = parseRecord(props.text)
      if (!data || !Array.isArray(data.items)) return {}
      return { 'out-items': { kind: 'json', data: { items: data.items } } }
    }
    default:
      return {}
  }
}
