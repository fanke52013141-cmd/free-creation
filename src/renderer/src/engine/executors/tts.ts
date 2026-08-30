// TTS 语音复刻节点执行器：用本地 ComfyUI IndexTTS-2.5 合成音频。
import { inputMedia, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from './shared'
import { readNodeConfig } from '../../canvas/node-persistence'
import { appendMediaResult, serializeMediaResultCollection } from '../../nodes/nodeValues'
import { parseTtsConfig } from '@shared/tts'

export const ttsExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const config = parseTtsConfig(readNodeConfig(ctx.shape))
  const text = mergedPrompt(config.text, inputText(ctx.inputs, 'in-text')).trim()
  if (!text) return { status: 'skipped', reason: '无朗读文本' }

  // 优先使用上游连接传入的参考音频；否则从节点配置中手动上传的参考音频获取。
  const refAudio = inputMedia(ctx.inputs, 'in-audio', 'audio')[0]
  const referenceAudioId = refAudio?.mediaId ?? config.refMediaId
  if (!referenceAudioId) return { status: 'skipped', reason: '缺少参考语音' }

  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }

  try {
    const result = await window.api.ttsGenerate({
      projectId: ctx.projectId,
      referenceAudioId,
      text,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }

    ctx.updateProps({
      mediaId: result.data.id,
      mediaPath: result.data.path,
      mediaMime: result.data.mime,
      title: result.data.name || text.slice(0, 40)
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
    return { status: 'failed', reason: `语音复刻异常：${message}` }
  }
}
