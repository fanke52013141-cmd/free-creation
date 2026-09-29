import type { ModelDefinition, ModelOperation } from '@free-creation/model-contracts'
import type { ProviderAdapter, ProviderValidationFinding, ProviderValidationRequest } from '@free-creation/model-runtime'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SPEECH_CONFIG } from '../../shared/speech'
import { DEFAULT_TTS_CONFIG, MINIMAX_CLONE_MAX_BYTES, MINIMAX_VOICE_CLONE_MODELS } from '../../shared/tts'
import type { ProviderConfig } from '../../shared/types'
import { buildMiniMaxAsyncTtsBody, generateMiniMaxAsyncAudioBuffer } from '../gateway/audio'
import { buildVoiceCloneBody } from '../gateway/voice'

type JsonRecord = Record<string, unknown>

const trimUrl = (value: string): string => value.replace(/\/+$/, '')

// Small, opaque, solid-red PNG. A successful HTTP status alone cannot prove image understanding.
const VISION_PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAvSURBVFiF7c4xAQAwDIAwNv+eWxl9ggHypqbD/uUcAAAAAAAAAAAAAAAAAACgagEw4wI+0ujnJgAAAABJRU5ErkJggg=='
const VISION_PROBE_QUESTION = 'What is the main color of this image? Reply with only the English color name.'

function wantsImageInput(model: ModelDefinition, operation: ModelOperation): boolean {
  return operation === 'text.generate' && model.capabilities.some((capability) =>
    capability.operation === operation && capability.acceptedAssetKinds.includes('image')
  )
}

function authHeaders(request: ProviderValidationRequest): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...request.connection.headers }
  // Native Volcengine TTS uses a different scheme; all other supported providers accept Bearer.
  if (request.connection.protocol === 'google') return headers
  headers[request.connection.protocol === 'volcengine' ? 'X-Api-Key' : request.connection.protocol === 'anthropic' ? 'x-api-key' : 'Authorization'] =
    request.connection.protocol === 'volcengine' ? request.secret : `Bearer ${request.secret}`
  if (request.connection.protocol === 'anthropic') {
    headers['x-api-key'] = request.secret
    headers['anthropic-version'] ??= '2023-06-01'
  }
  return headers
}

function bodyFor(operation: ModelOperation, model: ModelDefinition): JsonRecord | null {
  switch (operation) {
    case 'text.generate':
      return { model: model.modelId, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 }
    case 'text.embed':
      return { model: model.modelId, input: 'validation' }
    case 'image.generate':
      return { model: model.modelId, prompt: 'A single blue dot on a white background.', n: 1 }
    case 'video.generate':
      return { model: model.modelId, prompt: 'A one-second plain blue screen.' }
    case 'speech.synthesize':
      return { model: model.modelId, input: '验证', voice: 'default', text: '验证' }
    case 'voice.design':
      return { prompt: '中性、清晰的普通话播音员。', preview_text: '这是一次模型调用验证。' }
    // Clone/transcribe require a user-owned media input. Treating an empty request as a proof
    // would be dishonest, so the UI must validate these with a supplied asset in the feature flow.
    case 'voice.clone':
    case 'speech.transcribe':
      return null
    default:
      return null
  }
}

function pathFor(operation: ModelOperation, protocol: string): string | null {
  if (protocol === 'minimax') {
    if (operation === 'text.generate') return '/v1/text/chatcompletion_v2'
    if (operation === 'video.generate') return '/v2/video_generation'
    if (operation === 'speech.synthesize') return '/v1/t2a_async_v2'
    if (operation === 'voice.design') return '/v1/voice_design'
    return null
  }
  if (protocol === 'volcengine' && operation === 'speech.synthesize') return '/api/v3/tts/create'
  if (protocol === 'anthropic' && operation === 'text.generate') return '/v1/messages'
  if (protocol === 'toapis' && (operation === 'image.generate' || operation === 'image.edit')) return '/images/generations'
  switch (operation) {
    case 'text.generate': return '/chat/completions'
    case 'text.embed': return '/embeddings'
    case 'image.generate': return '/images/generations'
    case 'speech.synthesize': return '/audio/speech'
    default: return null
  }
}

function requestFor(request: ProviderValidationRequest): { url: string; body: JsonRecord } | null {
  const vision = wantsImageInput(request.model, request.operation)
  // The desktop chat gateway currently sends OpenAI-compatible messages. Do not certify a
  // native protocol's vision route until its normal execution route accepts the same payload.
  if (vision && !['openai', 'openai-compatible', 'openrouter', 'custom'].includes(request.connection.protocol)) return null
  if (request.connection.protocol === 'minimax' && request.operation === 'speech.synthesize') {
    const config = { ...DEFAULT_SPEECH_CONFIG, modelId: request.model.modelId }
    return {
      url: `${trimUrl(request.connection.baseUrl)}/v1/t2a_async_v2`,
      body: buildMiniMaxAsyncTtsBody(
        { modelId: request.model.modelId, text: '这是一次模型验证。', voiceId: '' },
        config
      )
    }
  }
  const body = bodyFor(request.operation, request.model)
  if (!body) return null
  if (request.connection.protocol === 'google') {
    if (request.operation !== 'text.generate') return null
    return {
      url: `${trimUrl(request.connection.baseUrl)}/models/${encodeURIComponent(request.model.modelId)}:generateContent?key=${encodeURIComponent(request.secret)}`,
      body: { contents: [{ parts: vision ? [{ text: VISION_PROBE_QUESTION }, { inlineData: { mimeType: 'image/png', data: VISION_PROBE_PNG } }] : [{ text: 'Reply with OK.' }] }] }
    }
  }
  if (request.connection.protocol === 'anthropic' && request.operation === 'text.generate') {
    return { url: `${trimUrl(request.connection.baseUrl)}/v1/messages`, body: { model: request.model.modelId, max_tokens: vision ? 32 : 1, messages: [{ role: 'user', content: vision ? [{ type: 'text', text: VISION_PROBE_QUESTION }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: VISION_PROBE_PNG } }] : 'Reply with OK.' }] } }
  }
  const path = pathFor(request.operation, request.connection.protocol)
  if (vision && path) {
    return { url: `${trimUrl(request.connection.baseUrl)}${path}`, body: { model: request.model.modelId, messages: [{ role: 'user', content: [{ type: 'text', text: VISION_PROBE_QUESTION }, { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_PROBE_PNG}` } }] }], max_tokens: 32 } }
  }
  return path ? { url: `${trimUrl(request.connection.baseUrl)}${path}`, body } : null
}

function responseText(body: string, protocol: string): string {
  let payload: JsonRecord
  try { payload = JSON.parse(body) as JsonRecord } catch { return '' }
  if (protocol === 'google') {
    const candidate = (payload.candidates as JsonRecord[] | undefined)?.[0]
    const content = candidate?.content as JsonRecord | undefined
    return ((content?.parts as JsonRecord[] | undefined) ?? []).map((part) => part.text).filter((part): part is string => typeof part === 'string').join(' ')
  }
  if (protocol === 'anthropic') {
    return ((payload.content as JsonRecord[] | undefined) ?? []).map((part) => part.text).filter((part): part is string => typeof part === 'string').join(' ')
  }
  const choice = (payload.choices as JsonRecord[] | undefined)?.[0]
  const content = (choice?.message as JsonRecord | undefined)?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((part: JsonRecord) => part.text).filter((part: unknown): part is string => typeof part === 'string').join(' ') : ''
}

function responseMessage(status: number, body: string): ProviderValidationFinding {
  let payload: JsonRecord | undefined
  try { payload = JSON.parse(body) as JsonRecord } catch { /* text response is acceptable */ }
  const upstream = payload?.error ?? payload?.message ?? payload?.base_resp
  const detail = typeof upstream === 'string' ? upstream : upstream ? JSON.stringify(upstream).slice(0, 240) : ''
  const baseResp = payload?.base_resp
  if (typeof baseResp === 'object' && baseResp !== null) {
    const code = (baseResp as JsonRecord).status_code
    const message = (baseResp as JsonRecord).status_msg
    if (typeof code === 'number' && code !== 0) {
      const reason = typeof message === 'string' && message.trim() ? message : `错误码 ${code}`
      return {
        status: 'failed',
        message: `MiniMax 返回业务错误（${reason}）`,
        action: code === 1004 ? '检查 MiniMax API Key 和账号调用权限' : '检查模型 ID、账号权限和请求参数'
      }
    }
  }
  if (status >= 200 && status < 300) return { status: 'verified', message: '上游已受理该模型的实际验证请求' }
  if (status === 401 || status === 403) return { status: 'failed', message: `鉴权或模型权限被拒绝（HTTP ${status}${detail ? `：${detail}` : ''}）`, action: '检查 API Key 和该模型的调用权限' }
  if (status === 404) return { status: 'failed', message: '验证端点不存在（HTTP 404）', action: '检查 Base URL、协议类型或为自定义协议配置验证端点' }
  return { status: 'failed', message: `上游拒绝验证请求（HTTP ${status}${detail ? `：${detail}` : ''}）`, action: '检查模型 ID、请求能力和供应商参数' }
}

/**
 * A deliberately small HTTP adapter for documented OpenAI-style, ToAPIs, MiniMax and Volcengine
 * routes. A 2xx response is the only success condition: a model is never marked verified merely
 * because its connection or API key happened to respond.
 */
export class HttpValidationAdapter implements ProviderAdapter {
  readonly id = 'http'

  supports(operation: ModelOperation, model: ModelDefinition): boolean {
    const declared = model.capabilities.some((capability) => capability.operation === operation)
    if (operation === 'voice.clone') return declared
    return declared && bodyFor(operation, model) !== null
  }

  async validate(request: ProviderValidationRequest): Promise<ProviderValidationFinding> {
    if (request.operation === 'voice.clone') return validateMiniMaxVoiceClone(request)
    if (wantsImageInput(request.model, request.operation) && !['openai', 'openai-compatible', 'openrouter', 'custom'].includes(request.connection.protocol)) {
      return { status: 'unsupported', message: '当前桌面调用链尚未支持此连接协议的识图请求', action: '使用已验证的 OpenAI 兼容连接，或先实现该协议的正式调用适配' }
    }
    const outgoing = requestFor(request)
    if (!outgoing) return { status: 'unsupported', message: '此能力必须携带用户素材或自定义验证请求，不能用空请求证明可调用', action: '在对应功能中上传素材后执行验证' }
    const response = await fetch(outgoing.url, {
      method: 'POST', headers: authHeaders(request), body: JSON.stringify(outgoing.body), signal: request.signal ?? AbortSignal.timeout(90_000)
    })
    const body = await response.text().catch(() => '')
    const finding = responseMessage(response.status, body)
    if (finding.status !== 'verified' || !wantsImageInput(request.model, request.operation)) return finding
    const answer = responseText(body, request.connection.protocol)
    return /\bred\b|红/iu.test(answer)
      ? { status: 'verified', message: '模型已正确识别测试图片，并返回文本' }
      : { status: 'failed', message: '图片请求已返回，但模型未正确识别测试图片', action: '检查模型是否支持图片输入及当前连接的多模态请求格式' }
  }
}

const CLONE_VALIDATION_TEXT =
  '这是一段用于 MiniMax 语音克隆连接验收的系统测试语音。系统会临时合成这段普通话，再上传并登记测试音色，用来确认当前模型的语音生成和克隆接口可以正常使用。这里不包含真人录音，也不会把测试音频保存到本地项目。'

function parseJsonRecord(body: string): JsonRecord | null {
  try {
    const value = JSON.parse(body) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as JsonRecord)
      : null
  } catch {
    return null
  }
}

function safeFinding(finding: ProviderValidationFinding, secret: string): ProviderValidationFinding {
  return secret ? { ...finding, message: finding.message.replaceAll(secret, '***') } : finding
}

function stageFinding(
  finding: ProviderValidationFinding,
  stage: string,
  secret: string
): ProviderValidationFinding {
  return safeFinding({ ...finding, message: `${stage}：${finding.message}` }, secret)
}

async function validateMiniMaxVoiceClone(
  request: ProviderValidationRequest
): Promise<ProviderValidationFinding> {
  try {
    return await runMiniMaxVoiceCloneValidation(request)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return safeFinding(
      {
        status: 'failed',
        message: `语音克隆端到端验证失败：${detail}`,
        action: '检查 MiniMax API Key、账号权限和网络后重试'
      },
      request.secret
    )
  }
}

async function runMiniMaxVoiceCloneValidation(
  request: ProviderValidationRequest
): Promise<ProviderValidationFinding> {
  if (request.connection.protocol !== 'minimax') {
    return {
      status: 'unsupported',
      message: '语音克隆端到端验证目前要求 MiniMax 原生协议',
      action: '将连接类型设为 MiniMax 后重试'
    }
  }
  if (!MINIMAX_VOICE_CLONE_MODELS.includes(request.model.modelId)) {
    return {
      status: 'unsupported',
      message: `MiniMax 语音克隆不支持模型 ${request.model.modelId}`,
      action: '选择 speech-2.8-hd、speech-2.8-turbo、speech-2.6-hd、speech-2.6-turbo、speech-02-hd、speech-02-turbo、speech-01-hd 或 speech-01-turbo'
    }
  }

  const base = trimUrl(request.connection.baseUrl)
  const provider: ProviderConfig = {
    id: request.connection.id,
    name: request.connection.name,
    specId: 'minimax',
    baseURL: request.connection.baseUrl,
    apiKey: request.secret,
    models: [{ id: request.model.modelId, modality: 'audio' }],
    createdAt: Date.now()
  }
  const headers = {
    ...request.connection.headers,
    Authorization: `Bearer ${request.secret}`,
    'Content-Type': 'application/json'
  }
  const fetchSignal = (): AbortSignal => request.signal ?? AbortSignal.timeout(120_000)
  const synthesized = await generateMiniMaxAsyncAudioBuffer(provider, {
    modelId: request.model.modelId,
    text: CLONE_VALIDATION_TEXT,
    voiceId: 'male-qn-qingse',
    config: {
      ...DEFAULT_SPEECH_CONFIG,
      providerId: request.connection.id,
      modelId: request.model.modelId,
      format: 'mp3'
    }
  })
  const audio = synthesized.audio
  if (!audio.length || audio.length > MINIMAX_CLONE_MAX_BYTES) {
    return {
      status: 'failed',
      message: '合成临时测试语音失败：返回音频为空或超过 20 MB',
      action: '检查 MiniMax 模型和服务商返回的音频格式'
    }
  }

  const form = new FormData()
  form.set('purpose', 'voice_clone')
  form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'canvas-clone-validation.mp3')
  const uploadHeaders = { ...request.connection.headers, Authorization: `Bearer ${request.secret}` }
  delete uploadHeaders['Content-Type']
  const uploadResponse = await fetch(`${base}/v1/files/upload`, {
    method: 'POST',
    headers: uploadHeaders,
    body: form,
    signal: fetchSignal()
  })
  const uploadBody = await uploadResponse.text().catch(() => '')
  const uploadFinding = responseMessage(uploadResponse.status, uploadBody)
  if (uploadFinding.status !== 'verified') {
    return stageFinding(uploadFinding, '上传临时测试语音失败', request.secret)
  }
  const uploadedFile = parseJsonRecord(uploadBody)?.file
  const rawFileId =
    typeof uploadedFile === 'object' && uploadedFile !== null
      ? (uploadedFile as JsonRecord).file_id
      : undefined
  const fileId = typeof rawFileId === 'string' ? Number(rawFileId) : rawFileId
  if (typeof fileId !== 'number' || !Number.isSafeInteger(fileId) || fileId <= 0) {
    return {
      status: 'failed',
      message: '上传临时测试语音失败：MiniMax 未返回有效的 file_id',
      action: '检查 MiniMax 文件上传权限和服务商响应'
    }
  }

  const voiceId = `canvas-check-${randomUUID()}`
  const cloneConfig = { ...DEFAULT_TTS_CONFIG, modelId: request.model.modelId }
  const cloneResponse = await fetch(`${base}/v1/voice_clone`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildVoiceCloneBody(fileId, voiceId, cloneConfig)),
    signal: fetchSignal()
  })
  const cloneBody = await cloneResponse.text().catch(() => '')
  const cloneFinding = responseMessage(cloneResponse.status, cloneBody)
  if (cloneFinding.status !== 'verified') {
    return stageFinding(cloneFinding, 'MiniMax 语音克隆失败', request.secret)
  }
  const clonePayload = parseJsonRecord(cloneBody)
  const cloneBaseResp = clonePayload?.base_resp
  if (
    typeof cloneBaseResp !== 'object' ||
    cloneBaseResp === null ||
    (cloneBaseResp as JsonRecord).status_code !== 0
  ) {
    return {
      status: 'failed',
      message: 'MiniMax 语音克隆失败：服务端未返回成功登记回执',
      action: '检查 MiniMax 账号的语音克隆权限和服务商响应'
    }
  }
  if (clonePayload?.input_sensitive === true) {
    return {
      status: 'failed',
      message: 'MiniMax 拒绝登记测试音色：测试语音被判定为敏感内容',
      action: '稍后重试；测试语音不会保存到本地'
    }
  }
  const clonedSpeech = await generateMiniMaxAsyncAudioBuffer(provider, {
    modelId: request.model.modelId,
    text: 'MiniMax 语音克隆验证成功。',
    voiceId,
    config: {
      ...DEFAULT_SPEECH_CONFIG,
      providerId: request.connection.id,
      modelId: request.model.modelId,
      format: 'mp3'
    }
  })
  if (!clonedSpeech.audio.length) {
    return {
      status: 'failed',
      message: '克隆音色已登记，但后续语音合成没有返回音频',
      action: '检查 MiniMax 异步语音合成权限和模型设置'
    }
  }

  return {
    status: 'verified',
    message: '端到端验证通过：已合成测试语音、登记临时音色，并用该音色完成后续合成'
  }
}
