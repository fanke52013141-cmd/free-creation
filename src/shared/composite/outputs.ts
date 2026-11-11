import type { NodeShape } from '../engine/executor-types'
import {
  parseMediaResultCollection,
  parseStoredNodeValue,
  type RawNodeOutputs
} from '../engine/values'
import { readStoredNodeRunStatus } from '../engine/run-status'
import type { CompositeManifest } from './manifest'
import { parseCompositeManifest } from './manifest'
import { compositeRuntimeVersion, COMPOSITE_RUNTIME_VERSION_LEGACY } from './manifest'
import { compositeValueMatchesPort } from './runtime'

/** 节点流实例的最小可投影视图（renderer shape / main 快照投影共用）。 */
export interface CompositeProjectionShape {
  props: {
    nodeType?: string
    title?: string
    config?: string
    text?: string
    mediaId?: string
    mediaPath?: string
    mediaMime?: string
  }
  meta?: {
    nodeRun?: unknown
    nodeResult?: unknown
    nodeExtra?: unknown
  }
}

export function readCompositeManifest(config: string | undefined): CompositeManifest | null {
  if (!config) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(config) as unknown
  } catch {
    return null
  }
  const manifest = (parsed as { manifest?: unknown } | null)?.manifest
  if (!manifest) return null
  const result = parseCompositeManifest(manifest)
  return result.ok ? result.manifest : null
}

/**
 * 实例 manifest 读取（W3 引用形态）：优先 config 内嵌快照（历史实例），
 * 其次 meta.compositeManifest（引用形态实例由宿主解析发布仓库后缓存）。
 * config 只存 {capabilityId, version, contentHash} 引用时不再受 64KiB 配置上限约束。
 */
export function readCompositeInstanceManifest(shape: {
  props: { config?: string }
  meta?: unknown
}): CompositeManifest | null {
  const embedded = readCompositeManifest(shape.props.config)
  if (embedded) return embedded
  const cached = (shape.meta as Record<string, unknown> | undefined)?.compositeManifest
  if (!cached) return null
  const result = parseCompositeManifest(cached)
  return result.ok ? result.manifest : null
}

/** 实例 config 中的固定版本引用（W3）；内嵌 manifest 形态返回 null。 */
export function readCompositeInstanceRef(
  config: string | undefined
): { capabilityId: string; version: string; contentHash?: string } | null {
  if (!config) return null
  try {
    const parsed = JSON.parse(config) as {
      manifest?: unknown
      capabilityId?: unknown
      version?: unknown
      contentHash?: unknown
    }
    if (parsed.manifest) return null
    if (typeof parsed.capabilityId !== 'string' || typeof parsed.version !== 'string') return null
    return {
      capabilityId: parsed.capabilityId,
      version: parsed.version,
      ...(typeof parsed.contentHash === 'string' ? { contentHash: parsed.contentHash } : {})
    }
  } catch {
    return null
  }
}

function readExtraValues(meta: CompositeProjectionShape['meta']): Record<string, unknown> {
  const stored = meta?.nodeExtra
  const text = typeof stored === 'string' ? stored : ''
  if (!text) return {}
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function legacyMediaValue(shape: CompositeProjectionShape): RawNodeOutputs[string] | null {
  const collection = parseMediaResultCollection(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const item =
    collection?.results.find((entry) => entry.mediaId === collection.selectedMediaId) ??
    collection?.results.at(-1)
  if (item) {
    const kind = item.mime.startsWith('video/')
      ? 'video'
      : item.mime.startsWith('audio/')
        ? 'audio'
        : item.mime.startsWith('image/')
          ? 'image'
          : 'file'
    return {
      kind,
      mediaId: item.mediaId,
      mediaPath: item.mediaPath,
      mime: item.mime,
      ...(shape.props.title ? { name: shape.props.title } : {})
    }
  }
  if (shape.props.mediaId && shape.props.mediaPath) {
    const mime = shape.props.mediaMime || 'image/png'
    const kind = mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : mime.startsWith('image/')
          ? 'image'
          : 'file'
    return {
      kind,
      mediaId: shape.props.mediaId,
      mediaPath: shape.props.mediaPath,
      mime,
      ...(shape.props.title ? { name: shape.props.title } : {})
    }
  }
  return null
}

/**
 * 节点流的正式输出投影（W1）。
 *
 * 运行语义 2：只读取本次运行写入 `meta.nodeExtra` 的映射结果；没有成功运行记录时
 * 返回空，绝不用上一轮产物冒充本轮结果。
 * 历史语义 1：继续按旧执行器的“首个媒体结果”行为读取 `meta.nodeResult`，
 * 保证旧发布版本和已绑定实例的运行结果不变。
 */
export function projectCompositeOutputs(shape: NodeShape | CompositeProjectionShape): RawNodeOutputs {
  const runtime = readCompositeInstanceManifest(shape)
  if (!runtime) return {}
  const status = readStoredNodeRunStatus(shape.meta?.nodeRun)
  if (status !== 'success') return {}

  const values = readExtraValues(shape.meta)
  const outputs: RawNodeOutputs = {}
  const legacy = compositeRuntimeVersion(runtime) === COMPOSITE_RUNTIME_VERSION_LEGACY
    ? legacyMediaValue(shape)
    : null

  for (const output of runtime.outputs) {
    const portId = `out-${output.id}`
    const stored = values[portId]
    if (stored !== undefined) {
      const value = parseStoredNodeValue(JSON.stringify(stored))
      if (value && compositeValueMatchesPort(value, output.type)) outputs[portId] = value
      continue
    }
    // 兼容历史版本：旧执行器只写单一媒体结果，公开输出按媒体类型共享这一份。
    if (
      legacy &&
      (output.type === 'image' ||
        output.type === 'video' ||
        output.type === 'audio' ||
        output.type === 'file')
    ) {
      outputs[portId] = legacy
    }
  }
  return outputs
}
