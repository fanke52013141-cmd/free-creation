import type { NodeShape } from './executor-types'
import { parseStoredNodeValue, parseMediaResultCollection, type RawNodeOutputs } from './values'
import { projectAgentOutputs, projectStateMachineOutputs } from '../agent-flow/agent-outputs'
import { projectReviewOutputs } from '../agent-flow/review'
import { readStoredNodeRunStatus } from './run-status'
import { validateNodeSchema } from '../node-schemas'
import { projectCompositeOutputs } from '../composite/outputs'



import {
  projectWebsiteOutputsShared,
  projectCodeOutputsShared,
  projectVideoFrameOutputsShared,
  projectVideoAiOutputsShared,
  projectStructuredOutputsShared,
  projectStoryboardOutputsShared,
  projectIterateOutputsShared,
  projectAiProcessOutputsShared,
  projectDirectorOutputsShared
} from './family-projections'

// These exact functions are registered by the desktop NodeTypeSpecs.
/** C1：文本节点被 Agent 调度执行时合并结果存 nodeResult（含 runId）；
 *  仅当与当前 nodeRun 同一次运行时优先投影，普通执行/历史残留仍读正文。 */
function flowTextResult(shape: NodeShape): string | null {
  try {
    const raw = shape.meta?.nodeResult
    if (typeof raw !== 'string' || !raw) return null
    const parsed = JSON.parse(raw) as { kind?: unknown; text?: unknown; runId?: unknown }
    const runId = (shape.meta?.nodeRun as { runId?: unknown } | undefined)?.runId
    if (
      parsed.kind === 'text' &&
      typeof parsed.text === 'string' &&
      parsed.text.trim() &&
      typeof parsed.runId === 'string' &&
      parsed.runId === runId
    )
      return parsed.text.trim()
    return null
  } catch {
    return null
  }
}

export const projectTextOutputs = (shape: NodeShape): RawNodeOutputs => {
  const flowText = flowTextResult(shape)
  if (flowText) return { 'out-text': { kind: 'text', text: flowText } }
  return shape.props.text.trim() ? { 'out-text': { kind: 'text', text: shape.props.text.trim() } } : {}
}

export const projectJsonOutputs = (shape: NodeShape): RawNodeOutputs => {
  try {
    return shape.props.text.trim()
      ? { 'out-json': { kind: 'json', data: JSON.parse(shape.props.text) } }
      : {}
  } catch {
    return {}
  }
}

export const projectProcessorOutputs = (shape: NodeShape): RawNodeOutputs => {
  const result = parseStoredNodeValue(shape.meta?.nodeResult ?? '')
  return result ? { 'out-value': result } : {}
}

export const DETERMINISTIC_PROJECTIONS = {
  image: projectImageOutputs,
  'image-gen': projectImageGenOutputs,
  'image-edit': projectImageEditOutputs,
  // F4：裁剪与拆分与 GUI 同一投影（裁剪=最近成功产物；拆分=当前选中格）。
  'image-crop': projectImageGenOutputs,
  'image-split': projectImageSplitOutputs,
  audio: projectAudioAssetOutputs,
  speech: projectSpeechOutputs,
  tts: projectTtsOutputs,
  video: projectVideoOutputs,
  'video-asset': projectVideoAssetOutputs,
  // 轨道线成片走与视频生成相同的 out-video 投影：只认最近一次成功运行的产物。
  timeline: projectVideoOutputs,
  // F5：抽帧/截取/声音调整/深度/白模与 GUI specs 同一投影语义。
  'video-frame': projectVideoFrameOutputsShared,
  'video-clip': projectVideoClipOutputs,
  'sound-adjust': projectSoundAdjustOutputs,
  'video-depth': projectVideoAiOutputsShared,
  'video-clay': projectVideoAiOutputsShared,
  // F6：网址节点是纯文档数据（website.link@1），投影与 GUI 同一 readWebsiteLink。
  website: projectWebsiteOutputsShared,
  code: projectCodeOutputsShared,
  structured: projectStructuredOutputsShared,
  storyboard: projectStoryboardOutputsShared,
  iterate: projectIterateOutputsShared,
  director: projectDirectorOutputsShared,
  'ai-process': projectAiProcessOutputsShared,
  'ai-review': projectReviewOutputs,
  agent: projectAgentOutputs,
  // C3：状态机正式 out-state 投影（持久化实例 → flow.state@1），与 GUI specs 同源。
  'state-machine': projectStateMachineOutputs,
  // W1：节点流实例只暴露本次运行的显式映射结果；旧版本继续按媒体结果兼容。
  composite: projectCompositeOutputs,
  text: projectTextOutputs,
  json: projectJsonOutputs,
  processor: projectProcessorOutputs
} as const

function latestResultMediaOutput(
  shape: NodeShape,
  kind: 'image' | 'audio' | 'video',
  portId: string
): RawNodeOutputs {
  const item = parseMediaResultCollection(shape.meta?.nodeResult ?? '')?.results.at(-1)
  if (item)
    return {
      [portId]: {
        kind,
        mediaId: item.mediaId,
        mediaPath: item.mediaPath,
        mime: item.mime,
        ...(shape.props.title ? { name: shape.props.title } : {})
      }
    }
  if (!readStoredNodeRunStatus(shape.meta?.nodeRun) && shape.props.mediaId && shape.props.mediaPath)
    return {
      [portId]: {
        kind,
        mediaId: shape.props.mediaId,
        mediaPath: shape.props.mediaPath,
        mime: shape.props.mediaMime,
        ...(shape.props.title ? { name: shape.props.title } : {})
      }
    }
  return {}
}

export function projectImageGenOutputs(shape: NodeShape): RawNodeOutputs {
  return latestResultMediaOutput(shape, 'image', 'out-image')
}

/** 拆分节点 out-image 投影「当前选中格」，无选中时回退第一格（与执行器写入语义一致）。 */
export function projectImageSplitOutputs(shape: NodeShape): RawNodeOutputs {
  const collection = parseMediaResultCollection(shape.meta?.nodeResult ?? '')
  if (!collection || collection.results.length === 0) return {}
  let selected: string | null = null
  try {
    const config = JSON.parse(shape.props.config ?? '{}') as Record<string, unknown>
    if (typeof config.selectedMediaId === 'string') selected = config.selectedMediaId
  } catch {
    selected = null
  }
  const item =
    collection.results.find((entry) => entry.mediaId === selected) ?? collection.results[0]
  if (!item) return {}
  return {
    'out-image': {
      kind: 'image',
      mediaId: item.mediaId,
      mediaPath: item.mediaPath,
      mime: item.mime,
      ...(shape.props.title ? { name: shape.props.title } : {})
    }
  }
}

export function projectImageEditOutputs(shape: NodeShape): RawNodeOutputs {
  return latestResultMediaOutput(shape, 'image', 'out-image')
}

/**
 * 视频截取（契约 v5）一次运行可物化画面与音频两条产物：按本次运行 runId 圈定，
 * 再按 MIME 主类型各取最近一条；无匹配 runId 的旧数据回退原行为（R-06）。
 */
export function projectVideoClipOutputs(shape: NodeShape): RawNodeOutputs {
  const collection = parseMediaResultCollection(shape.meta?.nodeResult ?? '')
  const results = collection?.results
  if (!results?.length) return latestResultMediaOutput(shape, 'video', 'out-video')
  // 与 GUI readNodeRunRecord 同一识别规则：合法运行记录才可作为圈定依据。
  const runMeta = shape.meta?.nodeRun
  const run =
    runMeta && typeof runMeta === 'object' && readStoredNodeRunStatus(runMeta)
      ? (runMeta as { runId?: unknown; status?: unknown })
      : null
  if (run && run.status === 'failed') return {}
  const currentRunResults =
    run && typeof run.runId === 'string'
      ? results.filter((item) => item.runId === run.runId)
      : []
  const effective = currentRunResults.length > 0 ? currentRunResults : results
  const byKind = (kind: 'video' | 'audio'): (typeof results)[number] | undefined =>
    effective.filter((item) => (item.mime ?? '').startsWith(`${kind}/`)).at(-1)
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

/** 声音调整一次只处理一种源媒体；按产物 MIME 决定投给 out-audio 还是 out-video。 */
export function projectSoundAdjustOutputs(shape: NodeShape): RawNodeOutputs {
  const result = parseMediaResultCollection(shape.meta?.nodeResult ?? '')?.results.at(-1)
  if (!result) return {}
  const kind = result.mime.startsWith('video/')
    ? 'video'
    : result.mime.startsWith('audio/')
      ? 'audio'
      : null
  if (!kind) return {}
  const portId = kind === 'audio' ? 'out-audio' : 'out-video'
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

export function projectTtsOutputs(shape: NodeShape): RawNodeOutputs {
  try {
    const extra = JSON.parse(shape.meta?.nodeExtra ?? '{}')
    if (
      extra &&
      typeof extra === 'object' &&
      !Array.isArray(extra) &&
      validateNodeSchema({ id: 'voice.profile', version: 1 }, extra['out-json']).ok
    )
      return { 'out-json': { kind: 'json', data: extra['out-json'] } }
  } catch {
    // Malformed voice metadata does not create a usable Agent output.
  }
  return {}
}

export function projectSpeechOutputs(shape: NodeShape): RawNodeOutputs {
  const outputs = latestResultMediaOutput(shape, 'audio', 'out-audio')
  try {
    const extra = JSON.parse(shape.meta?.nodeExtra ?? '{}')
    if (
      extra &&
      typeof extra === 'object' &&
      !Array.isArray(extra) &&
      extra['out-subtitle'] !== undefined
    )
      outputs['out-subtitle'] = { kind: 'json', data: extra['out-subtitle'] }
  } catch {
    // Malformed optional subtitle metadata does not invalidate the audio result.
  }
  return outputs
}

export function readPinnedOutputs(stored: unknown): RawNodeOutputs | null {
  if (typeof stored !== 'string') return null
  try {
    const parsed = JSON.parse(stored)
    if (
      parsed?.version !== 1 ||
      !parsed.outputs ||
      typeof parsed.outputs !== 'object' ||
      Array.isArray(parsed.outputs)
    )
      return null
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
export function projectVideoOutputs(shape: NodeShape): RawNodeOutputs {
  const item = parseMediaResultCollection(shape.meta?.nodeResult ?? '')?.results.at(-1)
  if (
    !item &&
    !readStoredNodeRunStatus(shape.meta?.nodeRun) &&
    shape.props.mediaId &&
    shape.props.mediaPath
  )
    return {
      'out-video': {
        kind: 'video',
        mediaId: shape.props.mediaId,
        mediaPath: shape.props.mediaPath,
        mime: shape.props.mediaMime || 'video/mp4',
        ...(shape.props.title ? { name: shape.props.title } : {})
      }
    }
  return item
    ? {
        'out-video': {
          kind: 'video',
          mediaId: item.mediaId,
          mediaPath: item.mediaPath,
          mime: item.mime,
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}

export function projectImageOutputs(shape: NodeShape): RawNodeOutputs {
  return shape.props.mediaPath
    ? {
        'out-image': {
          kind: 'image',
          mediaId: shape.props.mediaId,
          mediaPath: shape.props.mediaPath,
          mime: shape.props.mediaMime,
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}

export function projectVideoAssetOutputs(shape: NodeShape): RawNodeOutputs {
  return shape.props.mediaPath
    ? {
        'out-video': {
          kind: 'video',
          mediaId: shape.props.mediaId,
          mediaPath: shape.props.mediaPath,
          mime: shape.props.mediaMime,
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}

export function projectAudioAssetOutputs(shape: NodeShape): RawNodeOutputs {
  return shape.props.mediaPath
    ? {
        'out-audio': {
          kind: 'audio',
          mediaId: shape.props.mediaId,
          mediaPath: shape.props.mediaPath,
          mime: shape.props.mediaMime,
          ...(shape.props.title ? { name: shape.props.title } : {})
        }
      }
    : {}
}
