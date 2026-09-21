// TTS 语音复刻节点执行器：本地 ComfyUI IndexTTS-2.5 或 MiniMax 快速复刻。
import { inputMedia, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from '../helpers'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import { parseTtsConfig } from '@shared/tts'
import { featureKeyOf, resolveFeatureOption } from '../models'

export const ttsExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const config = parseTtsConfig(readNodeConfig(ctx.shape))
  // 固定参数归 config，用户正文归 props.text；这与节点契约和保存模型一致。
  const text = mergedPrompt(ctx.shape.props.text, inputText(ctx.inputs, 'in-text')).trim()
  if (!text) return { status: 'skipped', reason: '无朗读文本' }

  // 优先使用上游连接传入的参考音频；否则从节点配置中手动上传的参考音频获取。
  const refAudio = inputMedia(ctx.inputs, 'in-audio', 'audio')[0]
  const referenceAudioId = refAudio?.mediaId ?? config.refMediaId
  if (!referenceAudioId) return { status: 'skipped', reason: '缺少参考语音' }

  const effectiveConfig = { ...config }
  if (config.backend === 'minimax') {
    const option = await resolveFeatureOption(ctx.gateway, ctx.providers, featureKeyOf(config, 'voice.clone'), 'voice.clone')
    if (!option) return { status: 'skipped', reason: '功能 voice.clone 尚未绑定已验证语音复刻模型' }
    effectiveConfig.providerId = option.provider.id
    effectiveConfig.modelId = option.model.id
  }

  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }

  try {
    const result = await ctx.gateway.ttsGenerate({
      projectId: ctx.projectId,
      referenceAudioId,
      text,
      config: effectiveConfig
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }

    const { asset, voiceId } = result.data
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          {
            mediaId: asset.id,
            mediaPath: asset.path,
            mime: asset.mime
          },
          {
            nodeId: ctx.node.id,
            prompt: text.slice(0, 80),
            runId: ctx.runId,
            // 试听音频的溯源用服务端登记回来的 ID，而不是用户填进输入框的那个。
            voiceId
          }
        )
      )
    )
    // 复刻出的音色本身是可复用结果：以结构化音色档案暴露给下游配音节点。
    // 本地 IndexTTS 链路没有服务端音色标识，此时清空而不是保留上一次的档案。
    ctx.updateMeta?.({
      nodeExtra: voiceId
        ? JSON.stringify({
            'out-json': {
              voice_id: voiceId,
              provider: 'minimax',
              source: 'voice_clone',
              label: effectiveConfig.voiceId.trim() || voiceId,
              preview_media_id: asset.id
            }
          })
        : undefined
    })
    ctx.emitArtifact?.({
      kind: 'audio',
      mediaId: asset.id,
      mediaPath: asset.path,
      mime: asset.mime,
      portId: 'out-audio',
      title: asset.name || '语音复刻结果'
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `语音复刻异常：${message}` }
  }
}
