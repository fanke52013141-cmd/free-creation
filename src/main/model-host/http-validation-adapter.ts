import type { ModelDefinition, ModelOperation } from '@free-creation/model-contracts'
import type { ProviderAdapter, ProviderValidationFinding, ProviderValidationRequest } from '@free-creation/model-runtime'

type JsonRecord = Record<string, unknown>

const trimUrl = (value: string): string => value.replace(/\/+$/, '')

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
  const body = bodyFor(request.operation, request.model)
  if (!body) return null
  if (request.connection.protocol === 'google') {
    if (request.operation !== 'text.generate') return null
    return {
      url: `${trimUrl(request.connection.baseUrl)}/models/${encodeURIComponent(request.model.modelId)}:generateContent?key=${encodeURIComponent(request.secret)}`,
      body: { contents: [{ parts: [{ text: 'Reply with OK.' }] }] }
    }
  }
  if (request.connection.protocol === 'anthropic' && request.operation === 'text.generate') {
    return { url: `${trimUrl(request.connection.baseUrl)}/v1/messages`, body: { model: request.model.modelId, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] } }
  }
  const path = pathFor(request.operation, request.connection.protocol)
  return path ? { url: `${trimUrl(request.connection.baseUrl)}${path}`, body } : null
}

function responseMessage(status: number, body: string): ProviderValidationFinding {
  let payload: JsonRecord | undefined
  try { payload = JSON.parse(body) as JsonRecord } catch { /* text response is acceptable */ }
  const upstream = payload?.error ?? payload?.message ?? payload?.base_resp
  const detail = typeof upstream === 'string' ? upstream : upstream ? JSON.stringify(upstream).slice(0, 240) : ''
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
    return model.capabilities.some((capability) => capability.operation === operation) && bodyFor(operation, model) !== null
  }

  async validate(request: ProviderValidationRequest): Promise<ProviderValidationFinding> {
    const outgoing = requestFor(request)
    if (!outgoing) return { status: 'unsupported', message: '此能力必须携带用户素材或自定义验证请求，不能用空请求证明可调用', action: '在对应功能中上传素材后执行验证' }
    const response = await fetch(outgoing.url, {
      method: 'POST', headers: authHeaders(request), body: JSON.stringify(outgoing.body), signal: request.signal ?? AbortSignal.timeout(90_000)
    })
    return responseMessage(response.status, await response.text().catch(() => ''))
  }
}
