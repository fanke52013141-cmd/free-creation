import { inputMedia, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality, resolveImageModelOption } from '../models'
import { readNodeConfig } from '../node-config'
import {
  parseImageEditConfig,
  validateImageEditConfig,
  type ImageEditAnnotation,
  type ImageEditColor
} from '@shared/image-edit'
import {
  appendMediaResult,
  parseMediaResultCollection,
  serializeMediaResultCollection
} from '../values'

/** 三种标注颜色对模型的语义（与工作台里的「红 · 修改 / 蓝 · 替换 / 黄 · 保留」一致）。 */
const ANNOTATION_COLOR_ROLE: Record<ImageEditColor, string> = {
  red: '需要修改',
  blue: '替换或调整',
  yellow: '需要保留或重点注意',
  orange: '替换或调整'
}

const ANNOTATION_TYPE_LABEL: Record<ImageEditAnnotation['type'], string> = {
  arrow: '箭头',
  rect: '矩形框选',
  brush: '涂画',
  text: '文字'
}

/**
 * 把「带文字的标注」翻译成模型能读的编号清单。
 *
 * 为什么必须有这一段：标注图里的一条箭头或一个框，只能表达“看这里”，表达不了
 * “改成什么”。用户在工作台里为标注写的文字如果不进提示词，模型就只能靠猜——
 * 这正是参考类 P 图工具（cowart 那一类）的核心做法：图形负责定位，文字负责语义。
 * 这里给每个标注编号，并同时给出颜色角色与标注类型，让模型能把图上的记号与
 * 文字一一对应，而不是把多段要求糊成一句。
 */
export function annotationInstructionLines(annotations: ImageEditAnnotation[]): string[] {
  return annotations
    .map((annotation, index) => ({ annotation, index }))
    .filter(({ annotation }) => Boolean(annotation.text?.trim()))
    .map(({ annotation, index }) => {
      const role = ANNOTATION_COLOR_ROLE[annotation.color] ?? ANNOTATION_COLOR_ROLE.red
      const type = ANNOTATION_TYPE_LABEL[annotation.type] ?? '标注'
      return `标注 ${index + 1}（${type}·${role}）：${annotation.text!.trim()}`
    })
}

/**
 * P 图产物命名（用户 2026-09-18 拍板）：与原图同名，最前面加带括号的「改」；
 * 同一张原图连续改多次时依次为「改1」「改2」……序号取自本节点已有的历史结果数，
 * 不依赖任何全局状态。
 */
export function imageEditResultName(sourceName: string, previousResultCount: number): string {
  const base = sourceName.trim() || '图片'
  const prefix = previousResultCount <= 0 ? '（改）' : `（改${previousResultCount}）`
  return `${prefix}${base}`
}

export const imageEditExecutor = async (
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> => {
  const source = inputMedia(ctx.inputs, 'in-image', 'image')[0]
  if (!source) return { status: 'skipped', reason: '请连接一张图片到“原图”输入' }
  const config = parseImageEditConfig(readNodeConfig(ctx.shape))
  const invalid = validateImageEditConfig(config)
  if (invalid) return { status: 'skipped', reason: invalid }
  const option = resolveImageModelOption(modelsByModality(ctx.providers, 'image'), {
    modelKey: config.modelKey
  })
  if (!option) return { status: 'skipped', reason: '未选择可用图片模型' }
  const annotationLines = annotationInstructionLines(config.annotations)
  const prompt = [
    config.instruction.trim(),
    inputText(ctx.inputs, 'in-text').trim(),
    config.annotations.length
      ? '输入包含两张参考：第 1 张是原图，第 2 张是带标注的原图。请以原图为准，根据第 2 张的标注修改，最终图像不要保留标注本身。红色表示需要修改，蓝色表示替换或调整，黄色表示需要保留或重点注意。'
      : '',
    annotationLines.length ? `标注说明：\n${annotationLines.join('\n')}` : '',
    config.mask?.enabled ? '请仅修改遮罩指定区域，未遮罩区域尽量保持不变。' : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  if (!prompt) return { status: 'skipped', reason: '请填写修改说明或添加标注' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const previous = parseMediaResultCollection(
    typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : ''
  )
  const resultName = imageEditResultName(source.name ?? '', previous?.results.length ?? 0)
  try {
    const result = await ctx.gateway.imageEdit({
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
    ctx.emitArtifact?.({
      kind: 'image',
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mime: result.data.mime,
      portId: 'out-image',
      title: resultName
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', reason: `图片修改异常：${message}` }
  }
}
