import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import {
  parseVideoFrameConfig,
  parseVideoClipConfig,
  parseVideoAudioConfig
} from '@shared/video-transform'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import { capabilityFailure, unavailableLocalCapability } from '../preflight'

// ── 视频取帧 ──

export async function videoFrameExecutor(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-video', 'video')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段视频到"源视频"输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const config = parseVideoFrameConfig(readNodeConfig(ctx.shape))
  for (const key of config.mode === 'last'
    ? (['ffmpeg', 'ffprobe'] as const)
    : (['ffmpeg'] as const)) {
    const capabilityReason = await unavailableLocalCapability(ctx.gateway, key)
    if (capabilityReason)
      return { status: 'failed', reason: capabilityFailure(key, capabilityReason) }
  }
  try {
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    const result = await ctx.gateway.extractVideoFrame({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    const prompt = `源视频 ${source.mediaId} · mode=${config.mode} · ${config.timeMs}ms · ${config.format}`
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
    ctx.emitArtifact?.({
      kind: 'image',
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mime: result.data.mime,
      portId: 'out-image',
      title: result.data.name || '视频帧'
    })
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

// ── 视频截取（A3：画面 + 音频合并为同一节点，contractVersion 5）──

export async function videoClipExecutor(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-video', 'video')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段视频到"源视频"输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const config = parseVideoClipConfig(readNodeConfig(ctx.shape))
  if (!config.keepVideo && !config.keepAudio)
    return { status: 'failed', reason: '请至少选择保留画面或音频' }
  for (const key of ['ffmpeg'] as const) {
    const capabilityReason = await unavailableLocalCapability(ctx.gateway, key)
    if (capabilityReason)
      return { status: 'failed', reason: capabilityFailure(key, capabilityReason) }
  }
  try {
    type Produced = {
      kind: 'video' | 'audio'
      portId: string
      modelKey: string
      data: { id: string; path: string; mime: string; name?: string }
    }
    const produced: Produced[] = []
    if (config.keepVideo) {
      if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
      const result = await ctx.gateway.clipVideo({
        projectId: ctx.projectId,
        sourceMediaId: source.mediaId,
        config
      })
      if (!result.ok) return { status: 'failed', reason: result.error.message }
      produced.push({
        kind: 'video',
        portId: 'out-video',
        modelKey: 'local:ffmpeg-clip',
        data: result.data
      })
    }
    if (config.keepAudio) {
      if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
      const result = await ctx.gateway.extractVideoAudio({
        projectId: ctx.projectId,
        sourceMediaId: source.mediaId,
        config: {
          version: 2,
          startMs: config.startMs,
          endMs: config.endMs,
          format: config.audioFormat,
          sampleRate: config.audioSampleRate
        }
      })
      if (!result.ok) return { status: 'failed', reason: result.error.message }
      produced.push({
        kind: 'audio',
        portId: 'out-audio',
        modelKey: 'local:ffmpeg-audio',
        data: result.data
      })
    }
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    const prompt = `${config.keepVideo ? '画面' : ''}${config.keepVideo && config.keepAudio ? '+' : ''}${config.keepAudio ? '音频' : ''} · 源视频 ${source.mediaId} · ${config.startMs}-${config.endMs}ms`
    const previous = typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : ''
    let collection = appendMediaResult(
      previous,
      {
        mediaId: produced[0].data.id,
        mediaPath: produced[0].data.path,
        mime: produced[0].data.mime
      },
      { nodeId: ctx.node.id, modelKey: produced[0].modelKey, prompt, runId: ctx.runId }
    )
    for (const item of produced.slice(1)) {
      collection = appendMediaResult(
        serializeMediaResultCollection(collection),
        { mediaId: item.data.id, mediaPath: item.data.path, mime: item.data.mime },
        { nodeId: ctx.node.id, modelKey: item.modelKey, prompt, runId: ctx.runId }
      )
    }
    ctx.updateResult(serializeMediaResultCollection(collection))
    for (const item of produced) {
      ctx.emitArtifact?.({
        kind: item.kind,
        mediaId: item.data.id,
        mediaPath: item.data.path,
        mime: item.data.mime,
        portId: item.portId,
        title: item.data.name || (item.kind === 'video' ? '视频片段' : '音频片段')
      })
    }
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

// ── 视频提音 ──

export async function videoAudioExecutor(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-video', 'video')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段视频到"源视频"输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const capabilityReason = await unavailableLocalCapability(ctx.gateway, 'ffmpeg')
  if (capabilityReason)
    return { status: 'failed', reason: capabilityFailure('ffmpeg', capabilityReason) }
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
    ctx.emitArtifact?.({
      kind: 'audio',
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mime: result.data.mime,
      portId: 'out-audio',
      title: result.data.name || '音频片段'
    })
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
