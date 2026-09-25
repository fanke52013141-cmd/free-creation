// 音频生成（TTS）：按供应商协议分派
//   specId === 'minimax' → MiniMax T2A v2（POST {base}/v1/t2a_v2，返回 hex 音频）
//   其余 → OpenAI 兼容 /audio/speech（独立音频生成节点使用）
// 产物 Buffer 走 media 管线入库，节点侧拿到 MediaAsset 即可播放。
// TokenDance 等网关以 /gateway/minimax 前缀转发原生 MiniMax 协议，路径结构一致。
//
// 配音（speech）节点是「模型驱动」的：由 config.backend 明确选择协议，而不是
// 按上游节点类型猜测。各条协议各自只发送自己文档化的字段：
//   minimax → POST {base}/v1/t2a_async_v2（异步任务 + 文件检索下载）
//   volc    → POST {base}/api/v3/tts/create（火山引擎语音合成 1.0）
import { randomUUID } from 'node:crypto'
import type {
  AudioGenerateInput,
  SpeechGenerateInput,
  SpeechGenerateResult,
  SpeechSubtitle
} from '../../shared/contracts'
import type { MediaAsset, ProviderConfig } from '../../shared/types'
import {
  VOLC_REFERENCE_AUDIO_MAX_BYTES,
  VOLC_REFERENCE_AUDIO_MAX_COUNT,
  VOLC_REFERENCE_AUDIO_MAX_SECONDS,
  volcReferencePromptPrefix,
  MINIMAX_ASYNC_SPEECH_MODELS,
  SPEECH_TEXT_LIMITS,
  isSpeechEmotionSupported,
  isSpeechLanguageBoostSupported,
  parsePronunciationTones,
  voiceModifyOf,
  type SpeechConfig
} from '../../shared/speech'
import { getMediaAbsPath, readMediaBuffer, saveBufferAsset } from '../store/media.repo'
import { getDb } from '../store/db'
import { probeMediaDurationMs } from '../media/video-transform'
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
  pcmu_raw: '.ulaw',
  pcmu_wav: '.wav',
  ogg_opus: '.ogg',
  ogg: '.ogg'
}

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
  pcmu_raw: 'audio/basic',
  pcmu_wav: 'audio/wav',
  ogg_opus: 'audio/ogg',
  ogg: 'audio/ogg'
}

/** MiniMax async T2A v2 支持的完整音频格式枚举。 */
const MINIMAX_FORMATS = new Set([
  'mp3',
  'pcm',
  'flac',
  'wav',
  'pcmu_raw',
  'pcmu_wav',
  'opus'
])

/** 火山 1.0 输出格式；格式支持范围与 MiniMax 不同。 */
const VOLC_FORMATS = new Set(['mp3', 'wav', 'pcm', 'ogg_opus'])

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

/**
 * 本次请求真正会用的音色 ID，用于产物溯源。只有 MiniMax 通道存在「用户留空 → 兜底成
 * 系统音色」的改写；火山留空时服务端用了哪个音色我们无从得知，返回
 * undefined 让调用方跳过溯源，而不是编一个默认值冒充已溯源。
 */
export function effectiveSpeechVoiceId(
  backend: SpeechConfig['backend'],
  voiceId: string | undefined
): string | undefined {
  if (backend === 'minimax') return resolveMiniMaxVoiceId(voiceId)
  return voiceId?.trim() || undefined
}

export async function generateSpeechToAsset(
  input: SpeechGenerateInput
): Promise<SpeechGenerateResult> {
  const text = input.text?.trim()
  if (!text) throw new GatewayError('INVALID_INPUT', '朗读文本不能为空')

  const config = input.config
  const limit = SPEECH_TEXT_LIMITS[config.backend]
  if (text.length > limit) {
    throw new GatewayError('INVALID_INPUT', `朗读文本超过 ${limit} 字符上限（当前 ${text.length}）`)
  }

  const p = getProvider(input.providerId)
  if (!p) throw new GatewayError('PROVIDER_NOT_FOUND', '供应商不存在')

  // 回传「实际生效」的音色供产物溯源：只有 MiniMax 通道存在「用户留空 → 网关兜底成
  // 系统音色」的改写；火山通道留空时服务端用了什么音色我们并不知道，因此回传
  // undefined 而不是编一个默认值冒充已溯源。
  const spokenAs = effectiveSpeechVoiceId(config.backend, input.voiceId)

  if (config.backend === 'minimax') {
    if (p.specId !== 'minimax') {
      throw new GatewayError('INVALID_INPUT', 'MiniMax 配音通道只能选择 MiniMax 供应商')
    }
    const asset = await generateViaMiniMaxAsync(p, input)
    return { asset, voiceId: spokenAs }
  }

  if (config.backend === 'volc') {
    if (p.specId !== 'volc-speech') {
      throw new GatewayError('INVALID_INPUT', '火山语音合成 1.0 只能选择火山引擎语音供应商')
    }
    return { ...(await generateViaVolc(p, input)), voiceId: spokenAs }
  }
  throw new GatewayError('INVALID_INPUT', '不支持的语音合成供应商')
}

/**
 * MiniMax 异步语音合成的请求体（纯函数，便于对协议做 wire 断言）。
 * 只发送真正偏离默认值的可选字段，避免把空对象塞进请求体。
 */
export function buildMiniMaxAsyncTtsBody(
  input: Pick<SpeechGenerateInput, 'modelId' | 'text' | 'voiceId'>,
  config: SpeechConfig
): Record<string, unknown> {
  if (!MINIMAX_ASYNC_SPEECH_MODELS.includes(input.modelId)) {
    throw new GatewayError('INVALID_INPUT', `MiniMax 异步语音合成不支持模型 ${input.modelId}`)
  }
  const format = MINIMAX_FORMATS.has(config.format) ? config.format : 'mp3'
  const tones = parsePronunciationTones(config.pronunciationTones)
  const voiceModify = ['mp3', 'wav', 'flac'].includes(format) ? voiceModifyOf(config) : null
  const voiceSetting: Record<string, unknown> = {
    voice_id: resolveMiniMaxVoiceId(input.voiceId),
    speed: config.speed,
    vol: config.volume,
    pitch: config.pitch,
    ...(isSpeechEmotionSupported(input.modelId, config.emotion) && config.emotion
      ? { emotion: config.emotion }
      : {}),
    ...(config.englishNormalization ? { english_normalization: true } : {})
  }

  return {
    model: input.modelId,
    text: input.text.trim(),
    voice_setting: voiceSetting,
    audio_setting: {
      audio_sample_rate: config.sampleRate,
      ...(format === 'mp3' ? { bitrate: config.bitrate } : {}),
      format,
      channel: config.audioChannel
    },
    ...(tones.length ? { pronunciation_dict: { tone: tones } } : {}),
    ...(config.languageBoost && isSpeechLanguageBoostSupported(input.modelId, config.languageBoost)
      ? { language_boost: config.languageBoost }
      : {}),
    ...(voiceModify ? { voice_modify: voiceModify } : {}),
    aigc_watermark: config.aigcWatermark
  }
}

/** 火山引擎语音合成 1.0 请求体；references 与 speaker 可以同时传入。 */
export function buildVolcSpeechBody(
  input: Pick<SpeechGenerateInput, 'modelId' | 'text' | 'voiceId'>,
  config: SpeechConfig,
  referenceAudioData: readonly string[] = []
): Record<string, unknown> {
  if (input.modelId !== 'seed-audio-1.0') {
    throw new GatewayError('INVALID_INPUT', '火山语音合成仅支持 seed-audio-1.0')
  }
  const textPrompt = `${volcReferencePromptPrefix(referenceAudioData.length)}${input.text.trim()}`
  const format = VOLC_FORMATS.has(config.format) ? config.format : 'wav'
  return {
    model: input.modelId,
    text_prompt: textPrompt,
    ...(referenceAudioData.length
      ? { references: referenceAudioData.map((audio_data) => ({ audio_data })) }
      : {}),
    ...(input.voiceId.trim() ? { speaker: input.voiceId.trim() } : {}),
    audio_config: {
      format,
      sample_rate: config.sampleRate,
      speech_rate: config.speechRate,
      loudness_rate: config.loudnessRate,
      pitch_rate: config.pitchRate,
      enable_subtitle: config.enableSubtitle
    },
    watermark: { aigc_watermark: config.aigcWatermark, aigc_metadata: { enable: false } }
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

/** 火山引擎语音合成 1.0：一次请求同步返回 Base64 音频与可选字幕。 */
async function generateViaVolc(
  p: ProviderConfig,
  input: SpeechGenerateInput
): Promise<SpeechGenerateResult> {
  const config = input.config
  const base = p.baseURL.replace(/\/+$/, '')
  const referenceAudioData = await readVolcReferenceAudio(input)
  const body = buildVolcSpeechBody(input, config, referenceAudioData)
  const textPrompt = typeof body.text_prompt === 'string' ? body.text_prompt : ''
  const audioConfig = body.audio_config as { format: string }
  if (textPrompt.length > SPEECH_TEXT_LIMITS.volc) {
    throw new GatewayError(
      'INVALID_INPUT',
      `火山语音合成 1.0 提示词超过 ${SPEECH_TEXT_LIMITS.volc} 字符（参考音频引用也计入上限）`
    )
  }

  const res = await fetch(`${base}/api/v3/tts/create`, {
    method: 'POST',
    headers: {
      'X-Api-Key': p.apiKey,
      'X-Api-Request-Id': randomUUID(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw upstreamError(res.status, body, '火山语音合成失败')
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
      `火山语音合成失败 ${payload.code}：${payload.message || '未知错误'}`
    )
  }
  const audio = payload?.audio
  if (!audio) throw new GatewayError('EMPTY_RESULT', '火山语音合成未返回音频数据')

  const buf = Buffer.from(audio, 'base64')
  if (!buf.length) throw new GatewayError('EMPTY_RESULT', '火山返回的音频数据无效')

  const asset = await saveAudioAsset(input.projectId, buf, audioConfig.format, input.text.trim())
  const subtitle = config.enableSubtitle ? normalizeSubtitle(payload?.subtitle) : undefined
  return subtitle ? { asset, subtitle } : { asset }
}

/** 从项目媒体库读取火山语音合成 1.0 的参考音频，并在发请求前执行文档限制。 */
async function readVolcReferenceAudio(input: SpeechGenerateInput): Promise<string[]> {
  const ids = input.referenceAudioIds ?? []
  if (ids.length > VOLC_REFERENCE_AUDIO_MAX_COUNT) {
    throw new GatewayError(
      'INVALID_INPUT',
      `火山语音合成 1.0 最多支持 ${VOLC_REFERENCE_AUDIO_MAX_COUNT} 段参考音频`
    )
  }

  const encoded: string[] = []
  for (const id of ids) {
    const row = getDb()
      .prepare('SELECT path FROM media WHERE id = ?')
      .get(id) as { path: string } | undefined
    if (!row || !row.path.startsWith(`projects/${input.projectId}/media/`)) {
      throw new GatewayError('MEDIA_NOT_FOUND', '火山参考音频不存在或不属于当前项目')
    }
    const extension = row.path.slice(row.path.lastIndexOf('.')).toLowerCase()
    if (!['.wav', '.mp3', '.pcm', '.ogg', '.opus'].includes(extension)) {
      throw new GatewayError(
        'INVALID_INPUT',
        '火山参考音频仅支持 wav、mp3、pcm 或 ogg_opus 格式'
      )
    }
    const media = await readMediaBuffer(id)
    if (!media) throw new GatewayError('MEDIA_NOT_FOUND', '火山参考音频文件读取失败')
    if (media.buf.length > VOLC_REFERENCE_AUDIO_MAX_BYTES) {
      throw new GatewayError('INVALID_INPUT', '火山参考音频单段不能超过 10MB')
    }
    const absPath = getMediaAbsPath(row.path)
    const durationMs = absPath ? await probeMediaDurationMs(absPath).catch(() => 0) : 0
    if (durationMs > VOLC_REFERENCE_AUDIO_MAX_SECONDS * 1000) {
      throw new GatewayError(
        'INVALID_INPUT',
        `火山参考音频单段不能超过 ${VOLC_REFERENCE_AUDIO_MAX_SECONDS} 秒，当前约 ${(durationMs / 1000).toFixed(1)} 秒`
      )
    }
    encoded.push(media.buf.toString('base64'))
  }
  return encoded
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
