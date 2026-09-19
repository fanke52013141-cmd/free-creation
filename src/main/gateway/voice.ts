// 音色能力网关（MiniMax）：文件上传 / 快速复刻 / 音色设计。
//
// 与 audio.ts 的分工：audio.ts 只负责「把文本变成音频」，本文件负责「把音色变成
// 可复用的 voice_id」。两者都不在渲染层直连供应商，渲染层只能经 window.api。
import type { VoiceDesignInput, VoiceDesignResult } from '../../shared/contracts'
import type { ProviderConfig } from '../../shared/types'
import { randomUUID } from 'crypto'
import {
  DEFAULT_TTS_CONFIG,
  isValidMiniMaxVoiceId,
  normalizeMiniMaxVoiceId,
  type TtsConfig
} from '../../shared/tts'
import { VOICE_DESIGN_PREVIEW_LIMIT } from '../../shared/voice-design'
import { saveBufferAsset } from '../store/media.repo'
import { getProvider } from './providers.repo'
import { GatewayError } from './factory'
import { describeUpstreamHttpError } from '../../shared/upstream-error'

/**
 * 上游错误统一出口：MiniMax 失败时可能是 JSON 错误体，也可能是网关的 HTML 错误页。
 * 归一化后节点看到的是一句能行动的话，而不是被截断的响应体。
 */
function upstreamError(status: number, body: string, context: string): GatewayError {
  const error = describeUpstreamHttpError(status, body, context)
  return new GatewayError(error.code, error.message)
}

interface MiniMaxEnvelope {
  base_resp?: { status_code?: number; status_msg?: string }
}

function assertMiniMaxOk(payload: MiniMaxEnvelope | null, prefix: string): void {
  const baseResp = payload?.base_resp
  if (baseResp && typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `${prefix}：${baseResp.status_msg || `错误码 ${baseResp.status_code}`}`
    )
  }
}

function requireMiniMax(providerId: string): ProviderConfig {
  const provider = getProvider(providerId)
  if (!provider) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')
  if (provider.specId !== 'minimax') {
    throw new GatewayError('INVALID_INPUT', '音色复刻与音色设计只能选择 MiniMax 供应商')
  }
  return provider
}

/** 上传一个本地文件到 MiniMax，返回 file_id（用于 voice_clone / prompt_audio）。 */
export async function uploadMiniMaxFile(
  provider: ProviderConfig,
  purpose: 'voice_clone' | 'prompt_audio',
  file: { buf: Buffer; mime: string; fileName: string }
): Promise<number> {
  const base = provider.baseURL.replace(/\/+$/, '')
  const form = new FormData()
  form.set('purpose', purpose)
  form.set('file', new Blob([new Uint8Array(file.buf)], { type: file.mime }), file.fileName)

  const res = await fetch(`${base}/v1/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: form
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw upstreamError(res.status, detail, 'MiniMax 上传音频失败')
  }
  const payload = (await res.json().catch(() => null)) as MiniMaxEnvelope & {
    file?: { file_id?: number | string }
  }
  assertMiniMaxOk(payload, 'MiniMax 上传音频失败')
  const fileId = payload?.file?.file_id
  const numeric = typeof fileId === 'string' ? Number(fileId) : fileId
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw new GatewayError('UPSTREAM_ERROR', 'MiniMax 未返回有效的 file_id')
  }
  return numeric
}

export interface CloneVoiceRequest {
  providerId: string
  reference: { buf: Buffer; mime: string; fileName: string }
  /** 可选的克隆提示音及其原文（clone_prompt）。 */
  prompt?: { buf: Buffer; mime: string; fileName: string; text: string } | null
  config: TtsConfig
}

/**
 * MiniMax voice_clone 请求体（纯函数，便于 wire 断言）。
 * clone_prompt 只在真的上传了提示音时才出现——缺了 prompt_text 就是坏数据，
 * 由调用方在执行前拒绝，而不是发一个半成品字段。
 *
 * 这里刻意没有 text_validation：真实接口要的是参考音频原文（字符串），传布尔值
 * 会被 2013 invalid params 挡在登记之前（2026-09-19 用同一 file_id 逐字段实测）。
 */
export function buildVoiceCloneBody(
  fileId: number,
  voiceId: string,
  config: TtsConfig,
  prompt?: { prompt_audio: number; prompt_text: string } | null
): Record<string, unknown> {
  return {
    file_id: fileId,
    voice_id: voiceId,
    model: config.modelId || DEFAULT_TTS_CONFIG.modelId,
    accuracy: config.accuracy,
    need_noise_reduction: config.needNoiseReduction,
    need_volume_normalization: config.needVolumeNormalization,
    aigc_watermark: config.aigcWatermark,
    ...(config.languageBoost ? { language_boost: config.languageBoost } : {}),
    ...(prompt ? { clone_prompt: prompt } : {})
  }
}

/** MiniMax voice_design 请求体（纯函数）：只发送文档化的四个字段。 */
export function buildVoiceDesignBody(
  prompt: string,
  previewText: string,
  voiceId: string,
  aigcWatermark: boolean
): Record<string, unknown> {
  return {
    prompt,
    preview_text: previewText,
    ...(voiceId ? { voice_id: voiceId } : {}),
    aigc_watermark: aigcWatermark
  }
}

/**
 * MiniMax 快速复刻：登记一个 voice_id 并返回它。
 * 只登记音色，不产生音频产物——产物由 T2A 合成链路负责，保持「音色」与「音频」
 * 两种输出的语义不被混为一谈。
 */
export async function cloneMiniMaxVoice(request: CloneVoiceRequest): Promise<string> {
  const provider = requireMiniMax(request.providerId)
  const config = request.config
  const base = provider.baseURL.replace(/\/+$/, '')

  const fileId = await uploadMiniMaxFile(provider, 'voice_clone', request.reference)

  let promptPayload: { prompt_audio: number; prompt_text: string } | undefined
  if (request.prompt) {
    if (!request.prompt.text.trim()) {
      throw new GatewayError('INVALID_INPUT', '填写克隆提示音后必须同时提供其原文')
    }
    const promptAudioId = await uploadMiniMaxFile(provider, 'prompt_audio', request.prompt)
    promptPayload = { prompt_audio: promptAudioId, prompt_text: request.prompt.text.trim() }
  }

  const requested = config.voiceId.trim()
  if (requested && !isValidMiniMaxVoiceId(requested)) {
    throw new GatewayError(
      'INVALID_INPUT',
      '自定义 Voice ID 需 8～256 位、以字母开头、只含字母数字与 - _、且末位不能是 - 或 _'
    )
  }
  const voiceId = normalizeMiniMaxVoiceId(requested) || `canvas-voice-${randomSuffix()}`

  const res = await fetch(`${base}/v1/voice_clone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildVoiceCloneBody(fileId, voiceId, config, promptPayload))
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw upstreamError(res.status, detail, 'MiniMax 创建克隆音色失败')
  }
  // 2026-09-19 真跑回执：成功登记时是
  // {"input_sensitive":false,"input_sensitive_type":0,"demo_audio":"","base_resp":{"status_code":0,…}}
  // base_resp 为 0 但 input_sensitive 为真时音色并不存在，必须在这里停下，
  // 否则下游拿着一个没登记的 voice_id 去合成，只会收到一句看不懂的 upstream 报错。
  const payload = (await res.json().catch(() => null)) as MiniMaxEnvelope & {
    input_sensitive?: boolean
  }
  assertMiniMaxOk(payload, 'MiniMax 创建克隆音色失败')
  if (payload?.input_sensitive === true) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      'MiniMax 判定参考音频内容敏感，没有登记这个音色；请换一段干净的录音'
    )
  }
  return voiceId
}

/**
 * MiniMax 音色设计：用一段文字描述凭空设计音色。
 * 返回的 trial_audio 是 hex 编码的试听音频，必须解码后落盘成真实音频资产——
 * 否则下游拿到的是一个无法播放的字符串。
 */
export async function designMiniMaxVoice(input: VoiceDesignInput): Promise<VoiceDesignResult> {
  const prompt = input.prompt?.trim()
  if (!prompt) throw new GatewayError('INVALID_INPUT', '音色描述不能为空')

  const provider = requireMiniMax(input.providerId)
  const base = provider.baseURL.replace(/\/+$/, '')
  const config = input.config
  const previewText = config.previewText.slice(0, VOICE_DESIGN_PREVIEW_LIMIT)

  const requested = config.voiceId.trim()
  if (requested && !isValidMiniMaxVoiceId(requested)) {
    throw new GatewayError(
      'INVALID_INPUT',
      '自定义 Voice ID 需 8～256 位、以字母开头、只含字母数字与 - _、且末位不能是 - 或 _'
    )
  }

  const res = await fetch(`${base}/v1/voice_design`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildVoiceDesignBody(prompt, previewText, requested, config.aigcWatermark))
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw upstreamError(res.status, detail, 'MiniMax 音色设计失败')
  }
  const payload = (await res.json().catch(() => null)) as MiniMaxEnvelope & {
    voice_id?: string
    trial_audio?: string
  }
  assertMiniMaxOk(payload, 'MiniMax 音色设计失败')

  const voiceId = typeof payload?.voice_id === 'string' ? payload.voice_id.trim() : ''
  if (!voiceId) throw new GatewayError('EMPTY_RESULT', 'MiniMax 未返回设计出的 voice_id')
  const hex = payload?.trial_audio
  if (!hex) throw new GatewayError('EMPTY_RESULT', 'MiniMax 未返回试听音频')

  const buf = Buffer.from(hex, 'hex')
  if (!buf.length) throw new GatewayError('EMPTY_RESULT', 'MiniMax 返回的试听音频数据无效')

  const asset = await saveBufferAsset(input.projectId, buf, '.mp3', `音色试听-${voiceId}`)
  return { asset, voiceId }
}

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 20)
}
