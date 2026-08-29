// 节点输出投影：把节点已持久化的 props/meta 映射为其声明端口的真实值。
//
// 这些函数由各自 NodeTypeSpec 直接注册。运行器和手动触发都只调用
// projectNodeOutputs(shape)，不再维护按 nodeType 分支的中央投影器。
import type { NodeCardShape } from '../../canvas/NodeCardShape'
import { validateNodeSchema } from '@shared/node-schemas'
import { readNodeConfig } from '../../canvas/node-persistence'
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
  isDirectorPublishCurrent,
  type DirectorPublishRecord
} from '../director-data'
import { parseStructuredDataConfig } from '../structured-data'
import { readNodeRunRecord } from '../../engine/runRecord'

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

/** 裁剪节点与图片节点共享 image 输出值，但产物只能来自本节点的成功运行。 */
export const projectImageCropOutputs = projectImageOutputs

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

export const projectStructuredOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const schema = parseStructuredDataConfig(readNodeConfig(shape)).schema
  const latestRun = readNodeRunRecord(shape.meta?.nodeRun)
  // 有过一次运行时，只接受这一次成功运行写入的结果；失败不能继续投影旧产物。
  if (latestRun) {
    if (latestRun.status !== 'success') return {}
    try {
      const stored =
        typeof shape.meta?.nodeResult === 'string'
          ? (JSON.parse(shape.meta.nodeResult) as { kind?: unknown; data?: unknown })
          : null
      if (stored?.kind === 'structured-result' && validateNodeSchema(schema, stored.data).ok) {
        return { 'out-json': { kind: 'json', data: stored.data } }
      }
      return {}
    } catch {
      return {}
    }
  }
  // 从未运行过的手工结构数据仍可作为可连接的数据源；模板包含占位符通常不会
  // 通过 Schema 校验，因此不会在未执行前泄露为下游结果。
  try {
    const data = JSON.parse(shape.props.text) as unknown
    return validateNodeSchema(schema, data).ok ? { 'out-json': { kind: 'json', data } } : {}
  } catch {
    return {}
  }
}

export const projectCodeOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const result = parseStoredNodeValue(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const outputId = outputPortId(parseCodeConfigs(readNodeConfig(shape)).outputName)
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
  const project = parseDirectorProject(readNodeConfig(shape))
  const currentPublish = isDirectorPublishCurrent(project, published) ? published : null
  return {
    'out-project': { kind: 'json', data: project },
    ...(currentPublish?.frame
      ? {
          'out-frame': {
            kind: 'image' as const,
            mediaId: currentPublish.frame.mediaId,
            mediaPath: currentPublish.frame.mediaPath,
            mime: currentPublish.frame.mime
          }
        }
      : {}),
    ...(currentPublish?.video
      ? {
          'out-preview-video': {
            kind: 'video' as const,
            mediaId: currentPublish.video.mediaId,
            mediaPath: currentPublish.video.mediaPath,
            mime: currentPublish.video.mime
          }
        }
      : {}),
    ...(currentPublish
      ? { 'out-camera': { kind: 'json' as const, data: currentPublish.camera } }
      : {})
  }
}
