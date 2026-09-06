// 音频生成（TTS）：按供应商协议分派
//   specId === 'minimax' → MiniMax T2A v2（POST {base}/v1/t2a_v2，返回 hex 音频）
//   其余 → OpenAI 兼容 /audio/speech（OpenAI TTS、中转站等）
// 产物 Buffer 走 media 管线入库，节点侧拿到 MediaAsset 即可播放。
// TokenDance 等网关以 /gateway/minimax 前缀转发原生 MiniMax 协议，路径结构一致。
import type { AudioGenerateInput } from '../../shared/contracts'
import type { MediaAsset, ProviderConfig } from '../../shared/types'
import { saveBufferAsset } from '../store/media.repo'
import { getDb } from '../store/db'
import { getProvider } from './providers.repo'
import { GatewayError } from './factory'

const EXT_BY_FORMAT: Record<string, string> = {
  mp3: '.mp3',
  opus: '.opus',
  aac: '.aac',
  flac: '.flac',
  wav: '.wav',
  pcm: '.pcm'
}

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm'
}

/** MiniMax T2A v2 只接受 mp3/pcm/flac；其余请求格式回落 mp3。 */
const MINIMAX_FORMATS = new Set(['mp3', 'pcm', 'flac'])

/** 配音节点默认音色是 OpenAI 命名（alloy 等），MiniMax 端没有这些音色，映射到系统音色。 */
const OPENAI_DEFAULT_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
const MINIMAX_DEFAULT_VOICE = 'male-qn-qingse'

export async function generateAudioToAsset(input: AudioGenerateInput): Promise<MediaAsset> {
  if (!input.text?.trim()) throw new GatewayError('INVALID_INPUT', '朗读文本不能为空')

  const p = getProvider(input.providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')

  if (p.specId === 'minimax') return generateViaMiniMax(p, input)
  return generateViaOpenAICompatible(p, input)
}

/** MiniMax T2A v2：同步返回完整音频，data.audio 为 hex 编码。 */
async function generateViaMiniMax(
  p: ProviderConfig,
  input: AudioGenerateInput
): Promise<MediaAsset> {
  const requestedFormat = input.format || 'mp3'
  const format = MINIMAX_FORMATS.has(requestedFormat) ? requestedFormat : 'mp3'
  const voiceId =
    input.voice && !OPENAI_DEFAULT_VOICES.has(input.voice) ? input.voice : MINIMAX_DEFAULT_VOICE

  const res = await fetch(`${p.baseURL.replace(/\/+$/, '')}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${p.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: input.modelId,
      text: input.text.trim(),
      stream: false,
      voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 }
    })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`
    )
  }
  const payload = (await res.json().catch(() => null)) as {
    data?: { audio?: string }
    base_resp?: { status_code?: number; status_msg?: string }
  } | null
  const baseResp = payload?.base_resp
  if (baseResp && typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `MiniMax TTS 错误 ${baseResp.status_code}：${baseResp.status_msg || '未知错误'}`
    )
  }
  const hex = payload?.data?.audio
  if (!hex) throw new GatewayError('EMPTY_RESULT', 'TTS 未返回音频数据')
  const buf = Buffer.from(hex, 'hex')
  if (!buf.length) throw new GatewayError('EMPTY_RESULT', 'TTS 音频数据无效')

  return saveAudioAsset(input.projectId, buf, format, input.text.trim())
}

/** OpenAI 兼容 /audio/speech 端点。 */
async function generateViaOpenAICompatible(
  p: ProviderConfig,
  input: AudioGenerateInput
): Promise<MediaAsset> {
  const format = input.format || 'mp3'
  const voice = input.voice || 'alloy'

  const res = await fetch(`${p.baseURL.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${p.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: input.modelId,
      input: input.text.trim(),
      voice,
      response_format: format
    })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`
    )
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new GatewayError('EMPTY_RESULT', 'TTS 未返回音频数据')

  return saveAudioAsset(input.projectId, buf, format, input.text.trim())
}

async function saveAudioAsset(
  projectId: string,
  buf: Buffer,
  format: string,
  label: string
): Promise<MediaAsset> {
  const ext = EXT_BY_FORMAT[format] ?? '.mp3'
  const asset = await saveBufferAsset(projectId, buf, ext, label)

  // 补全 mime：saveBufferAsset 可能根据 ext 推断了 mime，此处强制修正
  const mime = MIME_BY_FORMAT[format] ?? 'audio/mpeg'
  if (asset.mime !== mime) {
    const db = getDb()
    db.prepare('UPDATE media SET mime = ? WHERE id = ?').run(mime, asset.id)
    asset.mime = mime
  }
  return asset
}
