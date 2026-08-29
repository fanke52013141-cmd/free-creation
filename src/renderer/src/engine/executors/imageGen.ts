// 生图节点执行器：已有成片优先复用；否则按提示词与可选参考图调用图片模型。
import { inputJson, inputMedia, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality } from '../../stores/gateway'
import { mergedPrompt, parseJsonObj, promptBundleText } from './shared'
import { readNodeConfig } from '../../canvas/node-persistence'
import { appendMediaResult, serializeMediaResultCollection } from '../../nodes/nodeValues'

export interface ImageGenData {
  prompt: string
  modelKey: string
  size: string
  /** 固定种子（>0 时启用） */
  seed?: number
}

export function parseImageGen(text: string): ImageGenData {
  const value = parseJsonObj(text)
  if (value && typeof value.prompt === 'string') {
    return {
      prompt: value.prompt,
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      size: typeof value.size === 'string' ? value.size : 'auto',
      seed: typeof value.seed === 'number' ? value.seed : undefined
    }
  }
  return { prompt: text, modelKey: '', size: 'auto' }
}

export const imageGenExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  // 已生成的图片是稳定的数据源；不在每次整图运行时重复生成。
  if (ctx.shape.props.mediaPath) return { status: 'done' }
  const data = parseImageGen(readNodeConfig(ctx.shape))
  const option = modelsByModality(ctx.providers, 'image').find((item) => item.key === data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用图片模型' }
  const bundlePrompt = promptBundleText(inputJson(ctx.inputs, 'in-prompt')[0])
  const prompt = mergedPrompt(
    data.prompt,
    [bundlePrompt, inputText(ctx.inputs, 'in-text')].filter(Boolean).join('\n')
  )
  const referenceImage = inputMedia(ctx.inputs, 'in-image', 'image')[0]
  if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const result = await window.api.gateway.imageGenerate({
      projectId: ctx.projectId,
      providerId: option.provider.id,
      modelId: option.model.id,
      prompt,
      size: data.size,
      ...(typeof data.seed === 'number' && data.seed > 0 ? { seed: data.seed } : {}),
      ...(referenceImage ? { referenceMediaId: referenceImage.mediaId } : {})
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title: result.data.name || result.data.id
    })
    // 来源追溯：记录产生本节点的模型、输入摘要与时间，供「追踪到产生它的节点和输入」。
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
            prompt: prompt.slice(0, 80),
            runId: ctx.runId
          }
        )
      )
    )
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `图片生成异常：${message}` }
  }
}
