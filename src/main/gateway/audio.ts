// 音频生成（TTS）：按供应商协议分派
//   specId === 'minimax' → MiniMax T2A v2（POST {base}/v1/t2a_v2，返回 hex 音频）
//   其余 → OpenAI 兼容 /audio/speech（OpenAI TTS、中转站等）
// 产物 Buffer 走 media 管线入库，节点侧拿到 MediaAsset 即可播放。
// TokenDance 等网关以 /gateway/minimax 前缀转发原生 MiniMax 协议，路径结构一致。
//
// 配音（speech）节点是「模型驱动」的：由 config.backend 明确选择协议，而不是
// 按上游节点类型猜测。各条协议各自只发送自己文档化的字段：
//   minimax → POST {base}/v1/t2a_async_v2（异步任务 + 文件检索下载，默认主通道）
//   doubao  → POST {base}/api/v3/tts/create（seed-audio-1.0，可返回字幕时间轴）
//   volc    → POST {base}/api/v1/tts（火山引擎语音合成 1.0，非流式，data 为 Base64）
//   openai  → POST {base}/audio/speech（保留的旧通道）
import { randomUUID } from 'node:crypto'
import type {
  AudioGenerateInput,
  SpeechGenerateInput,
  SpeechGenerateResult,
  SpeechSubtitle
} from '../../shared/contracts'
import type { MediaAsset, ProviderConfig } from '../../shared/types'
import { SPEECH_TEXT_LIMITS, parsePronunciationTones, voiceModifyOf } from '../../shared/speech'
import type { SpeechConfig } from '../../shared/speech'
import { saveBufferAsset } from '../store/media.repo'
import { getDb } from '../store/db'
import { looksLikeTar, pickAudioFromTar } from '../media/tar-audio'
import { getProvider } from './providers.repo'
import { GatewayError } from './factory'
import { describeUpstreamHttpError } from '../../shared/upstream-error'

/**
 * 上游错误统一出口：服务商可能返回 JSON 错误体、嵌套 base_resp，
 * 甚至整页 HTML 错误页。归一化后节点上看到的是一句可行动的话，而不是 markup。
 */
function upstreamError(status: number, body: string, context: string): GatewayError {
  const error = describeUpstreamHttpError(status, body, context)
  return new GatewayError(error.code, error.message)
}

const EXT_BY_FORMAT: Record<string, string> = {
  mp3: '.mp3',
  opus: '.opus',
  aac: '.aac',
  flac: '.flac',
  wav: '.wav',
  pcm: '.pcm',
  ogg_opus: '.ogg',
  ogg: '.ogg'
}

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
  ogg_opus: 'audio/ogg',
  ogg: 'audio/ogg'
}

/** MiniMax T2A v2 只接受 mp3/pcm/flac；其余请求格式回落 mp3。 */
const MINIMAX_FORMATS = new Set(['mp3', 'pcm', 'flac'])

/** 火山语音合成 1.0 的 audio.encoding 枚举（没有 flac）。 */
const VOLC_ENCODINGS = new Set(['mp3', 'wav', 'pcm', 'ogg_opus'])
/** 1.0 的 user.uid 只用于服务端链路追踪；本地没有账号体系，用固定标识。 */
const VOLC_UID = 'canvas-studio'
/** 非流式合成的成功码；其他取值都要带着 message 抛错。 */
const VOLC_OK_CODE = 3000

/** 配音节点默认音色是 OpenAI 命名（alloy 等），MiniMax 端没有这些音色，映射到系统音色。 */
const OPENAI_DEFAULT_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
const MINIMAX_DEFAULT_VOICE = 'male-qn-qingse'

/**
 * MiniMax 两条 t2a 通道都要求 `voice_setting.voice_id`，实测缺它会在创建任务之前就被
 * 上游拒掉（`invalid params, voice id wrong`，不计费）。旧实现假设「不发就让服务端用
 * 它自己的默认音色」，那是没有真跑过的猜测——配音节点默认音色为空，于是默认状态必失败。
 * 空值与 OpenAI 命名都落到 MiniMax 的系统音色，两条通道同一个解析口径。
 */
function resolveMiniMaxVoiceId(voiceId: string | undefined): string {
  const trimmed = voiceId?.trim() ?? ''
  return !trimmed || OPENAI_DEFAULT_VOICES.has(trimmed) ? MINIMAX_DEFAULT_VOICE : trimmed
}

/** 异步 T2A 的轮询节奏；合成任务通常数十秒完成。 */
const ASYNC_POLL_INTERVAL_MS = 2000
const ASYNC_POLL_TIMEOUT_MS = 10 * 60 * 1000

/** 下载 URL 生成起 9 小时内有效；这里用更保守的 10 分钟超时避免长挂。 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function generateAudioToAsset(input: AudioGenerateInput): Promise<MediaAsset> {
  if (!input.text?.trim()) throw new GatewayError('INVALID_INPUT', '朗读文本不能为空')

  const p = getProvider(input.providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')

  if (p.specId === 'minimax') return generateViaMiniMax(p, input)
  return generateViaOpenAICompatible(p, input)
}

// ── 配音节点：模型驱动的合成入口 ──

export async function generateSpeechToAsset(
  input: SpeechGenerateInput
): Promise<SpeechGenerateResult> {
  const text = input.text?.trim()
  if (!text) throw new GatewayError('INVALID_INPUT', '朗读文本不能为空')

  const config = input.config
  const limit = SPEECH_TEXT_LIMITS[config.backend] ?? SPEECH_TEXT_LIMITS.openai
  if (text.length > limit) {
    throw new GatewayError('INVALID_INPUT', `朗读文本超过 ${limit} 字符上限（当前 ${text.length}）`)
  }

  const p = getProvider(input.providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')

  if (config.backend === 'minimax') {
    if (p.specId !== 'minimax') {
      throw new GatewayError('INVALID_INPUT', 'MiniMax 配音通道只能选择 MiniMax 供应商')
    }
    const asset = await generateViaMiniMaxAsync(p, input)
    return { asset }
  }

  if (config.backend === 'doubao') {
    if (p.specId !== 'doubao-speech') {
      throw new GatewayError('INVALID_INPUT', '豆包语音通道只能选择豆包语音（Seed-Audio）供应商')
    }
    return generateViaDoubao(p, input)
  }

  if (config.backend === 'volc') {
    if (p.specId !== 'doubao-speech') {
      throw new GatewayError(
        'INVALID_INPUT',
        '火山语音合成 1.0 与豆包语音共用 openspeech 供应商实例'
      )
    }
    if (!config.volcAppId) {
      throw new GatewayError('INVALID_INPUT', '火山语音合成 1.0 需要填写节点里的 AppID')
    }
    if (!input.voiceId?.trim()) {
      throw new GatewayError('INVALID_INPUT', '火山语音合成 1.0 的 voice_type 不能为空')
    }
    return generateViaVolc(p, input)
  }

  assertOpenAiCompatible(p)
  const asset = await generateViaOpenAICompatible(p, {
    projectId: input.projectId,
    providerId: input.providerId,
    modelId: input.modelId,
    text,
    voice: input.voiceId || undefined,
    format: config.format
  })
  return { asset }
}

/** OpenAI 兼容通道不接受原生协议供应商，避免把 MiniMax/豆包实例打到 /audio/speech。 */
function assertOpenAiCompatible(p: ProviderConfig): void {
  if (p.specId === 'minimax' || p.specId === 'doubao-speech') {
    throw new GatewayError('INVALID_INPUT', 'OpenAI 兼容配音通道不支持该原生协议供应商')
  }
}

/**
 * MiniMax 异步语音合成的请求体（纯函数，便于对协议做 wire 断言）。
 * 只发送真正偏离默认值的可选字段，避免把空对象塞进请求体。
 */
export function buildMiniMaxAsyncTtsBody(
  input: Pick<SpeechGenerateInput, 'modelId' | 'text' | 'voiceId'>,
  config: SpeechConfig
): Record<string, unknown> {
  const format = MINIMAX_FORMATS.has(config.format) ? config.format : 'mp3'
  const tones = parsePronunciationTones(config.pronunciationTones)
  const voiceModify = voiceModifyOf(config)
  const voiceSetting: Record<string, unknown> = {
    voice_id: resolveMiniMaxVoiceId(input.voiceId),
    speed: config.speed,
    vol: config.volume,
    pitch: config.pitch,
    ...(config.emotion ? { emotion: config.emotion } : {}),
    ...(config.englishNormalization ? { english_normalization: true } : {})
  }

  return {
    model: input.modelId,
    text: input.text.trim(),
    voice_setting: voiceSetting,
    audio_setting: {
      audio_sample_rate: config.sampleRate,
      bitrate: config.bitrate,
      format,
      channel: config.audioChannel
    },
    ...(tones.length ? { pronunciation_dict: { tone: tones } } : {}),
    ...(config.languageBoost ? { language_boost: config.languageBoost } : {}),
    ...(voiceModify ? { voice_modify: voiceModify } : {}),
    aigc_watermark: config.aigcWatermark
  }
}

/**
 * 豆包语音合成的请求体（纯函数）。
 *
 * 实现边界：只发送本会话文档化的字段——model、text_prompt、speaker（互斥三选一
 * 中的 speaker）、audio_config、watermark、aigc_metadata。references[] 参考音频、
 * audio_data 内联音频与 audio_url 远程音频需要额外的素材上传/托管链路，本节点
 * 尚未接入，因此既不暴露端口也不发送半成品字段。
 */
export function buildDoubaoSpeechBody(
  input: Pick<SpeechGenerateInput, 'modelId' | 'text' | 'voiceId'>,
  config: SpeechConfig
): Record<string, unknown> {
  return {
    model: input.modelId,
    text_prompt: input.text.trim(),
    ...(input.voiceId ? { speaker: input.voiceId } : {}),
    audio_config: {
      format: config.format,
      sample_rate: config.sampleRate,
      speech_rate: config.speechRate,
      loudness_rate: config.loudnessRate,
      pitch_rate: config.pitchRate,
      enable_subtitle: config.enableSubtitle
    },
    watermark: { aigc_watermark: config.aigcWatermark },
    aigc_metadata: { enable: false }
  }
}

/**
 * 火山引擎语音合成 1.0 的请求体（纯函数，便于对协议做 wire 断言）。
 *
 * 实现边界：只发送 /api/v1/tts 文档化的四个对象——app（appid + token + cluster）、
 * user（uid 用于链路追踪）、audio（voice_type / encoding / speed_ratio）、request
 * （reqid / text / operation=query）。1.0 的输出规格由 voice_type 决定，请求体里没有
 * 采样率与码率字段，所以节点上那两项对该通道既不呈现也不发送。aigc 水印在 1.0 是另一
 * 组字段且非通用能力，这里不猜字段名，因此不发送。
 */
export function buildVolcTtsBody(
  p: Pick<ProviderConfig, 'apiKey'>,
  input: Pick<SpeechGenerateInput, 'text' | 'voiceId'>,
  config: SpeechConfig,
  reqid: string
): Record<string, unknown> {
  return {
    app: { appid: config.volcAppId, token: p.apiKey, cluster: config.volcCluster },
    user: { uid: VOLC_UID },
    audio: {
      voice_type: input.voiceId.trim(),
      encoding: VOLC_ENCODINGS.has(config.format) ? config.format : 'mp3',
      speed_ratio: config.speed
    },
    request: { reqid, text: input.text.trim(), operation: 'query' }
  }
}

/**
 * MiniMax 异步语音合成：创建任务 → 轮询 → 用 file_id 走文件检索拿下载地址 → 落盘。
 * 异步通道是配音节点的默认主通道，因为它承载了完整的 voice_setting / audio_setting /
 * pronunciation_dict / voice_modify 参数面，同步的 t2a_v2 只接受其中一小部分。
 */
async function generateViaMiniMaxAsync(
  p: ProviderConfig,
  input: SpeechGenerateInput
): Promise<MediaAsset> {
  const config = input.config
  const base = p.baseURL.replace(/\/+$/, '')
  const format = MINIMAX_FORMATS.has(config.format) ? config.format : 'mp3'

  const res = await fetch(`${base}/v1/t2a_async_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${p.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildMiniMaxAsyncTtsBody(input, config))
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw upstreamError(res.status, body, 'MiniMax 创建语音合成任务失败')
  }
  const created = (await res.json().catch(() => null)) as MiniMaxEnvelope & {
    task_id?: string | number
    file_id?: string | number
  }
  assertMiniMaxOk(created, 'MiniMax 创建语音合成任务失败')

  const taskId = created?.task_id !== undefined ? String(created.task_id) : ''
  // 提交回执里就带着 file_id，但那只是「将来那个文件的号」：实测立刻检索必然得到
  // `invalid params, file not found`，文件要等任务成功之后才存在。所以只要有 task_id
  // 就必须先轮询到成功，再按查询回执的 file_id 去检索。
  const fileId = taskId
    ? await pollMiniMaxAsyncTask(base, p, taskId)
    : created?.file_id
      ? String(created.file_id)
      : ''
  if (!fileId) {
    throw new GatewayError('EMPTY_RESULT', 'MiniMax 未返回 task_id 或 file_id')
  }

  const downloadUrl = await retrieveMiniMaxFileUrl(base, p, fileId)
  const downloaded = await downloadBinary(downloadUrl)
  // 下载地址给的是 ustar 归档（实测 content-type application/x-tar），音频在成员里；
  // 不解包就把归档按 .mp3 落盘，节点上是一个永远播不出声的假音频。
  const audio = looksLikeTar(downloaded) ? pickAudioFromTar(downloaded) : downloaded
  if (!audio) {
    throw new GatewayError('EMPTY_RESULT', 'MiniMax 异步合成的产物里没有可播放的音频成员')
  }
  return saveAudioAsset(input.projectId, audio, format, input.text.trim())
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

/** 轮询异步任务直到成功；失败或超时都抛出带服务端原因的错误。 */
async function pollMiniMaxAsyncTask(
  base: string,
  p: ProviderConfig,
  taskId: string
): Promise<string> {
  const deadline = Date.now() + ASYNC_POLL_TIMEOUT_MS
  let lastStatus = ''
  while (Date.now() < deadline) {
    const res = await fetch(
      `${base}/v1/query/t2a_async_query_v2?task_id=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${p.apiKey}` } }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw upstreamError(res.status, body, 'MiniMax 查询语音合成任务失败')
    }
    const payload = (await res.json().catch(() => null)) as MiniMaxEnvelope & {
      task_id?: string | number
      status?: string
      file_id?: string | number
    }
    assertMiniMaxOk(payload, 'MiniMax 查询语音合成任务失败')
    lastStatus = typeof payload?.status === 'string' ? payload.status : lastStatus
    const fileId = payload?.file_id ? String(payload.file_id) : ''
    if (fileId && /success/i.test(lastStatus)) return fileId
    // Success 是实测值；超时/取消的状态不匹配失败就会白轮满 10 分钟，用户以为还在合成。
    if (/fail|error|expired|timeout|cancel/i.test(lastStatus)) {
      throw new GatewayError(
        'UPSTREAM_ERROR',
        `MiniMax 语音合成任务失败（状态 ${lastStatus || '未知'}）`
      )
    }
    await sleep(ASYNC_POLL_INTERVAL_MS)
  }
  throw new GatewayError(
    'TIMEOUT',
    `MiniMax 语音合成超时（${ASYNC_POLL_TIMEOUT_MS / 60000} 分钟，最后状态 ${lastStatus || '未知'}）`
  )
}

/** 文件检索接口返回带时效的下载地址；这里不做缓存，避免用到过期 URL。 */
async function retrieveMiniMaxFileUrl(
  base: string,
  p: ProviderConfig,
  fileId: string
): Promise<string> {
  const res = await fetch(`${base}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${p.apiKey}` }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw upstreamError(res.status, body, 'MiniMax 检索合成文件失败')
  }
  const payload = (await res.json().catch(() => null)) as MiniMaxEnvelope & {
    file?: { download_url?: string }
  }
  assertMiniMaxOk(payload, 'MiniMax 检索合成文件失败')
  const url = payload?.file?.download_url
  if (!url) throw new GatewayError('EMPTY_RESULT', 'MiniMax 未返回合成文件的下载地址')
  return url
}

async function downloadBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) {
    throw new GatewayError('UPSTREAM_ERROR', `下载合成音频失败：HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new GatewayError('EMPTY_RESULT', '下载到的音频为空')
  return buf
}

/**
 * 豆包语音合成（seed-audio-1.0）：一次请求同步返回 Base64 音频与可选字幕。
 * 请求体的实现边界见 buildDoubaoSpeechBody。
 */
async function generateViaDoubao(
  p: ProviderConfig,
  input: SpeechGenerateInput
): Promise<SpeechGenerateResult> {
  const config = input.config
  const base = p.baseURL.replace(/\/+$/, '')

  const res = await fetch(`${base}/api/v3/tts/create`, {
    method: 'POST',
    headers: {
      'X-Api-Key': p.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildDoubaoSpeechBody(input, config))
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw upstreamError(res.status, body, '豆包语音合成失败')
  }
  const payload = (await res.json().catch(() => null)) as {
    code?: number
    message?: string
    audio?: string
    subtitle?: { text?: string; sentences?: unknown[] }
  } | null

  if (typeof payload?.code === 'number' && payload.code !== 0) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `豆包语音合成失败 ${payload.code}：${payload.message || '未知错误'}`
    )
  }
  const audio = payload?.audio
  if (!audio) throw new GatewayError('EMPTY_RESULT', '豆包语音合成未返回音频数据')

  const buf = Buffer.from(audio, 'base64')
  if (!buf.length) throw new GatewayError('EMPTY_RESULT', '豆包返回的音频数据无效')

  const asset = await saveAudioAsset(input.projectId, buf, config.format, input.text.trim())
  const subtitle = config.enableSubtitle ? normalizeSubtitle(payload?.subtitle) : undefined
  return subtitle ? { asset, subtitle } : { asset }
}

/**
 * 火山引擎语音合成 1.0：一次请求同步返回 Base64 音频。鉴权头是 `Bearer;{token}`，
 * 分号是协议要求而不是笔误。
 */
async function generateViaVolc(
  p: ProviderConfig,
  input: SpeechGenerateInput
): Promise<SpeechGenerateResult> {
  const config = input.config
  const base = p.baseURL.replace(/\/+$/, '')

  const res = await fetch(`${base}/api/v1/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer;${p.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildVolcTtsBody(p, input, config, randomUUID()))
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw upstreamError(res.status, body, '火山语音合成失败')
  }
  const payload = (await res.json().catch(() => null)) as {
    code?: number
    message?: string
    data?: string
  } | null

  if (typeof payload?.code === 'number' && payload.code !== VOLC_OK_CODE) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `火山语音合成失败 ${payload.code}：${payload.message || '未知错误'}`
    )
  }
  const audio = payload?.data
  if (!audio) throw new GatewayError('EMPTY_RESULT', '火山语音合成未返回音频数据')

  const buf = Buffer.from(audio, 'base64')
  if (!buf.length) throw new GatewayError('EMPTY_RESULT', '火山语音返回的音频数据无效')

  const encoding = VOLC_ENCODINGS.has(config.format) ? config.format : 'mp3'
  return { asset: await saveAudioAsset(input.projectId, buf, encoding, input.text.trim()) }
}

/** 字幕只保留结构化时间轴；字段缺失时丢弃整条字幕而不是伪造空句子。 */
function normalizeSubtitle(raw: unknown): SpeechSubtitle | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const data = raw as { text?: unknown; sentences?: unknown }
  if (!Array.isArray(data.sentences)) return undefined
  const sentences = data.sentences
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const sentence = item as Record<string, unknown>
      if (
        typeof sentence.start_time !== 'number' ||
        typeof sentence.end_time !== 'number' ||
        typeof sentence.text !== 'string'
      ) {
        return null
      }
      return {
        start_time: sentence.start_time,
        end_time: sentence.end_time,
        text: sentence.text,
        ...(Array.isArray(sentence.words) ? { words: sentence.words } : {})
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
  if (!sentences.length) return undefined
  return {
    text: typeof data.text === 'string' ? data.text : sentences.map((s) => s.text).join(''),
    sentences
  }
}

/** MiniMax T2A v2：同步返回完整音频，data.audio 为 hex 编码。 */
async function generateViaMiniMax(
  p: ProviderConfig,
  input: AudioGenerateInput
): Promise<MediaAsset> {
  const requestedFormat = input.format || 'mp3'
  const format = MINIMAX_FORMATS.has(requestedFormat) ? requestedFormat : 'mp3'
  const voiceId = resolveMiniMaxVoiceId(input.voice)

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
      audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 },
      ...(typeof input.aigcWatermark === 'boolean' ? { aigc_watermark: input.aigcWatermark } : {})
    })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw upstreamError(res.status, body, 'MiniMax 同步语音合成失败')
  }
  const payload = (await res.json().catch(() => null)) as {
    data?: { audio?: string }
    base_resp?: { status_code?: number; status_msg?: string }
  } | null
  assertMiniMaxOk(payload, 'MiniMax TTS 错误')
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
    throw upstreamError(res.status, body, 'OpenAI 兼容配音失败')
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
