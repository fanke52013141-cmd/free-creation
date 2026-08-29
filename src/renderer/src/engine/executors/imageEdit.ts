import { inputMedia, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality } from '../../stores/gateway'
import { readNodeConfig } from '../../canvas/node-persistence'
import { parseImageEditConfig, validateImageEditConfig } from '@shared/image-edit'
import { appendMediaResult, serializeMediaResultCollection } from '../../nodes/nodeValues'

export const imageEditExecutor = async (
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> => {
  const source = inputMedia(ctx.inputs, 'in-image', 'image')[0]
  if (!source) return { status: 'skipped', reason: '请连接一张图片到“原图”输入' }
  const config = parseImageEditConfig(readNodeConfig(ctx.shape))
  const invalid = validateImageEditConfig(config)
  if (invalid) return { status: 'skipped', reason: invalid }
  const option = modelsByModality(ctx.providers, 'image').find(
    (item) => item.key === config.modelKey
  )
  if (!option) return { status: 'skipped', reason: '未选择可用图片模型' }
  const prompt = [
    config.instruction.trim(),
    inputText(ctx.inputs, 'in-text').trim(),
    config.annotations.length ? '请根据图片中的标注进行修改，最终图像不要保留标注本身。' : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  if (!prompt) return { status: 'skipped', reason: '请填写修改说明或添加标注' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const result = await window.api.gateway.imageEdit({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      providerId: option.provider.id,
      modelId: option.model.id,
      prompt,
      size: config.size,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title: result.data.name || '图片修改'
    })
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          {
            mediaId: result.data.id,
            mediaPath: result.data.path,
            mime: result.data.mime
          },
          {
            nodeId: ctx.node.id,
            modelKey: option.key,
            prompt: prompt.slice(0, 120),
            runId: ctx.runId
          }
        )
      )
    )
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', reason: `图片修改异常：${message}` }
  }
}
