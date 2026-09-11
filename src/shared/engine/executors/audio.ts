// 音频资产节点只承接/保存媒体；通用配音节点（speech）才调用语音模型。
import { inputText } from '../inputs'
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
  // audio 是纯资产源节点，不读取或转发上游值；只有其已导入媒体才可发布为 out-audio。
  if (ctx.node.type === 'audio') {
    return ctx.shape.props.mediaPath
      ? { status: 'done' }
      : { status: 'skipped', reason: '未导入音频资产' }
  }
  if (ctx.node.type !== 'speech') {
    return { status: 'skipped', reason: '音频执行器不支持该节点类型' }
  }
  const data = parseAudio(readNodeConfig(ctx.shape))
  const option = modelsByModality(ctx.providers, 'audio').find((item) => item.key === data.modelKey)
  if (!option) return { status: 'skipped', reason: '未选择可用音频模型' }
  // 节点正文是用户可编辑内容，固定参数仅从 config 读取；不可再让 config 中的
  // 历史 text 悄悄覆盖画布正文。
  const text = mergedPrompt(ctx.shape.props.text, inputText(ctx.inputs, 'in-text'))
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
    ctx.emitArtifact?.({
      kind: 'audio',
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mime: result.data.mime,
      portId: 'out-audio',
      title: result.data.name || '生成语音'
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `语音合成异常：${message}` }
  }
}
