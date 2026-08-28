// 音频节点执行器：优先用上游音频资产；否则按语音合成配置生成。
import { inputMedia, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { modelsByModality } from '../../stores/gateway'
import { mergedPrompt, parseJsonObj } from './shared'
import { readNodeConfig } from '../../canvas/node-persistence'
import { appendMediaResult, serializeMediaResultCollection } from '../../nodes/nodeValues'

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
  const data = parseAudio(readNodeConfig(ctx.shape))
  if (data.mode !== 'generate') return { status: 'skipped', reason: '请上传音频或切换到语音合成' }
  const option = modelsByModality(ctx.providers, 'audio').find((item) => item.key === data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用音频模型' }
  const text = mergedPrompt(data.text, inputText(ctx.inputs, 'in-text'))
  if (!text.trim()) return { status: 'skipped', reason: '无朗读文本' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  try {
    const result = await window.api.gateway.audioGenerate({
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
          { nodeId: ctx.node.id, modelKey: option.key, prompt: text.slice(0, 80) }
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
