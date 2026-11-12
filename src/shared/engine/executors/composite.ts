import type { NodeExecutor, NodeExecutionContext } from '../executor-types'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import type { NodeValue } from '../values'

/**
 * composite 节点的公共执行器：不直接读画布，只把固定版本 manifest 与本次输入交给宿主注入的
 * 隔离执行服务。内部节点仍由 renderer 公共 executor/模型/媒体服务执行。
 *
 * W1：公开输出按本次运行的映射结果写回自身 meta：
 * - 媒体继续写 nodeResult（缩略图/资产索引与旧行为一致）；
 * - 文本/JSON 写 nodeExtra，projectOutputs 再按公开端口投影给下游；
 * - 不把内部节点结果直接当作组合输出。
 * W3：媒体公开输出同时写 nodeExtra，下游节点可按端口直接消费媒体产物。
 */
export const compositeExecutor: NodeExecutor = async (
  ctx: NodeExecutionContext
): Promise<import('../executor-types').NodeExecutionResult> => {
  if (!ctx.runComposite) {
    return { status: 'failed', reason: '组合执行服务未注册（请在桌面宿主中运行）' }
  }
  let manifest: import('../../composite/manifest').CompositeManifest
  try {
    const parsed = JSON.parse(ctx.shape.props.config || '{}') as {
      manifest?: import('../../composite/manifest').CompositeManifest
      ref?: { capabilityId?: string; version?: string; contentHash?: string }
      capabilityId?: string
      version?: string
      contentHash?: string
    }
    if (parsed.manifest) {
      manifest = parsed.manifest
    } else {
      // W3 引用形态：config 只存固定版本引用；优先用宿主缓存在 meta 的快照，
      // 否则经宿主从发布仓库解析并核对摘要。历史内嵌 manifest 实例不受影响。
      const cached = (ctx.shape.meta as Record<string, unknown> | undefined)?.compositeManifest
      const ref =
        parsed.ref ??
        (parsed.capabilityId
          ? {
              capabilityId: parsed.capabilityId,
              version: parsed.version,
              contentHash: parsed.contentHash
            }
          : undefined)
      if (cached) {
        manifest = cached as import('../../composite/manifest').CompositeManifest
      } else if (ref?.capabilityId && ref.version && ctx.resolveCompositeManifest) {
        const resolved = await ctx.resolveCompositeManifest({
          capabilityId: ref.capabilityId,
          version: ref.version,
          ...(ref.contentHash ? { contentHash: ref.contentHash } : {})
        })
        if (!resolved) {
          return {
            status: 'failed',
            reason: '组合固定版本引用无法解析（版本不存在或摘要不符）',
            diagnosticPhase: 'input'
          }
        }
        manifest = resolved
      } else {
        return { status: 'failed', reason: '组合节点缺少固定版本 manifest' }
      }
    }
  } catch {
    return { status: 'failed', reason: '组合节点 manifest 已损坏' }
  }
  const outcome = await ctx.runComposite({
    manifest,
    inputs: ctx.inputs,
    runId: ctx.runId,
    instanceNodeId: String(ctx.node.id),
    signal: ctx.signal,
    ...(ctx.compositeRunContext ? { parentContext: ctx.compositeRunContext } : {}),
    ...(ctx.compositeRunContext?.headless ? { headless: true } : {})
  })
  if (outcome.status === 'failed') {
    const phase =
      outcome.failure?.phase === 'input'
        ? 'input'
        : outcome.failure?.phase === 'output'
          ? 'output'
          : 'execution'
    return {
      status: 'failed',
      reason: outcome.reason ?? '组合运行失败',
      diagnosticPhase: phase
    }
  }

  const outputs = outcome.outputs ?? {}
  const mediaOutputs: NodeValue[] = []
  const extraOutputs: Record<string, NodeValue> = {}
  for (const output of manifest.outputs) {
    const value = outputs[output.id]
    if (!value) continue
    // W3：全部公开输出（含媒体）都写 nodeExtra，下游按公开端口投影即可消费媒体产物；
    // 媒体另写 nodeResult，保持缩略图/资产索引与旧呈现行为。
    extraOutputs[`out-${output.id}`] = value
    if (
      value.kind === 'image' ||
      value.kind === 'video' ||
      value.kind === 'audio' ||
      value.kind === 'file'
    ) {
      mediaOutputs.push(value)
    }
  }

  // 本次运行没有公开输出时必须清空旧 nodeExtra，避免把上一轮结果冒充本轮结果。
  ctx.updateMeta?.({
    nodeExtra: Object.keys(extraOutputs).length > 0 ? JSON.stringify(extraOutputs) : undefined
  })

  const media = outcome.media ?? firstMedia(mediaOutputs)
  if (media) {
    const items =
      mediaOutputs.length > 0
        ? mediaOutputs
            .filter(
              (
                value
              ): value is Extract<NodeValue, { kind: 'image' | 'video' | 'audio' | 'file' }> =>
                value.kind === 'image' ||
                value.kind === 'video' ||
                value.kind === 'audio' ||
                value.kind === 'file'
            )
            .map((value) => ({
              mediaId: value.mediaId,
              mediaPath: value.mediaPath,
              mime: value.mime
            }))
        : [media]
    let serialized = ''
    for (const item of items) {
      serialized = serializeMediaResultCollection(
        appendMediaResult(serialized, item, {
          nodeId: ctx.node.id,
          modelKey: 'composite',
          ...(ctx.runId ? { runId: ctx.runId } : {})
        })
      )
    }
    if (serialized) ctx.updateResult(serialized)
  }
  return { status: 'done' }
}

function firstMedia(
  values: readonly NodeValue[]
): { mediaId: string; mediaPath: string; mime: string } | null {
  const first = values[0]
  if (
    first &&
    (first.kind === 'image' ||
      first.kind === 'video' ||
      first.kind === 'audio' ||
      first.kind === 'file')
  )
    return { mediaId: first.mediaId, mediaPath: first.mediaPath, mime: first.mime }
  return null
}
