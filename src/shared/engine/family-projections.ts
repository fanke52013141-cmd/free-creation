// F6 第三批：复杂节点族的共享输出投影。
// 与 GUI specs/outputProjections.ts 同语义；helpers 全部来自共享模块，
// 不复制实现。由 deterministic-projections 注册表引用。
import type { NodeShape } from './executor-types'
import {
  parseStoredNodeValue,
  parseMediaResultCollection,
  parseNodeRecord,
  storyboardSummary,
  parseStoredIterateResult,
  parseStoredAiResult,
  type RawNodeOutputs
} from './values'
import { readStoredNodeRunStatus } from './run-status'
import { validateNodeSchema } from '../node-schemas'
import { parseStructuredDataConfig } from '../structured-data'
import {
  parseDirectorProject,
  parseDirectorPublishRecord,
  isDirectorPublishCurrent
} from '../director-data'
import { outputFieldPortId, outputPortId, parseCodeConfigs } from './executors/code'
import { readWebsiteLink } from '../website-link'

/** 合法运行记录的共享识别（与 GUI readNodeRunRecord 同规则，取 runId/status）。 */
function readSharedRunRecord(
  value: unknown
): { runId: string; status: 'running' | 'success' | 'failed' | 'skipped' | 'cancelled' } | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { runId?: unknown; status?: unknown }
  const status = readStoredNodeRunStatus(record)
  return status && typeof record.runId === 'string' ? { runId: record.runId, status } : null
}

function mediaItemOutput(
  item: { mediaId: string; mediaPath: string; mime: string },
  kind: 'image' | 'video' | 'audio',
  portId: string,
  title: string | undefined
): RawNodeOutputs {
  return {
    [portId]: {
      kind,
      mediaId: item.mediaId,
      mediaPath: item.mediaPath,
      mime: item.mime,
      ...(title ? { name: title } : {})
    }
  }
}

function latestMedia(
  shape: NodeShape,
  kind: 'image' | 'video' | 'audio',
  portId: string
): RawNodeOutputs {
  const item = parseMediaResultCollection(shape.meta?.nodeResult ?? '')?.results.at(-1)
  if (item) return mediaItemOutput(item, kind, portId, shape.props.title)
  if (
    !readStoredNodeRunStatus(shape.meta?.nodeRun) &&
    shape.props.mediaId &&
    shape.props.mediaPath
  )
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

export function projectWebsiteOutputsShared(shape: NodeShape): RawNodeOutputs {
  const link = readWebsiteLink(shape.props.config ?? '')
  return link ? { 'out-website': { kind: 'json', data: link } } : {}
}

export function projectCodeOutputsShared(shape: NodeShape): RawNodeOutputs {
  const raw = typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  if (!raw) return {}
  const config = parseCodeConfigs(shape.props.config ?? '')
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
    // 单输出历史结果继续由统一 NodeValue 解析器读取。
  }
  const single = parseStoredNodeValue(raw)
  if (single) return { [outputPortId(config.outputName)]: single }
  return {}
}

export function projectVideoFrameOutputsShared(shape: NodeShape): RawNodeOutputs {
  return latestMedia(shape, 'image', 'out-image')
}

export function projectVideoAiOutputsShared(shape: NodeShape): RawNodeOutputs {
  return latestMedia(shape, 'video', 'out-video')
}

/** 结构数据：运行闸门 + Schema 校验（与 GUI projectStructuredOutputs 同语义）。 */
export function projectStructuredOutputsShared(shape: NodeShape): RawNodeOutputs {
  const schema = parseStructuredDataConfig(shape.props.config ?? '').schema
  const latestRun = readSharedRunRecord(shape.meta?.nodeRun)
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
  try {
    const data = JSON.parse(shape.props.text) as unknown
    return validateNodeSchema(schema, data).ok ? { 'out-json': { kind: 'json', data } } : {}
  } catch {
    return {}
  }
}

/** 分镜板：分镜数据 + 摘要文本双投影（shots 字段并集原样保留）。 */
export function projectStoryboardOutputsShared(shape: NodeShape): RawNodeOutputs {
  const data = parseNodeRecord(shape.props.text)
  if (!data || !Array.isArray(data.shots)) return {}
  const text = storyboardSummary(data.shots)
  return {
    'out-json': { kind: 'json', data },
    ...(text ? { 'out-text': { kind: 'text' as const, text } } : {})
  }
}

/** 循环：项目级结果列表投影（list.items@1）。 */
export function projectIterateOutputsShared(shape: NodeShape): RawNodeOutputs {
  const parsed = parseStoredIterateResult(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  return parsed ? { 'out-items': { kind: 'json', data: parsed.items } } : {}
}

/** AI 处理：文本/markdown/json 按存储结果类型分端口（与 GUI 同语义）。 */
export function projectAiProcessOutputsShared(shape: NodeShape): RawNodeOutputs {
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

/** 导演台：工程摘要始终投影；帧/视频只在发布记录与工程当前一致时投影。 */
export function projectDirectorOutputsShared(shape: NodeShape): RawNodeOutputs {
  let published: ReturnType<typeof parseDirectorPublishRecord> = null
  try {
    published = parseDirectorPublishRecord(
      typeof shape.meta?.nodeResult === 'string' ? JSON.parse(shape.meta.nodeResult) : null
    )
  } catch {
    published = null
  }
  const project = parseDirectorProject(shape.props.config ?? '')
  const currentPublish = isDirectorPublishCurrent(project, published) ? published : null
  return {
    'out-project': { kind: 'json', data: project },
    ...(currentPublish?.frame
      ? mediaItemOutput(currentPublish.frame, 'image', 'out-frame', undefined)
      : {}),
    ...(currentPublish?.video
      ? mediaItemOutput(currentPublish.video, 'video', 'out-preview-video', undefined)
      : {}),
    ...(currentPublish?.camera
      ? { 'out-camera': { kind: 'camera' as const, data: currentPublish.camera } }
      : {})
  }
}
