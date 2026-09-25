/**
 * 配音（speech）节点的「模型驱动」配置。
 *
 * 用户诉求（2026-09-18）：「它可以输入的内容很多，所以我们选择模型的不同，
 * 也决定了它的输入和输出的结构」。因此这里用 backend 明确声明本次合成走哪条
 * 供应商协议，节点端口（resolvePorts）与 UI 分组都由 backend 派生——不按上游
 * 节点标题或类型猜测输入，也不把某家供应商的参数悄悄塞进另一家的请求体。
 *
 *   minimax → MiniMax 异步语音合成 POST /v1/t2a_async_v2
 *   volc    → 火山引擎语音合成 1.0 POST /api/v3/tts/create
 */

export type SpeechBackend = 'minimax' | 'volc'

export type SpeechFormat =
  'mp3' | 'wav' | 'pcm' | 'flac' | 'pcmu_raw' | 'pcmu_wav' | 'opus' | 'ogg_opus'

export const MINIMAX_ASYNC_SPEECH_MODELS: ReadonlyArray<string> = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo'
]

/** MiniMax voice_setting.emotion 的受支持取值；空串表示不指定，交给模型自判。 */
export type SpeechEmotion =
  | ''
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'disgusted'
  | 'surprised'
  | 'calm'
  | 'fluent'
  | 'whisper'

export interface SpeechConfig {
  featureKey?: string
  version: 1
  backend: SpeechBackend
  /** 供应商实例 ID（backend 对应的那家）。 */
  providerId: string
  /** 合成模型，例如 speech-2.8-hd / seed-audio-1.0。 */
  modelId: string

  // ── 音色（用户强调「音色、ID」是最重要的信息之一）──
  /** MiniMax voice_id；可由上游 MiniMax「音色设计」节点的 JSON 输入覆盖。 */
  voiceId: string
  /** 火山语音合成 1.0 的可选参考音频；连线 in-audio 存在时优先使用连线输入。 */
  referenceAudioId: string
  referenceAudioPath: string
  referenceAudioName: string

  // ── MiniMax voice_setting ──
  /** 语速，[0.5, 2]。 */
  speed: number
  /** 音量，(0, 10]。 */
  volume: number
  /** 音调，[-12, 12]。 */
  pitch: number
  emotion: SpeechEmotion
  englishNormalization: boolean

  // ── MiniMax audio_setting ──
  format: SpeechFormat
  /** 采样率 Hz。 */
  sampleRate: number
  /** 码率 bps。 */
  bitrate: number
  /** 声道数：1 单声道 / 2 双声道。 */
  audioChannel: 1 | 2

  // ── 语言增强 ──
  /** MiniMax language_boost；'auto' 交给服务端判别。 */
  languageBoost: string

  // ── 自定义读音 pronunciation_dict.tone ──
  /** MiniMax 读音规则以换行分隔；空串表示不传。 */
  pronunciationTones: string

  // ── 音效与音色修饰 voice_modify ──
  /** MiniMax sound_effects；空串表示不加音效。 */
  soundEffects: string
  /** voice_modify.pitch，[-100, 100]。 */
  voicePitch: number
  /** voice_modify.intensity，[-100, 100]。 */
  voiceIntensity: number
  /** voice_modify.timbre，[-100, 100]。 */
  voiceTimbre: number

  // ── 火山引擎语音合成 1.0 audio_config ──
  /** 火山 speech_rate，[-50, 100]。 */
  speechRate: number
  /** 火山 loudness_rate，[-50, 100]。 */
  loudnessRate: number
  /** 火山 pitch_rate，[-12, 12]。 */
  pitchRate: number
  /** 火山 enable_subtitle：为真时节点额外产出 out-subtitle。 */
  enableSubtitle: boolean

  // ── 水印 ──
  aigcWatermark: boolean
}

export const SPEECH_BACKENDS: ReadonlyArray<{
  value: SpeechBackend
  label: string
}> = [
  {
    value: 'minimax',
    label: 'MiniMax · 异步语音合成'
  },
  {
    value: 'volc',
    label: '火山引擎 · 语音合成 1.0'
  }
]

export const SPEECH_EMOTIONS: ReadonlyArray<{ value: SpeechEmotion; label: string }> = [
  { value: '', label: '默认（不指定）' },
  { value: 'happy', label: '开心' },
  { value: 'sad', label: '悲伤' },
  { value: 'angry', label: '愤怒' },
  { value: 'fearful', label: '恐惧' },
  { value: 'disgusted', label: '厌恶' },
  { value: 'surprised', label: '惊讶' },
  { value: 'calm', label: '中性' },
  { value: 'fluent', label: '生动' },
  { value: 'whisper', label: '低语' }
]

/** MiniMax language_boost 的常用取值；'auto' 为默认，其余按官方枚举收窄。 */
export const SPEECH_LANGUAGE_BOOSTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: '自动判别' },
  { value: 'Chinese', label: '中文' },
  { value: 'Chinese,Yue', label: '中文（粤语）' },
  { value: 'English', label: '英文' },
  { value: 'Arabic', label: '阿拉伯语' },
  { value: 'Russian', label: '俄语' },
  { value: 'Spanish', label: '西班牙语' },
  { value: 'French', label: '法语' },
  { value: 'Portuguese', label: '葡萄牙语' },
  { value: 'German', label: '德语' },
  { value: 'Turkish', label: '土耳其语' },
  { value: 'Dutch', label: '荷兰语' },
  { value: 'Ukrainian', label: '乌克兰语' },
  { value: 'Vietnamese', label: '越南语' },
  { value: 'Indonesian', label: '印尼语' },
  { value: 'Japanese', label: '日语' },
  { value: 'Italian', label: '意大利语' },
  { value: 'Korean', label: '韩语' },
  { value: 'Thai', label: '泰语' },
  { value: 'Polish', label: '波兰语' },
  { value: 'Romanian', label: '罗马尼亚语' },
  { value: 'Greek', label: '希腊语' },
  { value: 'Czech', label: '捷克语' },
  { value: 'Finnish', label: '芬兰语' },
  { value: 'Hindi', label: '印地语' },
  { value: 'Bulgarian', label: '保加利亚语' },
  { value: 'Danish', label: '丹麦语' },
  { value: 'Hebrew', label: '希伯来语' },
  { value: 'Malay', label: '马来语' },
  { value: 'Persian', label: '波斯语' },
  { value: 'Slovak', label: '斯洛伐克语' },
  { value: 'Swedish', label: '瑞典语' },
  { value: 'Croatian', label: '克罗地亚语' },
  { value: 'Filipino', label: '菲律宾语' },
  { value: 'Hungarian', label: '匈牙利语' },
  { value: 'Norwegian', label: '挪威语' },
  { value: 'Slovenian', label: '斯洛文尼亚语' },
  { value: 'Catalan', label: '加泰罗尼亚语' },
  { value: 'Nynorsk', label: '尼诺斯克语' },
  { value: 'Tamil', label: '泰米尔语' },
  { value: 'Afrikaans', label: '南非荷兰语' }
]

export const SPEECH_SOUND_EFFECTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '无' },
  { value: 'spacious_echo', label: '空旷回音' },
  { value: 'auditorium_echo', label: '礼堂广播' },
  { value: 'lofi_telephone', label: '电话失真' },
  { value: 'robotic', label: '电音' }
]

export const SPEECH_FORMATS: ReadonlyArray<SpeechFormat> = [
  'mp3',
  'wav',
  'pcm',
  'flac',
  'pcmu_raw',
  'pcmu_wav',
  'opus',
  'ogg_opus'
]

/** 采样率与码率都用受控档位，避免用户填出服务端必然拒绝的任意数字。 */
export const SPEECH_SAMPLE_RATES: ReadonlyArray<number> = [
  8000, 16000, 22050, 24000, 32000, 40000, 44100, 48000
]
export const SPEECH_BITRATES: ReadonlyArray<number> = [32000, 64000, 128000, 256000]

export const VOLC_REFERENCE_AUDIO_MAX_COUNT = 3
export const VOLC_REFERENCE_AUDIO_MAX_BYTES = 10 * 1024 * 1024
export const VOLC_REFERENCE_AUDIO_MAX_SECONDS = 30

export function volcReferencePromptPrefix(count: number): string {
  const mentions = Array.from(
    { length: Math.max(0, count) },
    (_, index) => `@音频${index + 1}`
  ).join('、')
  return mentions ? `参考 ${mentions} 的音色朗读以下文本：\n` : ''
}

/** 每种协议和格式实际支持的采样率；格式变化时 UI 与配置解析共用。 */
export function speechSampleRates(
  backend: SpeechBackend,
  format: SpeechFormat
): ReadonlyArray<number> {
  if (backend === 'minimax') {
    if (format === 'pcmu_raw' || format === 'pcmu_wav') return [8000]
    if (format === 'opus') return [8000, 12000, 16000, 24000, 48000]
    return [8000, 16000, 22050, 24000, 32000, 44100]
  }
  if (backend === 'volc') {
    if (format === 'ogg_opus') return [48000]
    if (format === 'wav' || format === 'pcm')
      return [8000, 16000, 24000, 32000, 40000, 44100, 48000]
    return [8000, 16000, 24000, 32000, 44100, 48000]
  }
  return []
}

export function defaultSpeechSampleRate(backend: SpeechBackend, format: SpeechFormat): number {
  if (backend === 'minimax') {
    if (format === 'pcmu_raw' || format === 'pcmu_wav') return 8000
    if (format === 'opus') return 48000
    return 32000
  }
  if (backend === 'volc') {
    if (format === 'ogg_opus') return 48000
    if (format === 'wav' || format === 'pcm') return 40000
    return 44100
  }
  return 32000
}

/** 各协议实际接受的输出格式；节点 UI 与网关都必须按同一份真值收敛。 */
export const SPEECH_FORMATS_BY_BACKEND: Record<SpeechBackend, ReadonlyArray<SpeechFormat>> = {
  minimax: ['mp3', 'pcm', 'flac', 'wav', 'pcmu_raw', 'pcmu_wav', 'opus'],
  volc: ['mp3', 'wav', 'pcm', 'ogg_opus']
}

/** 配音节点固定使用的默认输出格式；高级接口字段不在节点 UI 中暴露。 */
export function defaultSpeechFormat(backend: SpeechBackend): SpeechFormat {
  return backend === 'volc' ? 'wav' : 'mp3'
}

export function isSpeechEmotionSupported(modelId: string, emotion: SpeechEmotion): boolean {
  if (!emotion || (emotion !== 'fluent' && emotion !== 'whisper')) return true
  return modelId === 'speech-2.6-hd' || modelId === 'speech-2.6-turbo'
}

const MINIMAX_UNSUPPORTED_LEGACY_LANGUAGES = new Set(['Persian', 'Filipino', 'Tamil'])

export function isSpeechLanguageBoostSupported(modelId: string, languageBoost: string): boolean {
  return !(
    (modelId.startsWith('speech-01-') || modelId.startsWith('speech-02-')) &&
    MINIMAX_UNSUPPORTED_LEGACY_LANGUAGES.has(languageBoost)
  )
}

/**
 * MiniMax 与火山 1.0 都会将采样率发送到供应商。
 */
export const SPEECH_SAMPLE_RATE_BACKENDS: ReadonlyArray<SpeechBackend> = ['minimax', 'volc']

/** 火山 text_prompt 的上限；MiniMax 为 5 万字符。执行前按后端分别校验。 */
export const SPEECH_TEXT_LIMITS: Record<SpeechBackend, number> = {
  minimax: 50000,
  volc: 3000
}

export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  version: 1,
  backend: 'minimax',
  providerId: '',
  modelId: 'speech-2.8-hd',
  voiceId: '',
  referenceAudioId: '',
  referenceAudioPath: '',
  referenceAudioName: '',
  speed: 1,
  volume: 1,
  pitch: 0,
  emotion: '',
  englishNormalization: false,
  format: 'mp3',
  sampleRate: 32000,
  bitrate: 128000,
  audioChannel: 1,
  languageBoost: 'auto',
  pronunciationTones: '重庆/(chong2)(qing4)\n银行/(yin2)(hang2)\n行长/(hang2)(zhang3)',
  soundEffects: '',
  voicePitch: 0,
  voiceIntensity: 0,
  voiceTimbre: 0,
  speechRate: 0,
  loudnessRate: 0,
  pitchRate: 0,
  enableSubtitle: false,
  aigcWatermark: false
}

const EMOTION_VALUES = new Set(SPEECH_EMOTIONS.map((item) => item.value))
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

export function parseSpeechConfig(text: string): SpeechConfig {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    }
  } catch {
    return { ...DEFAULT_SPEECH_CONFIG }
  }

  const backend: SpeechBackend = raw.backend === 'volc' ? 'volc' : 'minimax'
  // 不把已移除通道保存的供应商/模型 ID 带入 MiniMax，避免误发给其他供应商。
  const validBackend = raw.backend === undefined || raw.backend === backend
  const merged = validBackend ? raw : { ...raw, providerId: '', modelId: '' }
  const modelId =
    typeof merged.modelId === 'string' && merged.modelId
      ? merged.modelId
      : DEFAULT_SPEECH_CONFIG.modelId
  const parsedEmotion = EMOTION_VALUES.has(merged.emotion as SpeechEmotion)
    ? (merged.emotion as SpeechEmotion)
    : ''
  const emotion = isSpeechEmotionSupported(modelId, parsedEmotion) ? parsedEmotion : ''
  // 配音节点隐藏格式与采样率选项，始终按供应商默认输出值请求；也收敛旧配置中的自定义值。
  const format = defaultSpeechFormat(backend)

  return {
    version: 1,
    featureKey: typeof merged.featureKey === 'string' ? merged.featureKey : undefined,
    backend,
    providerId: typeof merged.providerId === 'string' ? merged.providerId : '',
    modelId,
    voiceId: typeof merged.voiceId === 'string' ? merged.voiceId : '',
    referenceAudioId: typeof merged.referenceAudioId === 'string' ? merged.referenceAudioId : '',
    referenceAudioPath:
      typeof merged.referenceAudioPath === 'string' ? merged.referenceAudioPath : '',
    referenceAudioName:
      typeof merged.referenceAudioName === 'string' ? merged.referenceAudioName : '',
    speed: clamp(merged.speed, 0.5, 2, 1),
    volume: clamp(merged.volume, 0.01, 10, 1),
    pitch: clamp(merged.pitch, -12, 12, 0),
    emotion,
    englishNormalization: merged.englishNormalization === true,
    format,
    sampleRate: defaultSpeechSampleRate(backend, format),
    bitrate: SPEECH_BITRATES.includes(merged.bitrate as number)
      ? (merged.bitrate as number)
      : DEFAULT_SPEECH_CONFIG.bitrate,
    audioChannel: merged.audioChannel === 2 ? 2 : 1,
    // 语言增强固定为自动判别；读音纠正只用于 MiniMax，遗留音效值一律忽略。
    languageBoost: 'auto',
    pronunciationTones:
      backend === 'minimax' && typeof merged.pronunciationTones === 'string'
        ? merged.pronunciationTones
        : backend === 'minimax'
          ? DEFAULT_SPEECH_CONFIG.pronunciationTones
          : '',
    soundEffects: '',
    voicePitch: clamp(merged.voicePitch, -100, 100, 0),
    voiceIntensity: clamp(merged.voiceIntensity, -100, 100, 0),
    voiceTimbre: clamp(merged.voiceTimbre, -100, 100, 0),
    speechRate: clamp(merged.speechRate, -50, 100, 0),
    loudnessRate: clamp(merged.loudnessRate, -50, 100, 0),
    pitchRate: clamp(merged.pitchRate, -12, 12, 0),
    enableSubtitle: merged.enableSubtitle === true,
    aigcWatermark: merged.aigcWatermark === true
  }
}

export function serializeSpeechConfig(config: SpeechConfig): string {
  return JSON.stringify(config)
}

/**
 * 自定义读音：解析为 MiniMax pronunciation_dict.tone 数组。
 * 官方格式为「词/(拼音)(拼音...)」，同时把早期界面使用的「词 拼音 拼音」写法转成官方格式。
 */
export function parsePronunciationTones(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const slashIndex = line.indexOf('/')
      if (slashIndex > 0 && slashIndex < line.length - 1) {
        const word = line.slice(0, slashIndex).trim()
        const pronunciation = line.slice(slashIndex + 1).trim()
        return word && pronunciation ? `${word}/${pronunciation}` : ''
      }

      const [word, ...syllables] = line.split(/\s+/).filter(Boolean)
      if (
        !word ||
        syllables.length === 0 ||
        !syllables.every((part) => /^[a-züv]+[1-6]$/i.test(part))
      ) {
        return ''
      }
      return `${word}/${syllables.map((part) => `(${part})`).join('')}`
    })
    .filter(Boolean)
}

/** 请求体里只应出现真正偏离默认值的 voice_modify 字段。 */
export function voiceModifyOf(
  config: SpeechConfig
): { pitch: number; intensity: number; timbre: number; sound_effects?: string } | null {
  const hasSoundEffect = Boolean(config.soundEffects)
  if (
    !hasSoundEffect &&
    config.voicePitch === 0 &&
    config.voiceIntensity === 0 &&
    config.voiceTimbre === 0
  ) {
    return null
  }
  return {
    pitch: config.voicePitch,
    intensity: config.voiceIntensity,
    timbre: config.voiceTimbre,
    ...(hasSoundEffect ? { sound_effects: config.soundEffects } : {})
  }
}
