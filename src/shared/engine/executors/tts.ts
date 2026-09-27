// TTS 语音复刻节点执行器：本地 ComfyUI IndexTTS-2.5 或 MiniMax 快速复刻。
import { inputMedia, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from '../helpers'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import { parseTtsConfig } from '@shared/tts'
import {
  featureKeyOf,
  resolveFeatureOptionDetailed,
  type FeatureOptionResolution
} from '../models'

export const ttsExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const trace = ctx.trace ?? (() => undefined)
  trace('execution', 'info', '语音克隆节点开始执行')
  const config = parseTtsConfig(readNodeConfig(ctx.shape))
  if (config.backend !== 'minimax') {
    trace('execution', 'error', `不支持当前语音克隆后端：${config.backend}`)
    return {
      status: 'skipped',
      reason: '语音克隆已统一使用 MiniMax；请在节点内切换旧的本地 IndexTTS 配置',
      diagnosticPhase: 'execution'
    }
  }
  // 固定参数归 config，用户正文归 props.text；这与节点契约和保存模型一致。
  const text = mergedPrompt(ctx.shape.props.text, inputText(ctx.inputs, 'in-text')).trim()
  if (!text) {
    trace('input', 'error', '输入校验失败：朗读文本为空')
    return { status: 'skipped', reason: '无朗读文本', diagnosticPhase: 'input' }
  }

  // 优先使用上游连接传入的参考音频；否则从节点配置中手动上传的参考音频获取。
  const refAudio = inputMedia(ctx.inputs, 'in-audio', 'audio')[0]
  const referenceAudioId = refAudio?.mediaId ?? config.refMediaId
  if (!referenceAudioId) {
    trace('input', 'error', '输入校验失败：未找到连接或配置的参考音频')
    return { status: 'skipped', reason: '缺少参考语音', diagnosticPhase: 'input' }
  }
  trace(
    'input',
    'info',
    `输入校验通过：参考音频来自${refAudio ? '上游连接' : '节点配置'}，文本 ${text.length} 个字符`
  )

  const effectiveConfig = { ...config }
  if (config.backend === 'minimax') {
    const featureKey = featureKeyOf(config, 'voice.clone')
    trace(
      'capability',
      'info',
      `开始解析模型能力：${featureKey} / voice.clone；当前已加载 ${ctx.providers.length} 个供应商`
    )
    let resolution: FeatureOptionResolution
    try {
      resolution = await resolveFeatureOptionDetailed(
        ctx.gateway,
        ctx.providers,
        featureKey,
        'voice.clone',
        config.providerId && config.modelId ? `${config.providerId}::${config.modelId}` : undefined
      )
    } catch (error) {
      const reason = `语音克隆模型能力查询失败：${error instanceof Error ? error.message : String(error)}`
      trace('capability', 'error', reason)
      return { status: 'failed', reason, diagnosticPhase: 'capability' }
    }
    const option = resolution.option
    if (!option) {
      const reason = `无法解析可执行的 voice.clone 模型：${resolution.reason ?? `已加载 ${ctx.providers.length} 个供应商；请检查能力绑定、验证状态及供应商列表`}`
      trace('capability', 'error', reason)
      return { status: 'skipped', reason, diagnosticPhase: 'capability' }
    }
    effectiveConfig.providerId = option.provider.id
    effectiveConfig.modelId = option.model.id
    ctx.setDiagnosticTarget?.({
      operation: 'voice.clone',
      featureKey,
      providerId: option.provider.id,
      providerName: option.provider.name,
      modelId: option.model.id,
      modelName: option.model.name || option.model.id
    })
    trace(
      'capability',
      'info',
      `能力解析通过：${option.provider.name} / ${option.model.name || option.model.id}`
    )
  }

  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }

  try {
    const requestStartedAt = Date.now()
    trace(
      'request',
      'info',
      `开始调用语音克隆服务；参考音频已就绪，文本 ${text.length} 个字符`
    )
    const result = await ctx.gateway.ttsGenerate({
      projectId: ctx.projectId,
      runId: ctx.runId,
      nodeId: ctx.node.id,
      referenceAudioId,
      text,
      config: effectiveConfig
    })
    const requestDurationMs = Date.now() - requestStartedAt
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) {
      trace('request', 'error', `语音克隆请求失败（${requestDurationMs} ms）：${result.error.message}`)
      return { status: 'failed', reason: result.error.message, diagnosticPhase: 'request' }
    }

    const { asset, voiceId } = result.data
    trace('result', 'info', `语音克隆请求成功（${requestDurationMs} ms）；产物格式 ${asset.mime}`)
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
    trace('request', 'error', `语音克隆调用异常：${message}`)
    return { status: 'failed', reason: `语音复刻异常：${message}`, diagnosticPhase: 'request' }
  }
}
