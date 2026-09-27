// MiniMax 云端语音复刻节点执行器。
import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { MINIMAX_VOICE_CLONE_MODELS, parseTtsConfig } from '@shared/tts'

export const ttsExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const trace = ctx.trace ?? (() => undefined)
  trace('execution', 'info', '语音克隆节点开始执行')
  const config = parseTtsConfig(readNodeConfig(ctx.shape))
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
    `输入校验通过：参考音频来自${refAudio ? '上游连接' : '节点配置'}`
  )

  const effectiveConfig = { ...config }
  const candidates = ctx.providers
    .filter((provider) => provider.specId === 'minimax')
    .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
    .filter(({ model }) => model.modality === 'audio' && MINIMAX_VOICE_CLONE_MODELS.includes(model.id))
  const option = candidates.find(({ provider, model }) =>
      provider.id === config.providerId &&
      model.id === config.modelId
    ) ?? (!config.providerId ? candidates[0] : undefined)
  if (!option) {
    const reason = '当前 MiniMax 语音模型不可用，请在节点中重新选择已配置的模型'
    trace('capability', 'error', reason)
    return { status: 'skipped', reason, diagnosticPhase: 'capability' }
  }
  if (option.provider.hasApiKey === false) {
    const reason = 'MiniMax API Key 未保存或无法解密，请到模型管理中重新填写'
    trace('capability', 'error', reason)
    return { status: 'skipped', reason, diagnosticPhase: 'capability' }
  }
  effectiveConfig.providerId = option.provider.id
  effectiveConfig.modelId = option.model.id
  ctx.setDiagnosticTarget?.({
    operation: 'voice.clone',
    featureKey: 'voice.clone',
    providerId: option.provider.id,
    providerName: option.provider.name,
    modelId: option.model.id,
    modelName: option.model.name || option.model.id
  })
  trace('capability', 'info', `使用 MiniMax 模型：${option.provider.name} / ${option.model.id}`)

  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }

  try {
    const requestStartedAt = Date.now()
    trace(
      'request',
      'info',
      '开始调用语音克隆服务；参考音频已就绪'
    )
    const result = await ctx.gateway.ttsGenerate({
      projectId: ctx.projectId,
      runId: ctx.runId,
      nodeId: ctx.node.id,
      referenceAudioId,
      config: effectiveConfig
    })
    const requestDurationMs = Date.now() - requestStartedAt
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) {
      trace('request', 'error', `语音克隆请求失败（${requestDurationMs} ms）：${result.error.message}`)
      return { status: 'failed', reason: result.error.message, diagnosticPhase: 'request' }
    }

    const { voiceId } = result.data
    if (!voiceId) return { status: 'failed', reason: 'MiniMax 未返回音色 ID', diagnosticPhase: 'request' }
    trace('result', 'info', `语音克隆请求成功（${requestDurationMs} ms）；音色 ID 已登记`)
    // 复刻出的音色本身是可复用结果：以结构化音色档案暴露给下游配音节点。
    ctx.updateMeta?.({
      nodeExtra: JSON.stringify({
            'out-json': {
              voice_id: voiceId,
              provider: 'minimax',
              source: 'voice_clone',
              label: effectiveConfig.voiceId.trim() || voiceId,
            }
          })
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    trace('request', 'error', `语音克隆调用异常：${message}`)
    return { status: 'failed', reason: `语音复刻异常：${message}`, diagnosticPhase: 'request' }
  }
}
