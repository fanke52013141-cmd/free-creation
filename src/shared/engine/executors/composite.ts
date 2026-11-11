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
    }
    if (!parsed.manifest) return { status: 'failed', reason: '组合节点缺少固定版本 manifest' }
    manifest = parsed.manifest
  } catch {
    return { status: 'failed', reason: '组合节点 manifest 已损坏' }
  }
  const outcome = await ctx.runComposite({
    manifest,
    inputs: ctx.inputs,
    runId: ctx.runId,
    instanceNodeId: String(ctx.node.id),
    signal: ctx.signal
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
  const nonMedia: Record<string, NodeValue> = {}
  for (const output of manifest.outputs) {
    const value = outputs[output.id]
    if (!value) continue
    if (
      value.kind === 'image' ||
      value.kind === 'video' ||
      value.kind === 'audio' ||
      value.kind === 'file'
    ) {
      mediaOutputs.push(value)
    } else {
      nonMedia[`out-${output.id}`] = value
    }
  }

  // 本次运行没有非媒体输出时必须清空旧 nodeExtra，避免把上一轮文本冒充本轮结果。
  ctx.updateMeta?.({
    nodeExtra: Object.keys(nonMedia).length > 0 ? JSON.stringify(nonMedia) : undefined
  })

  const media = outcome.media ?? firstMedia(mediaOutputs)
  if (media) {
    const items =
      mediaOutputs.length > 0
        ? mediaOutputs
            .filter(
              (value): value is Extract<NodeValue, { kind: 'image' | 'video' | 'audio' | 'file' }> =>
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
