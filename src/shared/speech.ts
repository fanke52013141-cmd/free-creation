/**
 * 配音（speech）节点的「模型驱动」配置。
 *
 * 用户诉求（2026-09-18）：「它可以输入的内容很多，所以我们选择模型的不同，
 * 也决定了它的输入和输出的结构」。因此这里用 backend 明确声明本次合成走哪条
 * 供应商协议，节点端口（resolvePorts）与 UI 分组都由 backend 派生——不按上游
 * 节点标题或类型猜测输入，也不把某家供应商的参数悄悄塞进另一家的请求体。
 *
 *   minimax → MiniMax 异步语音合成 POST /v1/t2a_async_v2（配音节点的默认主通道）
 *   doubao  → 豆包语音合成 POST /api/v3/tts/create（seed-audio-1.0）
 *   volc    → 火山引擎语音合成 1.0 POST /api/v1/tts（大模型 HTTP 非流式，需 AppID + 集群）
 *   openai  → OpenAI 兼容 /audio/speech（保留的旧通道，不再作为默认）
 */

export type SpeechBackend = 'minimax' | 'doubao' | 'volc' | 'openai'

export type SpeechFormat = 'mp3' | 'wav' | 'pcm' | 'flac' | 'ogg_opus'

/** MiniMax voice_setting.emotion 的受支持取值；空串表示不指定，交给模型自判。 */
export type SpeechEmotion =
  '' | 'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised' | 'neutral'

export interface SpeechConfig {
  version: 1
  backend: SpeechBackend
  /** 供应商实例 ID（backend 对应的那家）。 */
  providerId: string
  /** 合成模型，例如 speech-2.8-hd / seed-audio-1.0。 */
  modelId: string

  // ── 音色（用户强调「音色、ID」是最重要的信息之一）──
  /** MiniMax voice_id / 豆包 speaker。可由上游「音色设计」节点的 JSON 输入覆盖。 */
  voiceId: string

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

  // ── 发音词典 pronunciation_dict.tone ──
  /** 每行一条「词 拼音」，执行时解析为 tone 数组；空串表示不传。 */
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

  // ── 豆包 audio_config ──
  /** 豆包 speech_rate，[-50, 100]。 */
  speechRate: number
  /** 豆包 loudness_rate，[-50, 100]。 */
  loudnessRate: number
  /** 豆包 pitch_rate，[-12, 12]。 */
  pitchRate: number
  /** 豆包 enable_subtitle：为真时节点额外产出 out-subtitle。 */
  enableSubtitle: boolean

  // ── 火山引擎语音合成 1.0（/api/v1/tts）──
  /**
   * 控制台应用 AppID。它与 access token 不是同一个东西：token 存在供应商实例里
   * （Authorization: Bearer;{token}），AppID 是请求体 app.appid，因此放在节点配置。
   */
  volcAppId: string
  /** 请求体 app.cluster；1.0 的普通音色与复刻音色走不同集群。 */
  volcCluster: string

  // ── 水印 ──
  aigcWatermark: boolean
}

export const SPEECH_BACKENDS: ReadonlyArray<{
  value: SpeechBackend
  label: string
  hint: string
}> = [
  {
    value: 'minimax',
    label: 'MiniMax · 异步语音合成',
    hint: 't2a_async_v2，支持语气词标签与完整音色参数；默认通道'
  },
  {
    value: 'doubao',
    label: '豆包语音 · seed-audio',
    hint: 'tts/create，可按需产出字幕时间轴；文本最长 3000 字'
  },
  {
    value: 'volc',
    label: '火山引擎 · 语音合成 1.0',
    hint: 'api/v1/tts 非流式，需要 AppID 与集群；单次文本最长 1024 字'
  },
  {
    value: 'openai',
    label: 'OpenAI 兼容 · /audio/speech',
    hint: '仅保留给已配置的兼容端点，不作为默认通道'
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
  { value: 'neutral', label: '中性' }
]

/** MiniMax language_boost 的常用取值；'auto' 为默认，其余按官方枚举收窄。 */
export const SPEECH_LANGUAGE_BOOSTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: '自动判别' },
  { value: 'Chinese', label: '中文' },
  { value: 'Chinese,Yue', label: '中文（粤语）' },
  { value: 'English', label: '英文' },
  { value: 'Japanese', label: '日语' },
  { value: 'Korean', label: '韩语' },
  { value: 'Spanish', label: '西语' },
  { value: 'French', label: '法语' },
  { value: 'German', label: '德语' },
  { value: 'Russian', label: '俄语' },
  { value: 'Portuguese', label: '葡语' },
  { value: 'Italian', label: '意语' },
  { value: 'Arabic', label: '阿语' },
  { value: 'Thai', label: '泰语' },
  { value: 'Vietnamese', label: '越南语' },
  { value: 'Indonesian', label: '印尼语' },
  { value: 'Turkish', label: '土耳其语' },
  { value: 'Hindi', label: '印地语' }
]

export const SPEECH_SOUND_EFFECTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '无' },
  { value: 'spacious_echo', label: '空旷回音' },
  { value: 'auditorium_echo', label: '礼堂回音' },
  { value: 'lofi_telephone', label: '电话音' },
  { value: 'robotic', label: '机器人' }
]

export const SPEECH_FORMATS: ReadonlyArray<SpeechFormat> = ['mp3', 'wav', 'pcm', 'flac', 'ogg_opus']

/** 采样率与码率都用受控档位，避免用户填出服务端必然拒绝的任意数字。 */
export const SPEECH_SAMPLE_RATES: ReadonlyArray<number> = [8000, 16000, 22050, 24000, 32000, 44100]
export const SPEECH_BITRATES: ReadonlyArray<number> = [32000, 64000, 128000, 256000]

/** 各协议实际接受的输出格式；节点 UI 与网关都必须按同一份真值收敛。 */
export const SPEECH_FORMATS_BY_BACKEND: Record<SpeechBackend, ReadonlyArray<SpeechFormat>> = {
  minimax: ['mp3', 'pcm', 'flac', 'wav'],
  doubao: ['mp3', 'wav', 'pcm', 'ogg_opus'],
  volc: ['mp3', 'wav', 'pcm', 'ogg_opus'],
  openai: ['mp3', 'wav', 'pcm', 'flac']
}

/**
 * 各协议实际会发送采样率的通道。1.0 的 /api/v1/tts 由音色决定输出规格，请求体里没有
 * 采样率字段，所以它的控件不能对 volc 呈现（§16.15 的判据：网关会发出去才显示）。
 */
export const SPEECH_SAMPLE_RATE_BACKENDS: ReadonlyArray<SpeechBackend> = ['minimax', 'doubao']

/** 火山 1.0 的 app.cluster 取值：普通大模型音色与声音复刻音色不在同一集群。 */
export const VOLC_CLUSTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'volcano_tts', label: 'volcano_tts（普通音色）' },
  { value: 'volcengine_tts', label: 'volcengine_tts（部分大模型/复刻音色）' }
]

/** 豆包 text_prompt 的上限；MiniMax 为 5 万字符。执行前按后端分别校验。 */
export const SPEECH_TEXT_LIMITS: Record<SpeechBackend, number> = {
  minimax: 50000,
  doubao: 3000,
  volc: 1024,
  openai: 4096
}

export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  version: 1,
  backend: 'minimax',
  providerId: '',
  modelId: 'speech-2.8-hd',
  voiceId: '',
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
  pronunciationTones: '',
  soundEffects: '',
  voicePitch: 0,
  voiceIntensity: 0,
  voiceTimbre: 0,
  speechRate: 0,
  loudnessRate: 0,
  pitchRate: 0,
  enableSubtitle: false,
  volcAppId: '',
  volcCluster: 'volcano_tts',
  aigcWatermark: false
}

const EMOTION_VALUES = new Set(SPEECH_EMOTIONS.map((item) => item.value))

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

function pickFormat(value: unknown, backend: SpeechBackend): SpeechFormat {
  const allowed = SPEECH_FORMATS_BY_BACKEND[backend]
  return allowed.includes(value as SpeechFormat) ? (value as SpeechFormat) : allowed[0]
}

/** 旧 speech 配置（{mode, modelKey, voice, format}）→ 新的模型驱动配置。 */
function migrateLegacy(raw: Record<string, unknown>): Partial<SpeechConfig> {
  const legacyKey = typeof raw.modelKey === 'string' ? raw.modelKey : ''
  const [providerId = '', modelId = ''] = legacyKey.split('::')
  const voice = typeof raw.voice === 'string' ? raw.voice : ''
  return {
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    // 旧通道就是 OpenAI 兼容端点；只有显式迁移过才保持 openai，避免把旧项目
    // 悄悄改成会向 MiniMax 发请求的配置。
    ...(legacyKey ? { backend: 'openai' as const } : {}),
    // alloy 等 OpenAI 命名音色在 MiniMax/豆包端不存在，不能原样带过去。
    ...(voice && voice !== 'alloy' ? { voiceId: voice } : {})
  }
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

  const legacy = raw.backend === undefined ? migrateLegacy(raw) : {}
  const merged = { ...raw, ...legacy }
  const backend: SpeechBackend =
    merged.backend === 'doubao'
      ? 'doubao'
      : merged.backend === 'volc'
        ? 'volc'
        : merged.backend === 'openai'
          ? 'openai'
          : 'minimax'
  const emotion = EMOTION_VALUES.has(merged.emotion as SpeechEmotion)
    ? (merged.emotion as SpeechEmotion)
    : ''

  return {
    version: 1,
    backend,
    providerId: typeof merged.providerId === 'string' ? merged.providerId : '',
    modelId:
      typeof merged.modelId === 'string' && merged.modelId
        ? merged.modelId
        : DEFAULT_SPEECH_CONFIG.modelId,
    voiceId: typeof merged.voiceId === 'string' ? merged.voiceId : '',
    speed: clamp(merged.speed, 0.5, 2, 1),
    volume: clamp(merged.volume, 0.1, 10, 1),
    pitch: clamp(merged.pitch, -12, 12, 0),
    emotion,
    englishNormalization: merged.englishNormalization === true,
    format: pickFormat(merged.format, backend),
    sampleRate: SPEECH_SAMPLE_RATES.includes(merged.sampleRate as number)
      ? (merged.sampleRate as number)
      : DEFAULT_SPEECH_CONFIG.sampleRate,
    bitrate: SPEECH_BITRATES.includes(merged.bitrate as number)
      ? (merged.bitrate as number)
      : DEFAULT_SPEECH_CONFIG.bitrate,
    audioChannel: merged.audioChannel === 2 ? 2 : 1,
    languageBoost:
      typeof merged.languageBoost === 'string' && merged.languageBoost
        ? merged.languageBoost
        : 'auto',
    pronunciationTones:
      typeof merged.pronunciationTones === 'string' ? merged.pronunciationTones : '',
    soundEffects: typeof merged.soundEffects === 'string' ? merged.soundEffects : '',
    voicePitch: clamp(merged.voicePitch, -100, 100, 0),
    voiceIntensity: clamp(merged.voiceIntensity, -100, 100, 0),
    voiceTimbre: clamp(merged.voiceTimbre, -100, 100, 0),
    speechRate: clamp(merged.speechRate, -50, 100, 0),
    loudnessRate: clamp(merged.loudnessRate, -50, 100, 0),
    pitchRate: clamp(merged.pitchRate, -12, 12, 0),
    enableSubtitle: merged.enableSubtitle === true,
    volcAppId: typeof merged.volcAppId === 'string' ? merged.volcAppId.trim() : '',
    volcCluster:
      typeof merged.volcCluster === 'string' && merged.volcCluster.trim()
        ? merged.volcCluster.trim()
        : DEFAULT_SPEECH_CONFIG.volcCluster,
    aigcWatermark: merged.aigcWatermark === true
  }
}

export function serializeSpeechConfig(config: SpeechConfig): string {
  return JSON.stringify(config)
}

/**
 * 发音词典：把「每行一条」的编辑体验解析为 MiniMax pronunciation_dict.tone 数组。
 *
 * 一条 tone 的形态是「词 + 逐字拼音」，因此合法行至少要有两段（词与一个拼音），
 * 多字词就是多段（如 `调音台 tiao2 yin1 tai2`）。只有一段的行是无拼音的坏数据，
 * 直接丢弃而不是发出去让服务端报错。
 */
export function parsePronunciationTones(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).filter(Boolean).join(' '))
    .filter((line) => line.split(' ').length >= 2)
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
