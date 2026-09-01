import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { parseVideoFrameConfig, parseVideoClipConfig, parseVideoAudioConfig } from '@shared/video-transform'
import { appendMediaResult, serializeMediaResultCollection } from '../values'

// ── 视频取帧 ──

export async function videoFrameExecutor(
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-video', 'video')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段视频到"源视频"输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const config = parseVideoFrameConfig(readNodeConfig(ctx.shape))
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    const result = await ctx.gateway.extractVideoFrame({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    const prompt = `源视频 ${source.mediaId} · mode=${config.mode} · ${config.timeMs}ms · ${config.format}`
    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title: result.data.name || '视频帧'
    })
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime },
          {
            nodeId: ctx.node.id,
            modelKey: 'local:ffmpeg-frame',
            prompt,
            runId: ctx.runId
          }
        )
      )
    )
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

// ── 视频截取 ──

export async function videoClipExecutor(
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-video', 'video')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段视频到"源视频"输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const config = parseVideoClipConfig(readNodeConfig(ctx.shape))
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    const result = await ctx.gateway.clipVideo({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    const prompt = `源视频 ${source.mediaId} · ${config.startMs}-${config.endMs}ms · audio=${config.includeAudio} · ${config.quality}`
    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title: result.data.name || '视频片段'
    })
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime },
          {
            nodeId: ctx.node.id,
            modelKey: 'local:ffmpeg-clip',
            prompt,
            runId: ctx.runId
          }
        )
      )
    )
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

// ── 视频提音 ──

export async function videoAudioExecutor(
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-video', 'video')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段视频到"源视频"输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const config = parseVideoAudioConfig(readNodeConfig(ctx.shape))
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    const result = await ctx.gateway.extractVideoAudio({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    const prompt = `源视频 ${source.mediaId} · ${config.startMs}-${config.endMs}ms · ${config.format} · ${config.sampleRate}Hz`
    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title: result.data.name || '提取音频'
    })
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime },
          {
            nodeId: ctx.node.id,
            modelKey: 'local:ffmpeg-audio',
            prompt,
            runId: ctx.runId
          }
        )
      )
    )
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
