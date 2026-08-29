// 视频节点执行器：已有成片优先；否则提交文本/首帧任务并轮询至完成。
import { inputJson, inputMedia, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality } from '../../stores/gateway'
import { mergedPrompt, parseVideoGen, promptBundleText, waitForVideo } from './shared'
import { readNodeConfig } from '../../canvas/node-persistence'
import { appendMediaResult, serializeMediaResultCollection } from '../../nodes/nodeValues'

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
  if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
  try {
    const submitted = await window.api.gateway.videoSubmit({
      projectId: ctx.projectId,
      nodeId: ctx.node.id,
      providerId: option.provider.id,
      modelId: option.model.id,
      prompt,
      params: data.params,
      ...(firstFrame ? { firstFrameMediaId: firstFrame.mediaId } : {})
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!submitted.ok) return { status: 'failed', reason: submitted.error.message }
    const result = await waitForVideo(submitted.data.taskId, ctx.signal)
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
            runId: ctx.runId
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
