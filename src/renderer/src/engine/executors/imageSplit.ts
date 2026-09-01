// 图片宫格拆分节点：1 张真实输入图 → N 张已落盘图片资产 + 可连接的结构化列表。
import { inputMedia } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../../canvas/node-persistence'
import { parseImageSplitConfig } from '@shared/image-split'
import { serializeMediaResultCollection } from '../../nodes/nodeValues'

export const imageSplitExecutor = async (
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> => {
  const source = inputMedia(ctx.inputs, 'in-image', 'image')[0]
  if (!source) return { status: 'skipped', reason: '请连接一张图片到“原图”输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const config = parseImageSplitConfig(readNodeConfig(ctx.shape))
  try {
    const response = await window.api.splitImageGrid({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!response.ok) return { status: 'failed', reason: response.error.message }
    const [selected] = response.data
    if (!selected) return { status: 'failed', reason: '图片拆分未生成任何结果' }
    const now = Date.now()
    // 每次运行是完整的一次派生，不与上次的格子混合；失败时主进程会回滚本次已落盘资产。
    ctx.updateProps({
      mediaId: selected.id,
      mediaPath: selected.path,
      mediaMime: selected.mime,
      title: '图片拆分'
    })
    ctx.updateResult(
      serializeMediaResultCollection({
        kind: 'media-source',
        version: 1,
        nodeId: ctx.node.id,
        modelKey: 'local:image-grid-split',
        prompt: `源图片 ${source.mediaId} · ${config.rows}×${config.columns} · 面积 ${config.scalePercent}%`,
        at: now,
        selectedMediaId: selected.id,
        results: response.data.map((asset) => ({
          mediaId: asset.id,
          mediaPath: asset.path,
          mime: asset.mime,
          createdAt: now,
          runId: ctx.runId
        }))
      })
    )
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', reason: `本地图片拆分异常：${message}` }
  }
}
