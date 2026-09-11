// 生图节点执行器：已有成片优先复用；否则按提示词与可选参考图调用图片模型。
import { inputJson, inputMedia, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality } from '../models'
import { mergedPrompt, parseJsonObj, promptBundleText } from '../helpers'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import {
  imageCapabilitiesFor,
  normalizeImageGenerationConfig,
  type ImageGenerationConfig
} from '@shared/image-capabilities'

export type ImageGenData = ImageGenerationConfig

export function parseImageGen(text: string): ImageGenData {
  const value = parseJsonObj(text)
  if (value) {
    return normalizeImageGenerationConfig(value, imageCapabilitiesFor('relay'))
  }
  return normalizeImageGenerationConfig({}, imageCapabilitiesFor('relay'))
}

export const imageGenExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const data = parseImageGen(readNodeConfig(ctx.shape))
  const option = modelsByModality(ctx.providers, 'image').find((item) => item.key === data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用图片模型' }
  const capabilities = imageCapabilitiesFor(option.provider.specId, option.model.id)
  const config = normalizeImageGenerationConfig(data, capabilities)
  const bundlePrompt = promptBundleText(inputJson(ctx.inputs, 'in-prompt')[0])
  const prompt = mergedPrompt(
    ctx.shape.props.text,
    [bundlePrompt, inputText(ctx.inputs, 'in-text')].filter(Boolean).join('\n')
  )
  // 所有参考图只有一个多值入口；按真实连线顺序提交，保证“图片 1/2/3”的提示词指代可复跑。
  const referenceImages = inputMedia(ctx.inputs, 'in-images', 'image')
  const referenceMediaIds = [...new Set(referenceImages.map((image) => image.mediaId))].slice(0, 4)
  if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const result = await ctx.gateway.imageGenerate({
      projectId: ctx.projectId,
      providerId: option.provider.id,
      modelId: option.model.id,
      prompt,
      size: config.size,
      ...(capabilities.forwardsAspectRatio && config.aspectRatio !== 'auto'
        ? { aspectRatio: config.aspectRatio }
        : {}),
      ...(referenceMediaIds.length > 0 ? { referenceMediaIds } : {})
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
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
    ctx.emitArtifact?.({
      kind: 'image',
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mime: result.data.mime,
      portId: 'out-image',
      title: result.data.name || '生成图片'
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `图片生成异常：${message}` }
  }
}
