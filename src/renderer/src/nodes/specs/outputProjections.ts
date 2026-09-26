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
  parseMediaResultCollection,
  parseNodeExtra,
  parseStoredAiResult,
  parseStoredIterateResult,
  parseStoredNodeValue,
  storyboardSummary
} from '../nodeValues'
import { outputFieldPortId, outputPortId, parseCodeConfigs } from '../../engine/executors/code'
import {
  parseDirectorProject,
  parseDirectorPublishRecord,
  isDirectorPublishCurrent,
  type DirectorPublishRecord
} from '../director-data'
import { parseStructuredDataConfig } from '../structured-data'
import { readNodeRunRecord } from '../../engine/runRecord'
import { parseVocalSeparationResult } from '../../engine/executors/vocalSeparate'

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
          mime: shape.props.mediaMime,
          // 显示名随媒体值向下游传递，供 P 图等节点命名产物（如「（改）原图名」）。
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}

/** 操作节点的“最新输出”只来自运行结果；资产节点才从自身 props 投影。 */
function latestResultMediaOutput(
  shape: NodeCardShape,
  kind: 'image' | 'video' | 'audio',
  portId: string
): RawNodeOutputs {
  const collection = parseMediaResultCollection(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const result = collection?.results.at(-1)
  if (result) {
    return {
      [portId]: {
        kind,
        mediaId: result.mediaId,
        mediaPath: result.mediaPath,
        mime: result.mime,
        ...(shape.props.title ? { name: shape.props.title } : {})
      }
    }
  }
  // 历史兼容（用户 2026-09-18 反馈的“取帧/截视频/截音频全部不可用”）：
  // 早期版本把产物直接写在节点 props 上，没有结果集合、也没有运行记录。
  // 这类旧项目必须继续可用，否则下游节点永远读不到源视频。
  // 只要存在运行记录就绝不回退——失败运行不得继续暴露上一次的媒体输出。
  if (readNodeRunRecord(shape.meta?.nodeRun)) return {}
  return mediaOutput(shape, kind, portId)
}

/**
 * 非媒体端口值统一从 meta.nodeExtra 取（执行器在成功运行时写入）。
 * 运行失败时 projectNodeOutputs 已提前返回空，不会暴露上一次的陈旧值。
 */
function extraJsonOutput(shape: NodeCardShape, portId: string): RawNodeOutputs {
  const value = parseNodeExtra(shape.meta?.nodeExtra)[portId]
  return value === undefined ? {} : { [portId]: { kind: 'json' as const, data: value } }
}

export const projectTextOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  shape.props.text.trim() ? { 'out-text': { kind: 'text', text: shape.props.text.trim() } } : {}

export const projectImageOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  mediaOutput(shape, 'image', 'out-image')

export const projectImageGenOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  latestResultMediaOutput(shape, 'image', 'out-image')

/** 裁剪节点与图片节点共享 image 输出值，但产物只能来自本节点的成功运行。 */
export const projectImageCropOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  latestResultMediaOutput(shape, 'image', 'out-image')
export const projectImageEditOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  latestResultMediaOutput(shape, 'image', 'out-image')

/**
 * 宫格拆分的 out-image 投影「当前选中格」：selectedMediaId 命中则取选中格，
 * 否则回退第一格（与执行器写入 selectedMediaId = 第一格 的语义一致）。
 * 不复用 latestResultMediaOutput 的 at(-1)（最后一格）：那会把「最后一格」
 * 伪装成「当前输出」，与执行器的选中语义互相矛盾（F10）。
 */
function selectedGridMediaOutput(shape: NodeCardShape, portId: string): RawNodeOutputs {
  const collection = parseMediaResultCollection(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const results = collection?.results ?? []
  if (results.length === 0) return {}
  const selectedMediaId = collection?.selectedMediaId
  const selected =
    (selectedMediaId ? results.find((item) => item.mediaId === selectedMediaId) : undefined) ??
    results[0]
  return {
    [portId]: {
      kind: 'image',
      mediaId: selected.mediaId,
      mediaPath: selected.mediaPath,
      mime: selected.mime,
      ...(shape.props.title ? { name: shape.props.title } : {})
    }
  }
}

/**
 * 宫格拆分同时暴露当前选中的单张图片与全部真实产物列表：
 * 前者兼容图片类下游；后者可交给循环节点逐项批处理，绝不把多张图片伪装成一张。
 */
export const projectImageSplitOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const collection = parseMediaResultCollection(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const results = collection?.results ?? []
  return {
    ...selectedGridMediaOutput(shape, 'out-image'),
    ...(results.length > 0
      ? {
          'out-images': {
            kind: 'json' as const,
            data: results.map((item, index) => ({
              id: `grid-${index + 1}-${item.mediaId}`,
              index: index + 1,
              kind: 'image',
              mediaId: item.mediaId,
              mediaPath: item.mediaPath,
              mime: item.mime
            }))
          }
        }
      : {}),
  }
}

export const projectVideoOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  latestResultMediaOutput(shape, 'video', 'out-video')

export const projectVideoFrameOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  latestResultMediaOutput(shape, 'image', 'out-image')

/** Both local video AI transforms publish one independent MP4 asset through out-video. */
export const projectVideoAiOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  latestResultMediaOutput(shape, 'video', 'out-video')

/**
 * 视频截取（合并节点，契约 v5）一次运行可物化两条产物：画面写入 out-video、
 * 音频写入 out-audio。结果集合是扁平列表，因此按 MIME 主类型各取最近一条，
 * 而不是共用 latestResultMediaOutput 的「最后一条」。
 */
export const projectVideoClipOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const collection = parseMediaResultCollection(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const results = collection?.results
  if (!results?.length) return latestResultMediaOutput(shape, 'video', 'out-video')
  const runFailed = readNodeRunRecord(shape.meta?.nodeRun)?.status === 'failed'
  if (runFailed) return {}
  const byKind = (kind: 'video' | 'audio'): (typeof results)[number] | undefined =>
    results.filter((item) => (item.mime ?? '').startsWith(`${kind}/`)).at(-1)
  const output: RawNodeOutputs = {}
  const name = shape.props.title ? { name: shape.props.title } : {}
  for (const [kind, portId] of [
    ['video', 'out-video'],
    ['audio', 'out-audio']
  ] as const) {
    const item = byKind(kind)
    if (item)
      output[portId] = {
        kind,
        mediaId: item.mediaId,
        mediaPath: item.mediaPath,
        mime: item.mime,
        ...name
      }
  }
  return output
}

export const projectVideoAudioOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  latestResultMediaOutput(shape, 'audio', 'out-audio')

export const projectVocalSeparateOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const result = parseVocalSeparationResult(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  if (!result) return {}
  return { 'out-audio': { kind: 'audio', ...result.vocals } }
}

export const projectAudioOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  shape.props.nodeType === 'audio'
    ? mediaOutput(shape, 'audio', 'out-audio')
    : latestResultMediaOutput(shape, 'audio', 'out-audio')

export const projectVideoAssetOutputs = (shape: NodeCardShape): RawNodeOutputs =>
  mediaOutput(shape, 'video', 'out-video')

/**
 * 文件资产节点：原始文件永远作为 out-file 暴露；导入时已抽出正文的文档
 * （纯文本 / CSV / Word / Excel / PPT）同时提供 out-text，文本类下游不必再猜文件内容。
 */
export const projectFileOutputs = (shape: NodeCardShape): RawNodeOutputs => {
  const base = mediaOutput(shape, 'file', 'out-file')
  const text = typeof shape.props.text === 'string' ? shape.props.text : ''
  return text.trim() ? { ...base, 'out-text': { kind: 'text', text } } : base
}

export const projectTtsOutputs = (shape: NodeCardShape): RawNodeOutputs => ({
  ...latestResultMediaOutput(shape, 'audio', 'out-audio'),
  ...extraJsonOutput(shape, 'out-json')
})

/** 配音节点：音频输出永远来自本次运行；字幕只在火山语音合成 1.0 开启字幕时存在。 */
export const projectSpeechOutputs = (shape: NodeCardShape): RawNodeOutputs => ({
  ...latestResultMediaOutput(shape, 'audio', 'out-audio'),
  ...extraJsonOutput(shape, 'out-subtitle')
})

/** 音色设计节点：试听音频 + 可被下游配音节点引用的音色档案。 */
export const projectVoiceDesignOutputs = (shape: NodeCardShape): RawNodeOutputs => ({
  ...latestResultMediaOutput(shape, 'audio', 'out-audio'),
  ...extraJsonOutput(shape, 'out-json')
})

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
  const raw = typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  if (!raw) return {}
  const config = parseCodeConfigs(readNodeConfig(shape))
  try {
    const result = JSON.parse(raw) as Record<string, unknown>
    if (result.kind === 'code-outputs' && result.values && typeof result.values === 'object') {
      const values = result.values as Record<string, unknown>
      const outputs: RawNodeOutputs = {}
      for (const field of config.outputs) {
        const portId = outputFieldPortId(field)
        const value = values[portId]
        if (value === undefined) continue
        const parsed = parseStoredNodeValue(JSON.stringify(value))
        if (parsed) outputs[portId] = parsed
      }
      return outputs
    }
  } catch {
    // 单输出历史结果继续由下面的统一 NodeValue 解析器读取。
  }
  const single = parseStoredNodeValue(raw)
  if (single) return { [outputPortId(config.outputName)]: single }
  return {}
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
      ? { 'out-camera': { kind: 'camera' as const, data: currentPublish.camera } }
      : {})
  }
}
