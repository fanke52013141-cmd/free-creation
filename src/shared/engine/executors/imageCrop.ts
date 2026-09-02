// 图片裁剪节点执行器：只消费 in-image 的真实上游资产，由 M0 本地媒体引擎产生新资产。
import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { parseImageCropConfig } from '@shared/image-crop'
import { appendMediaResult, serializeMediaResultCollection } from '../values'

export const imageCropExecutor = async (
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> => {
  const source = inputMedia(ctx.inputs, 'in-image', 'image')[0]
  if (!source) return { status: 'skipped', reason: '请连接一张图片到“原图”输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const result = await ctx.gateway.cropImage({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      config: parseImageCropConfig(readNodeConfig(ctx.shape))
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title: result.data.name || '裁剪图片'
    })
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime },
          {
            nodeId: ctx.node.id,
            modelKey: 'local:canvas-crop',
            prompt: `源图片 ${source.mediaId} · ${parseImageCropConfig(readNodeConfig(ctx.shape)).mode} 裁剪`,
            runId: ctx.runId
          }
        )
      )
    )
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', reason: `本地图片裁剪异常：${message}` }
  }
}
