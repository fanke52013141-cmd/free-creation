/** TTS 语音复刻节点配置：本地 ComfyUI 与 MiniMax 使用明确、互不混淆的后端。 */

/** IndexTTS-2.5 支持的合成语言；zhen 为中英混说自动判别。 */
export type TtsLang = 'zhen' | 'ZH' | 'EN' | 'JA' | 'ES' | 'AR'
export type TtsBackend = 'comfyui' | 'minimax'

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
  version: 1
  /** 本地 IndexTTS 或 MiniMax 快速复刻；默认保留本地路径。 */
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
   * MiniMax 复刻的文本校验开关（文档字段 text_validation）：
   * 打开后服务端会校验复刻文本与参考音频的一致性，失败即拒绝登记音色。
   */
  textValidation: boolean
  /** 复刻相似度，[0, 1]；越接近 1 越贴近原音，但更易放大底噪。 */
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
  format: 'wav' | 'mp3' | 'flac'
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

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  version: 1,
  backend: 'comfyui',
  providerId: '',
  modelId: 'speech-2.8-turbo',
  voiceId: '',
  needNoiseReduction: false,
  needVolumeNormalization: false,
  aigcWatermark: false,
  textValidation: false,
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
  format: 'wav',
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
    const lang = TTS_LANGS.some((item) => item.value === raw.lang) ? (raw.lang as TtsLang) : 'zhen'
    const format =
      raw.format === 'mp3' || raw.format === 'flac' ? (raw.format as TtsConfig['format']) : 'wav'
    return {
      version: 1,
      backend: raw.backend === 'minimax' ? 'minimax' : 'comfyui',
      providerId: typeof raw.providerId === 'string' ? raw.providerId : '',
      modelId: typeof raw.modelId === 'string' && raw.modelId ? raw.modelId : 'speech-2.8-turbo',
      voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : '',
      needNoiseReduction: raw.needNoiseReduction === true,
      needVolumeNormalization: raw.needVolumeNormalization === true,
      aigcWatermark: raw.aigcWatermark === true,
      textValidation: raw.textValidation === true,
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
