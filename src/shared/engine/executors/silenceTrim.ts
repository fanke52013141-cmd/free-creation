import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { parseSilenceTrimConfig, silenceTrimSummary } from '@shared/silence-trim'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import { capabilityFailure, unavailableLocalCapability } from '../preflight'
import { runCancellableMedia } from '../media-cancel'

/** 去气口：单音频输入，检测并剪掉静音/呼吸气口，产物为独立新音频资产。 */
export async function silenceTrimExecutor(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const audios = inputMedia(ctx.inputs, 'in-audio', 'audio')
  if (audios.length !== 1) {
    return { status: 'failed', reason: '请只连接一段音频' }
  }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const source = audios[0]
  const config = parseSilenceTrimConfig(readNodeConfig(ctx.shape))
  // silence 引擎需要 ffprobe 读时长（尾静音钳制）；vad 引擎时长来自解码采样数。
  const capabilities = (config.engine === 'vad'
    ? ['ffmpeg', 'sileroVad']
    : ['ffmpeg', 'ffprobe']) as Array<'ffmpeg' | 'ffprobe' | 'sileroVad'>
  for (const capability of capabilities) {
    const reason = await unavailableLocalCapability(ctx.gateway, capability)
    if (reason) return { status: 'failed', reason: capabilityFailure(capability, reason) }
  }
  try {
    // 取消立即请求主进程终止 ffmpeg/推理作业；迟到完成的资产同样删除，不留孤儿。
    const outcome = await runCancellableMedia(
      ctx,
      () =>
        ctx.gateway.silenceTrim({
          projectId: ctx.projectId,
          sourceMediaId: source.mediaId,
          nodeId: ctx.node.id,
          config
        }),
      (envelope) => {
        if (envelope?.ok) void ctx.gateway.deleteMedia?.(envelope.data.id).catch(() => undefined)
      }
    )
    if (outcome.cancelled) return { status: 'skipped', reason: '已取消' }
    const result = outcome.value
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    const asset = result.data
    ctx.updateResult(serializeMediaResultCollection(appendMediaResult(
      typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
      { mediaId: asset.id, mediaPath: asset.path, mime: asset.mime },
      { nodeId: ctx.node.id, modelKey: 'local:silence-trim', prompt: silenceTrimSummary(config), runId: ctx.runId }
    )))
    ctx.emitArtifact?.({
      kind: 'audio',
      mediaId: asset.id,
      mediaPath: asset.path,
      mime: asset.mime,
      portId: 'out-audio',
      title: asset.name || '去气口音频'
    })
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
