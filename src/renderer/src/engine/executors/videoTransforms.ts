import { inputMedia } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../../canvas/node-persistence'
import { parseVideoFrameConfig, parseVideoRangeConfig } from '@shared/video-transform'
import { appendMediaResult, serializeMediaResultCollection } from '../../nodes/nodeValues'

type TransformKind = 'frame' | 'clip' | 'audio'

async function executeVideoTransform(
  ctx: NodeExecutionContext,
  kind: TransformKind
): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-video', 'video')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段视频到“源视频”输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    let result: Awaited<ReturnType<typeof window.api.extractVideoFrame>>
    let prompt: string
    if (kind === 'frame') {
      const config = parseVideoFrameConfig(readNodeConfig(ctx.shape))
      result = await window.api.extractVideoFrame({
        projectId: ctx.projectId,
        sourceMediaId: source.mediaId,
        config
      })
      prompt = `源视频 ${source.mediaId} · ${config.timeMs}ms`
    } else {
      const config = parseVideoRangeConfig(readNodeConfig(ctx.shape))
      const input = { projectId: ctx.projectId, sourceMediaId: source.mediaId, config }
      result =
        kind === 'clip'
          ? await window.api.clipVideo(input)
          : await window.api.extractVideoAudio(input)
      prompt = `源视频 ${source.mediaId} · ${config.startMs}-${config.endMs}ms${config.removeBackground ? ' · 人声分离' : ''}`
    }
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title:
        result.data.name ||
        (kind === 'frame' ? '视频帧' : kind === 'clip' ? '视频片段' : '提取音频')
    })
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime },
          {
            nodeId: ctx.node.id,
            modelKey: `local:ffmpeg-${kind}`,
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

export const videoFrameExecutor = (ctx: NodeExecutionContext): Promise<NodeExecutionResult> =>
  executeVideoTransform(ctx, 'frame')

export const videoClipExecutor = (ctx: NodeExecutionContext): Promise<NodeExecutionResult> =>
  executeVideoTransform(ctx, 'clip')

export const videoAudioExecutor = (ctx: NodeExecutionContext): Promise<NodeExecutionResult> =>
  executeVideoTransform(ctx, 'audio')
