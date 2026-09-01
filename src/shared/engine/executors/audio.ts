// 音频资产节点只承接/保存媒体；通用配音节点（speech）才调用语音模型。
import { inputMedia, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality } from '../models'
import { mergedPrompt, parseJsonObj } from '../helpers'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, serializeMediaResultCollection } from '../values'

interface AudioData {
  mode: 'upload' | 'generate'
  modelKey: string
  text: string
  voice: string
  format: string
}

export function parseAudio(text: string): AudioData {
  const value = parseJsonObj(text)
  if (value && (value.mode === 'upload' || value.mode === 'generate')) {
    return {
      mode: value.mode,
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      text: typeof value.text === 'string' ? value.text : '',
      voice: typeof value.voice === 'string' ? value.voice : 'alloy',
      format: typeof value.format === 'string' ? value.format : 'mp3'
    }
  }
  return { mode: 'upload', modelKey: '', text: '', voice: 'alloy', format: 'mp3' }
}

export const audioExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const audioInput = inputMedia(ctx.inputs, 'in-audio', 'audio')[0]
  if (audioInput) {
    ctx.updateProps({
      mediaId: audioInput.mediaId,
      mediaPath: audioInput.mediaPath,
      mediaMime: audioInput.mime
    })
    return { status: 'done' }
  }
  if (ctx.shape.props.mediaPath) return { status: 'done' }
  if (ctx.node.type !== 'speech') {
    return { status: 'skipped', reason: '请上传音频或连接一段上游音频资产' }
  }
  const data = parseAudio(readNodeConfig(ctx.shape))
  const option = modelsByModality(ctx.providers, 'audio').find((item) => item.key === data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用音频模型' }
  const text = mergedPrompt(data.text, inputText(ctx.inputs, 'in-text'))
  if (!text.trim()) return { status: 'skipped', reason: '无朗读文本' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const result = await ctx.gateway.audioGenerate({
      projectId: ctx.projectId,
      providerId: option.provider.id,
      modelId: option.model.id,
      text,
      voice: data.voice,
      format: data.format
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title: result.data.name || result.data.id
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
            prompt: text.slice(0, 80),
            runId: ctx.runId
          }
        )
      )
    )
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `语音合成异常：${message}` }
  }
}
