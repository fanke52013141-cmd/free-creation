// 图片裁剪节点执行器：只消费 in-image 的真实上游资产，由 M0 本地媒体引擎产生新资产。
import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { parseImageCropConfig } from '@shared/image-crop'
import {
  appendMediaResult,
  mediaDisplayName,
  parseMediaResultCollection,
  serializeMediaResultCollection
} from '../values'

/**
 * 裁剪产物命名沿用 P 图规则（用户 2026-09-18 拍板）：与原图同名，前缀「（裁）」；
 * 同一节点裁出多张时按已有结果数编号。
 */
export function imageCropResultName(sourceName: string, previousResultCount: number): string {
  const base = sourceName.trim() || '图片'
  return previousResultCount <= 0 ? `（裁）${base}` : `（裁${previousResultCount}）${base}`
}

export const imageCropExecutor = async (
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> => {
  const source = inputMedia(ctx.inputs, 'in-image', 'image')[0]
  if (!source) return { status: 'skipped', reason: '请连接一张图片到“原图”输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const config = parseImageCropConfig(readNodeConfig(ctx.shape))
  const sourceName = mediaDisplayName(source, '图片')
  const prompt = `裁剪 ${sourceName} · ${config.mode === 'quad' ? '四点透视' : '矩形'}${
    config.aspectRatio === 'free' ? '' : ` · ${config.aspectRatio}`
  }`
  try {
    const result = await ctx.gateway.cropImage({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    const previous = parseMediaResultCollection(
      typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : ''
    )
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime },
          {
            nodeId: ctx.node.id,
            modelKey: 'local:canvas-crop',
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
      title: imageCropResultName(sourceName, previous?.results.length ?? 0)
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', reason: `本地图片裁剪异常：${message}` }
  }
}
