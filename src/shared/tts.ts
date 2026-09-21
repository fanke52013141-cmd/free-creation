/** TTS 语音复刻节点配置：云端 MiniMax 是默认通道，本地 ComfyUI 保留为显式选项。 */

/** IndexTTS-2.5 支持的合成语言；zhen 为中英混说自动判别。 */
export type TtsLang = 'zhen' | 'ZH' | 'EN' | 'JA' | 'ES' | 'AR'
export type TtsBackend = 'comfyui' | 'minimax'
/** 输出音频格式；MiniMax 的 T2A 不产出 wav，取值域按后端划分。 */
export type TtsFormat = 'wav' | 'mp3' | 'flac'

/** MiniMax language_boost 在复刻链路里的常用取值；空串表示不传该字段。 */
export const TTS_LANGUAGE_BOOSTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '不指定' },
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
  { value: 'Arabic', label: '阿语' }
]

export interface TtsConfig {
  featureKey?: string
  version: 1
  /** MiniMax 快速复刻（默认，云端）或本地 ComfyUI IndexTTS；两者参数互不发送。 */
  backend: TtsBackend
  /** MiniMax 供应商 ID（backend=minimax 时必填）。 */
  providerId: string
  /** MiniMax 合成模型，例如 speech-2.8-turbo。 */
  modelId: string
  /** 可选自定义 Voice ID；留空时系统为本次复刻生成合法唯一 ID。 */
  voiceId: string
  /** MiniMax 复刻预处理与试听水印参数。 */
  needNoiseReduction: boolean
  needVolumeNormalization: boolean
  aigcWatermark: boolean
  /**
   * 复刻相似度，[0, 1]；越接近 1 越贴近原音，但更易放大底噪。
   * MiniMax 的 text_validation 是「参考音频原文」字符串（≤200 字），不是开关：
   * 实测发布尔值一律 2013 invalid params，所以这里没有对应的布尔配置项。
   */
  accuracy: number
  /** 语言增强（language_boost）；空串表示不传。 */
  languageBoost: string
  /** 克隆提示音在本地图库的 mediaId（可选；对应 clone_prompt.prompt_audio）。 */
  promptMediaId: string
  promptMediaPath: string
  promptMediaMime: string
  promptMediaName: string
  /** 克隆提示音对应的原文（对应 clone_prompt.prompt_text）。 */
  promptText: string
  /** 节点内编辑的合成文本；执行时与上游 in-text 输入合并。 */
  text: string
  /** 合成语言。 */
  lang: TtsLang
  /** 语速因子（IndexTTS duration_factor）：0.5（慢）～ 2.0（快）。 */
  speed: number
  /** 情绪强度（IndexTTS emo_alpha）：0 ～ 1。 */
  emotion: number
  /** 输出音频格式。 */
  format: TtsFormat
  /** 手动上传的参考语音在本地图库的 mediaId（由上游 in-audio 连线优先）。 */
  refMediaId: string
  /** 参考语音在本地图库的路径（渲染层播放用）。 */
  refMediaPath: string
  /** 参考语音的 MIME 类型。 */
  refMediaMime: string
  /** 参考语音的显示名称。 */
  refMediaName: string
}

export const TTS_LANGS: ReadonlyArray<{ value: TtsLang; label: string }> = [
  { value: 'zhen', label: '中英混说' },
  { value: 'ZH', label: '中文' },
  { value: 'EN', label: '英文' },
  { value: 'JA', label: '日语' },
  { value: 'ES', label: '西语' },
  { value: 'AR', label: '阿语' }
]

/** MiniMax 复刻参考音频的硬约束；UI 提示与主进程校验共用这一份真值。 */
export const MINIMAX_CLONE_MIMES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a'
]
export const MINIMAX_CLONE_MAX_BYTES = 20 * 1024 * 1024
export const MINIMAX_CLONE_MIN_SECONDS = 10
export const MINIMAX_CLONE_MAX_SECONDS = 5 * 60
/** 复刻音色 7 天未调用会被服务端删除；UI 必须显式提示。 */
export const MINIMAX_CLONE_RETENTION_DAYS = 7

/**
 * 每个后端真正会落盘的格式取值域。UI 下拉与 `parseTtsConfig` 共用这一份，
 * 避免出现「下拉里根本没有、却仍是当前值」的格式（MiniMax 的 T2A 不产出 wav）。
 */
export const TTS_FORMATS_BY_BACKEND: Record<TtsBackend, ReadonlyArray<TtsFormat>> = {
  minimax: ['mp3', 'flac'],
  comfyui: ['wav', 'mp3', 'flac']
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  version: 1,
  backend: 'minimax',
  providerId: '',
  modelId: 'speech-2.8-turbo',
  voiceId: '',
  needNoiseReduction: false,
  needVolumeNormalization: false,
  aigcWatermark: false,
  accuracy: 0.7,
  languageBoost: '',
  promptMediaId: '',
  promptMediaPath: '',
  promptMediaMime: '',
  promptMediaName: '',
  promptText: '',
  text: '',
  lang: 'zhen',
  speed: 1,
  emotion: 1,
  format: 'mp3',
  refMediaId: '',
  refMediaPath: '',
  refMediaMime: '',
  refMediaName: ''
}

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

export function parseTtsConfig(text: string): TtsConfig {
  try {
    const raw = JSON.parse(text) as Partial<TtsConfig>
    // 后端判定：显式取值永远优先；空对象是「什么都没配过」的新节点，走云端 MiniMax。
    // 有字段却没有 backend 的，是本地 IndexTTS 时期存下的配置，保持 comfyui——不把用户
    // 已有的节点悄悄换成按秒计费的云端调用。
    const backend: TtsBackend =
      raw.backend === 'minimax' || raw.backend === 'comfyui'
        ? raw.backend
        : Object.keys(raw).length === 0
          ? 'minimax'
          : 'comfyui'
    const lang = TTS_LANGS.some((item) => item.value === raw.lang) ? (raw.lang as TtsLang) : 'zhen'
    // 格式跟随后端的取值域：切到 MiniMax 后不再保留它发送不了的 wav。
    const formats = TTS_FORMATS_BY_BACKEND[backend]
    const format: TtsFormat = formats.includes(raw.format as TtsFormat)
      ? (raw.format as TtsFormat)
      : formats[0]
    return {
      version: 1,
      backend,
      providerId: typeof raw.providerId === 'string' ? raw.providerId : '',
      modelId: typeof raw.modelId === 'string' && raw.modelId ? raw.modelId : 'speech-2.8-turbo',
      voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : '',
      needNoiseReduction: raw.needNoiseReduction === true,
      needVolumeNormalization: raw.needVolumeNormalization === true,
      aigcWatermark: raw.aigcWatermark === true,
      accuracy: clampNumber(raw.accuracy, 0, 1, 0.7),
      languageBoost: typeof raw.languageBoost === 'string' ? raw.languageBoost : '',
      promptMediaId: typeof raw.promptMediaId === 'string' ? raw.promptMediaId : '',
      promptMediaPath: typeof raw.promptMediaPath === 'string' ? raw.promptMediaPath : '',
      promptMediaMime: typeof raw.promptMediaMime === 'string' ? raw.promptMediaMime : '',
      promptMediaName: typeof raw.promptMediaName === 'string' ? raw.promptMediaName : '',
      promptText: typeof raw.promptText === 'string' ? raw.promptText : '',
      text: typeof raw.text === 'string' ? raw.text : '',
      lang,
      speed: clampNumber(raw.speed, 0.5, 2, 1),
      emotion: clampNumber(raw.emotion, 0, 1, 1),
      format,
      refMediaId: typeof raw.refMediaId === 'string' ? raw.refMediaId : '',
      refMediaPath: typeof raw.refMediaPath === 'string' ? raw.refMediaPath : '',
      refMediaMime: typeof raw.refMediaMime === 'string' ? raw.refMediaMime : '',
      refMediaName: typeof raw.refMediaName === 'string' ? raw.refMediaName : ''
    }
  } catch {
    return { ...DEFAULT_TTS_CONFIG }
  }
}

export function serializeTtsConfig(config: TtsConfig): string {
  return JSON.stringify(config)
}

/**
 * MiniMax voice_id 合法性：长度 [8,256]、首字符为字母、只允许数字/字母/-/_、
 * 末位不能是 - 或 _。UI 据此给出即时提示，主进程据此拒绝非法自定义 ID——
 * 两处共用同一份判定，不允许各写一套正则。
 */
export function isValidMiniMaxVoiceId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(value)
}

/** 把任意用户输入规整为合法 voice_id；无法规整时返回空串，由调用方决定兜底。 */
export function normalizeMiniMaxVoiceId(raw: string): string {
  const compact = raw.trim().replace(/[^A-Za-z0-9_-]/g, '-')
  return isValidMiniMaxVoiceId(compact) ? compact : ''
}
