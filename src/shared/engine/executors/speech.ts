// 配音节点执行器：按 config.backend 选择供应商协议合成语音。
//
// 这是「模型驱动输入/输出结构」的执行侧：端口由 NodeTypeSpec.resolvePorts 按
// backend 派生，执行器同样只读取当前 backend 真正需要的输入——不按上游节点标题
// 或类型猜测，也不会把某家供应商的参数发给另一家。
import {
  VOLC_REFERENCE_AUDIO_MAX_COUNT,
  parseSpeechConfig,
  SPEECH_TEXT_LIMITS
} from '@shared/speech'
import { parseVoiceProfile } from '@shared/voice-design'
import { inputJson, inputMedia, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from '../helpers'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import { featureKeyOf, resolveFeatureOption } from '../models'

export const speechExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const config = parseSpeechConfig(readNodeConfig(ctx.shape))
  // 固定参数归 config，用户正文归 props.text；与节点契约和保存模型一致。
  const text = mergedPrompt(ctx.shape.props.text, inputText(ctx.inputs, 'in-text')).trim()
  if (!text) return { status: 'skipped', reason: '无朗读文本' }

  const option = ctx.gateway.resolveModelFeature
    ? await resolveFeatureOption(ctx.gateway, ctx.providers, featureKeyOf(config, 'speech.synthesize'), 'speech.synthesize', config.providerId && config.modelId ? `${config.providerId}::${config.modelId}` : undefined)
    : null
  if (ctx.gateway.resolveModelFeature && !option) return { status: 'skipped', reason: '功能 speech.synthesize 尚未绑定已验证语音模型' }
  if (!ctx.gateway.resolveModelFeature && !config.providerId) return { status: 'skipped', reason: '未选择语音模型' }
  const effectiveConfig = option ? {
    ...config,
    backend: option.provider.specId === 'minimax' ? 'minimax' : option.provider.specId === 'volc-speech' ? 'volc' : config.backend
  } : config

  const limit = SPEECH_TEXT_LIMITS[effectiveConfig.backend]
  if (text.length > limit) {
    return { status: 'failed', reason: `朗读文本超过 ${limit} 字符上限（当前 ${text.length}）` }
  }

  // 音色优先级：上游「音色设计」节点的音色档案 > 节点内填写的 Voice ID。
  const profile =
    effectiveConfig.backend === 'minimax'
      ? inputJson(ctx.inputs, 'in-voice')
          .map((value) => parseVoiceProfile(value))
          .find((value): value is NonNullable<typeof value> => value !== null)
      : undefined
  // 连线音频按连线顺序排列，节点上传项追加在末尾；两种来源合并后共同受三段上限约束。
  const connectedAudio =
    effectiveConfig.backend === 'volc' ? inputMedia(ctx.inputs, 'in-audio', 'audio') : []
  const referenceAudioIds = [
    ...connectedAudio.map((item) => item.mediaId),
    ...(effectiveConfig.backend === 'volc' && config.referenceAudioId && config.referenceAudioPath
      ? [config.referenceAudioId]
      : [])
  ]
  if (
    effectiveConfig.backend === 'volc' &&
    referenceAudioIds.length > VOLC_REFERENCE_AUDIO_MAX_COUNT
  ) {
    return {
      status: 'failed',
      reason: `火山语音合成 1.0 最多支持 ${VOLC_REFERENCE_AUDIO_MAX_COUNT} 段参考音频，当前连接了 ${referenceAudioIds.length} 段`
    }
  }

  if (
    effectiveConfig.backend === 'minimax' &&
    referenceAudioIds.length === 0 &&
    profile?.provider === 'volc-speech'
  ) {
    return {
      status: 'failed',
      reason: '火山 speaker ID 不能用作 MiniMax voice_id；请连接 MiniMax 音色设计/克隆结果或填写 MiniMax voice_id'
    }
  }

  // 火山 speaker 在节点参数中填写，MiniMax 音色档案只会进入 MiniMax 请求。
  const voiceId =
    effectiveConfig.backend === 'minimax'
      ? profile?.voice_id ?? config.voiceId.trim()
      : config.voiceId.trim()

  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }

  try {
    const result = await ctx.gateway.speechGenerate({
      projectId: ctx.projectId,
      providerId: option?.provider.id ?? config.providerId,
      modelId: option?.model.id ?? config.modelId,
      text,
      voiceId,
      ...(referenceAudioIds.length ? { referenceAudioIds } : {}),
      config: effectiveConfig
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }

    const asset = result.data.asset
    const subtitle = result.data.subtitle
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: asset.id, mediaPath: asset.path, mime: asset.mime },
          {
            nodeId: ctx.node.id,
            modelKey: option?.key ?? config.modelId,
            prompt: text.slice(0, 80),
            runId: ctx.runId,
            // 溯源只记网关确认「实际发出去」的音色：MiniMax 留空时网关会兜底成系统音色，
            // 节点上的原值是空的；火山留空时服务端用了谁我们不知道，那就宁可不写。
            voiceId: result.data.voiceId
          }
        )
      )
    )
    // 字幕只在本次运行真的产出时存在；没有就清空，避免上一次的字幕继续暴露给下游。
    ctx.updateMeta?.({
      nodeExtra: subtitle ? JSON.stringify({ 'out-subtitle': subtitle }) : undefined
    })
    ctx.emitArtifact?.({
      kind: 'audio',
      mediaId: asset.id,
      mediaPath: asset.path,
      mime: asset.mime,
      portId: 'out-audio',
      title: asset.name || '配音结果'
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `配音异常：${message}` }
  }
}
