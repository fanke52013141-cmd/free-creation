import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, mediaDisplayName, serializeMediaResultCollection } from '../values'
import { capabilityFailure, unavailableLocalCapability } from '../preflight'
import {
  parseVideoClayConfig,
  parseVideoDepthConfig,
  type VideoClayConfig,
  type VideoDepthConfig
} from '../../video-conversion'

type Mode = 'depth' | 'clay'

async function executeVideoAiNode(ctx: NodeExecutionContext, mode: Mode): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-video', 'video')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段视频到“源视频”输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }

  const ffmpegReason = await unavailableLocalCapability(ctx.gateway, 'ffmpeg')
  if (ffmpegReason) return { status: 'failed', reason: capabilityFailure('ffmpeg', ffmpegReason) }

  const status = await ctx.gateway.getVideoEngineStatus?.()
  if (!status) return { status: 'failed', reason: '当前运行环境不支持本地视频 AI 节点' }
  if (!status.ok) return { status: 'failed', reason: status.error.message }
  if (!status.data.ready) {
    const action = status.data.pythonAvailable
      ? '请在节点设置中安装本地推理环境'
      : '请先安装 Python 3.12（64 位），再从节点设置安装本地推理环境'
    return { status: 'failed', reason: `${action}。${status.data.message}` }
  }

  const config: VideoDepthConfig | VideoClayConfig =
    mode === 'depth'
      ? parseVideoDepthConfig(readNodeConfig(ctx.shape))
      : parseVideoClayConfig(readNodeConfig(ctx.shape))
  const jobId = `${ctx.node.id}:${ctx.runId ?? Date.now()}`
  const convert = mode === 'depth' ? ctx.gateway.convertVideoDepth : ctx.gateway.convertVideoClay
  if (!convert) return { status: 'failed', reason: '当前运行环境缺少本地视频转换能力' }

  let cancelRequested = false
  const cancelPoll = setInterval(() => {
    if (ctx.signal.cancelled) {
      cancelRequested = true
      const cancel = ctx.gateway.cancelVideoConversion
      if (cancel) void cancel(jobId).catch(() => undefined)
    }
  }, 500)
  try {
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    const result = await convert({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      jobId,
      config
    })
    if (ctx.signal.cancelled || cancelRequested) {
      if (result.ok) await ctx.gateway.deleteMedia?.(result.data.id).catch(() => undefined)
      return { status: 'skipped', reason: '已取消' }
    }
    if (!result.ok) return { status: 'failed', reason: result.error.message }

    const videoName = mediaDisplayName(source, '视频')
    const outputName = mode === 'depth' ? '深度视频' : '白模视频'
    const prompt = `${outputName} · ${videoName} · ${config.maxResolution}px`
    const previous = typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : ''
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          previous,
          { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime },
          { nodeId: ctx.node.id, modelKey: 'local:video-depth-anything-small', prompt, runId: ctx.runId }
        )
      )
    )
    ctx.emitArtifact?.({
      kind: 'video',
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mime: result.data.mime,
      portId: 'out-video',
      title: `（${outputName}）${videoName}`
    })
    return { status: 'done' }
  } catch (error) {
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearInterval(cancelPoll)
  }
}

export const videoDepthExecutor = (ctx: NodeExecutionContext): Promise<NodeExecutionResult> =>
  executeVideoAiNode(ctx, 'depth')

export const videoClayExecutor = (ctx: NodeExecutionContext): Promise<NodeExecutionResult> =>
  executeVideoAiNode(ctx, 'clay')
