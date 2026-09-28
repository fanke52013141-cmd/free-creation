import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { parseSoundAdjustConfig } from '@shared/sound-adjust'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import { capabilityFailure, unavailableLocalCapability } from '../preflight'

export async function soundAdjustExecutor(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const audios = inputMedia(ctx.inputs, 'in-audio', 'audio')
  const videos = inputMedia(ctx.inputs, 'in-video', 'video')
  if (audios.length + videos.length !== 1) {
    return { status: 'failed', reason: '请只连接一段音频或一段视频' }
  }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const kind = audios.length ? 'audio' : 'video'
  const source = audios[0] ?? videos[0]
  const config = parseSoundAdjustConfig(readNodeConfig(ctx.shape))
  for (const capability of (kind === 'video' || config.mode === 'duration'
    ? ['ffmpeg', 'ffprobe']
    : ['ffmpeg']) as Array<'ffmpeg' | 'ffprobe'>) {
    const reason = await unavailableLocalCapability(ctx.gateway, capability)
    if (reason) return { status: 'failed', reason: capabilityFailure(capability, reason) }
  }
  try {
    const result = await ctx.gateway.soundAdjust({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      kind,
      config
    })
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    if (ctx.signal.cancelled) {
      await ctx.gateway.deleteMedia?.(result.data.id).catch(() => undefined)
      return { status: 'skipped', reason: '已取消' }
    }
    const asset = result.data
    const prompt = config.mode === 'rate'
      ? `语速 ${config.rate} 倍 · 音量 ${config.volumePercent}%`
      : `目标时长 ${config.targetDurationMs}ms · 音量 ${config.volumePercent}%`
    ctx.updateResult(serializeMediaResultCollection(appendMediaResult(
      typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
      { mediaId: asset.id, mediaPath: asset.path, mime: asset.mime },
      { nodeId: ctx.node.id, modelKey: 'local:ffmpeg-sound-adjust', prompt, runId: ctx.runId }
    )))
    ctx.emitArtifact?.({
      kind,
      mediaId: asset.id,
      mediaPath: asset.path,
      mime: asset.mime,
      portId: kind === 'audio' ? 'out-audio' : 'out-video',
      title: asset.name || (kind === 'audio' ? '调整后音频' : '调整后视频')
    })
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
