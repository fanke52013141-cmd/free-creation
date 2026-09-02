// 视频节点执行器：已有成片优先；否则提交文本/首帧任务并轮询至完成。
import { inputJson, inputMedia, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality } from '../models'
import { mergedPrompt, parseVideoGen, promptBundleText, waitForVideo } from '../helpers'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import {
  normalizeVideoGenParams,
  videoCapabilitiesFor,
  videoRatioIsDerivedByFrames
} from '@shared/video-capabilities'

export const videoExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  // 与图片节点一致，已有成片优先作为下游视频输出。
  if (ctx.shape.props.mediaPath) return { status: 'done' }
  const data = parseVideoGen(readNodeConfig(ctx.shape))
  const option = modelsByModality(ctx.providers, 'video').find((item) => item.key === data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用视频模型' }
  const bundlePrompt = promptBundleText(inputJson(ctx.inputs, 'in-prompt')[0])
  const prompt = mergedPrompt(
    data.prompt,
    [bundlePrompt, inputText(ctx.inputs, 'in-text')].filter(Boolean).join('\n')
  )
  const firstFrame = inputMedia(ctx.inputs, 'in-image', 'image')[0]
  const lastFrame = inputMedia(ctx.inputs, 'in-last-image', 'image')[0]
  const referenceImages = inputMedia(ctx.inputs, 'in-reference-images', 'image')
  const motionReferences = inputMedia(ctx.inputs, 'in-reference-video', 'video')
  const audioReferences = inputMedia(ctx.inputs, 'in-reference-audio', 'audio')
  const params = normalizeVideoGenParams(
    videoCapabilitiesFor(option.provider.specId, option.model.id),
    data.params,
    {
      framesDetermineRatio: videoRatioIsDerivedByFrames(
        option.provider.specId,
        option.model.id,
        Boolean(firstFrame || lastFrame)
      )
    }
  )
  if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
  try {
    const submitted = await ctx.gateway.videoSubmit({
      projectId: ctx.projectId,
      nodeId: ctx.node.id,
      providerId: option.provider.id,
      modelId: option.model.id,
      prompt,
      params,
      ...(firstFrame ? { firstFrameMediaId: firstFrame.mediaId } : {}),
      ...(lastFrame ? { lastFrameMediaId: lastFrame.mediaId } : {}),
      ...(referenceImages.length
        ? { referenceImageMediaIds: referenceImages.map((media) => media.mediaId) }
        : {}),
      ...(motionReferences.length
        ? { referenceVideoMediaIds: motionReferences.map((media) => media.mediaId) }
        : {}),
      ...(audioReferences.length
        ? { referenceAudioMediaIds: audioReferences.map((media) => media.mediaId) }
        : {})
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!submitted.ok) return { status: 'failed', reason: submitted.error.message }
    const result = await waitForVideo(ctx.gateway, submitted.data.taskId, ctx.signal)
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    ctx.updateProps({
      mediaId: result.mediaId,
      mediaPath: result.mediaPath,
      mediaMime: result.mime,
      title: result.name
    })
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          {
            mediaId: result.mediaId,
            mediaPath: result.mediaPath,
            mime: result.mime
          },
          {
            nodeId: ctx.node.id,
            modelKey: option.key,
            prompt: prompt.slice(0, 80),
            runId: ctx.runId,
            genParams: {
              ratio: params.ratio,
              duration: params.duration,
              resolution: params.resolution,
              generateAudio: params.generateAudio,
              seed: params.seed
            },
            sourceSummary: {
              firstFrame: Boolean(firstFrame),
              lastFrame: Boolean(lastFrame),
              referenceImages: referenceImages.length,
              referenceVideo: motionReferences.length,
              referenceAudio: audioReferences.length
            }
          }
        )
      )
    )
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `视频生成异常：${message}` }
  }
}
