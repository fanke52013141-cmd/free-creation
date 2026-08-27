// 节点输出投影：把节点已持久化的 props/meta 映射为其声明端口的真实值。
//
// 这些函数由各自 NodeTypeSpec 直接注册。运行器和手动触发都只调用
// projectNodeOutputs(shape)，不再维护按 nodeType 分支的中央投影器。
import type { NodeCardShape } from '../../canvas/NodeCardShape'
import type { RawNodeOutputs } from '../nodeValues'
import {
  parseNodeRecord,
  parseStoredAiResult,
  parseStoredIterateResult,
  parseStoredNodeValue,
  storyboardSummary
} from '../nodeValues'
import { outputPortId, parseCodeConfigs } from '../../engine/executors/code'
import {
  parseDirectorProject,
  parseDirectorPublishRecord,
  type DirectorPublishRecord
} from '../director-data'

function mediaOutput(
  shape: NodeCardShape,
  kind: 'image' | 'video' | 'audio' | 'file',
  portId: string
): RawNodeOutputs {
  return shape.props.mediaPath
    ? {
        [portId]: {
          kind,
          mediaId: shape.props.mediaId,
          mediaPath: shape.props.mediaPath,
          mime: shape.props.mediaMime
        }
      }
    : {}
}

export const projectTextOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  shape.props.text.trim() ? { 'out-text': { kind: 'text', text: shape.props.text.trim() } } : {}

export const projectImageOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  mediaOutput(shape, 'image', 'out-image')

export const projectImageGenOutputs = projectImageOutputs

export const projectVideoOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  mediaOutput(shape, 'video', 'out-video')

export const projectAudioOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  mediaOutput(shape, 'audio', 'out-audio')

export const projectChatOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const data = parseNodeRecord(shape.props.text)
  const messages = Array.isArray(data?.messages)
    ? (data.messages as { role?: unknown; content?: unknown }[])
    : []
  const reply = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && typeof message.content === 'string')
  return typeof reply?.content === 'string' && reply.content.trim()
    ? { 'out-markdown': { kind: 'markdown', text: reply.content } }
    : {}
}

export const projectScriptOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const data = parseNodeRecord(shape.props.text)
  const source = typeof data?.source === 'string' ? data.source : shape.props.text
  const shots = Array.isArray(data?.shots) ? data.shots : []
  return {
    ...(shots.length > 0 ? { 'out-json': { kind: 'json' as const, data: { shots } } } : {}),
    ...(source.trim() ? { 'out-text': { kind: 'text' as const, text: source.trim() } } : {})
  }
}

export const projectJsonOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  try {
    return shape.props.text.trim()
      ? { 'out-json': { kind: 'json', data: JSON.parse(shape.props.text) } }
      : {}
  } catch {
    return {}
  }
}

export const projectCodeOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const result = parseStoredNodeValue(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const outputId = outputPortId(parseCodeConfigs(shape.props.text).outputName)
  return result ? { [outputId]: result } : {}
}

export const projectProcessorOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const result = parseStoredNodeValue(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  return result ? { 'out-value': result } : {}
}

export const projectStoryboardOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const data = parseNodeRecord(shape.props.text)
  if (!data || !Array.isArray(data.shots)) return {}
  const text = storyboardSummary(data.shots)
  return {
    'out-json': { kind: 'json', data },
    ...(text ? { 'out-text': { kind: 'text' as const, text } } : {})
  }
}

export const projectAiProcessOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const result = parseStoredAiResult(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  if (!result) return {}
  if ((result.kind === 'text' || result.kind === 'markdown') && typeof result.text === 'string') {
    return result.text.trim()
      ? { [`out-${result.kind}`]: { kind: result.kind, text: result.text } }
      : {}
  }
  return result.kind === 'json' ? { 'out-json': { kind: 'json', data: result.data } } : {}
}

export const projectIterateOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const parsed = parseStoredIterateResult(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  return parsed ? { 'out-items': { kind: 'json', data: parsed.items } } : {}
}

export const projectDirectorOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  let published: DirectorPublishRecord | null = null
  try {
    published = parseDirectorPublishRecord(
      typeof shape.meta?.nodeResult === 'string' ? JSON.parse(shape.meta.nodeResult) : null
    )
  } catch {
    // 损坏运行记录不得成为下游输入。
  }
  const project = parseDirectorProject(shape.props.text)
  return {
    'out-project': { kind: 'json', data: project },
    ...(published?.frame
      ? {
          'out-frame': {
            kind: 'image' as const,
            mediaId: published.frame.mediaId,
            mediaPath: published.frame.mediaPath,
            mime: published.frame.mime
          }
        }
      : {}),
    ...(published?.video
      ? {
          'out-preview-video': {
            kind: 'video' as const,
            mediaId: published.video.mediaId,
            mediaPath: published.video.mediaPath,
            mime: published.video.mime
          }
        }
      : {}),
    ...(published ? { 'out-camera': { kind: 'json' as const, data: published.camera } } : {})
  }
}
