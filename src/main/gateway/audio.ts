// 音频生成（TTS）：调用 OpenAI 兼容的 /audio/speech 端点
// 支持 OpenAI TTS、阿里云、智谱等兼容供应商
// 产物 Buffer 走 media 管线入库，节点侧拿到 MediaAsset 即可播放
import type { AudioGenerateInput } from '../../shared/contracts'
import type { MediaAsset } from '../../shared/types'
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

export async function generateAudioToAsset(input: AudioGenerateInput): Promise<MediaAsset> {
  if (!input.text?.trim()) throw new GatewayError('INVALID_INPUT', '朗读文本不能为空')

  const p = getProvider(input.providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')

  const format = input.format || 'mp3'
  const voice = input.voice || 'alloy'

  // 调用 /audio/speech 端点（OpenAI TTS 兼容）
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

  const ext = EXT_BY_FORMAT[format] ?? '.mp3'
  const asset = await saveBufferAsset(input.projectId, buf, ext, input.text.trim().slice(0, 24))

  // 补全 mime
  const mime = MIME_BY_FORMAT[format] ?? 'audio/mpeg'
  if (asset.mime !== mime) {
    // saveBufferAsset 可能根据 ext 推断了 mime，此处强制修正
    const db = getDb()
    db.prepare('UPDATE media SET mime = ? WHERE id = ?').run(mime, asset.id)
    asset.mime = mime
  }

  return asset
}
