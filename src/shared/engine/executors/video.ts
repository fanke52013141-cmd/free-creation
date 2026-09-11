// 视频节点执行器：已有成片优先；否则提交文本/首帧任务并轮询至完成。
import { inputJson, inputMedia, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality } from '../models'
import { mergedPrompt, parseVideoGen, promptBundleText, waitForVideo } from '../helpers'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import {
  isSeedanceGatewayProxy,
  normalizeVideoGenParams,
  videoCapabilitiesFor,
  videoCapabilityIssues,
  resolveVideoMode,
  videoRatioIsDerivedByFrames
} from '@shared/video-capabilities'

export const videoExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const data = parseVideoGen(readNodeConfig(ctx.shape))
  const option = modelsByModality(ctx.providers, 'video').find((item) => item.key === data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用视频模型' }
  const bundlePrompt = promptBundleText(inputJson(ctx.inputs, 'in-prompt')[0])
  const prompt = mergedPrompt(
    ctx.shape.props.text,
    [bundlePrompt, inputText(ctx.inputs, 'in-text')].filter(Boolean).join('\n')
  )
  // 视频节点只有一个图片多值端口：连接顺序即语义。第一张是主图/首帧，
  // 后续图片是有序参考图，避免在画布边缘摆出多个同色、同类型端口。
  const images = inputMedia(ctx.inputs, 'in-images', 'image')
  const motionReferences = inputMedia(ctx.inputs, 'in-reference-video', 'video')
  const audioReferences = inputMedia(ctx.inputs, 'in-reference-audio', 'audio')
  const capabilities = videoCapabilitiesFor(option.provider.specId, option.model.id, {
    gatewayProxy: isSeedanceGatewayProxy(option.provider.specId, option.provider.baseURL)
  })
  const { mode } = resolveVideoMode(capabilities, {
    mode: data.mode,
    imageCount: images.length,
    referenceVideoCount: motionReferences.length,
    referenceAudioCount: audioReferences.length
  })
  if (!mode) return { status: 'skipped', reason: '当前模型不支持已连接的参考素材组合' }
  const firstFrame = mode === 'first-frame' || mode === 'first-last-frame' ? images[0] : undefined
  const lastFrame = mode === 'first-last-frame' ? images[1] : undefined
  const referenceImages = mode === 'reference' ? images : []
  const params = normalizeVideoGenParams(capabilities, data.params, {
    framesDetermineRatio: videoRatioIsDerivedByFrames(
      option.provider.specId,
      option.model.id,
      Boolean(firstFrame || lastFrame)
    )
  })
  if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
  const inputIssues = videoCapabilityIssues(capabilities, {
    prompt,
    params,
    mode,
    hasFirstFrame: Boolean(firstFrame),
    hasLastFrame: Boolean(lastFrame),
    imageCount: images.length,
    referenceImageCount: referenceImages.length,
    referenceVideoCount: motionReferences.length,
    referenceAudioCount: audioReferences.length
  })
  if (inputIssues.length > 0) return { status: 'skipped', reason: inputIssues.join('；') }
  try {
    const submitted = await ctx.gateway.videoSubmit({
      projectId: ctx.projectId,
      nodeId: ctx.node.id,
      providerId: option.provider.id,
      modelId: option.model.id,
      prompt,
      mode,
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
    ctx.emitArtifact?.({
      kind: 'video',
      mediaId: result.mediaId,
      mediaPath: result.mediaPath,
      mime: result.mime,
      portId: 'out-video',
      title: result.name || '生成视频'
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `视频生成异常：${message}` }
  }
}
