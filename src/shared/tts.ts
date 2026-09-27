/** MiniMax 云端语音克隆节点配置。 */
import {
  MINIMAX_ASYNC_SPEECH_MODELS,
  SPEECH_LANGUAGE_BOOSTS,
  isSpeechLanguageBoostSupported
} from './speech'

export type TtsBackend = 'minimax'
/** MiniMax 异步语音合成输出格式。 */
export type TtsFormat = 'wav' | 'mp3' | 'flac' | 'pcm' | 'pcmu_raw' | 'pcmu_wav' | 'opus'

export const MINIMAX_VOICE_CLONE_MODELS: ReadonlyArray<string> = MINIMAX_ASYNC_SPEECH_MODELS

/** 克隆节点不指定 language_boost 时省略；其余枚举与异步 T2A 共用。 */
export const TTS_LANGUAGE_BOOSTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '不指定' },
  ...SPEECH_LANGUAGE_BOOSTS
]

export interface TtsConfig {
  featureKey?: string
  version: 1
  /** 音色克隆当前仅使用 MiniMax。 */
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
  /** MiniMax 参考音频原文校验，可选，最多 200 字；空串时不发送校验字段。 */
  textValidation: string
  /** 原文校验阈值，[0, 1]；仅在填写 textValidation 时生效。 */
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
/** 可选 clone_prompt 音频时长必须小于 8 秒。 */
export const MINIMAX_CLONE_PROMPT_MAX_SECONDS = 8
/** 复刻音色 7 天未调用会被服务端删除；UI 必须显式提示。 */
export const MINIMAX_CLONE_RETENTION_DAYS = 7

/**
 * 云端真正会落盘的格式取值域。UI 下拉与 `parseTtsConfig` 共用这一份，
 * 避免出现「下拉里根本没有、却仍是当前值」的格式。
 */
export const TTS_FORMATS_BY_BACKEND: Record<TtsBackend, ReadonlyArray<TtsFormat>> = {
  minimax: ['mp3', 'wav', 'pcm', 'flac', 'pcmu_raw', 'pcmu_wav', 'opus']
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
  textValidation: '',
  accuracy: 0.7,
  languageBoost: '',
  promptMediaId: '',
  promptMediaPath: '',
  promptMediaMime: '',
  promptMediaName: '',
  promptText: '',
  text: '',
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
    const backend: TtsBackend = 'minimax'
    const formats = TTS_FORMATS_BY_BACKEND.minimax
    const format: TtsFormat = formats.includes(raw.format as TtsFormat)
      ? (raw.format as TtsFormat)
      : formats[0]
    const modelId = typeof raw.modelId === 'string' && raw.modelId ? raw.modelId : 'speech-2.8-turbo'
    const languageBoost =
      TTS_LANGUAGE_BOOSTS.some((item) => item.value === raw.languageBoost) &&
      isSpeechLanguageBoostSupported(modelId, String(raw.languageBoost))
        ? (raw.languageBoost as string)
        : ''
    return {
      version: 1,
      backend,
      providerId: typeof raw.providerId === 'string' ? raw.providerId : '',
      modelId,
      voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : '',
      needNoiseReduction: raw.needNoiseReduction === true,
      needVolumeNormalization: raw.needVolumeNormalization === true,
      aigcWatermark: raw.aigcWatermark === true,
      textValidation: typeof raw.textValidation === 'string' ? raw.textValidation.slice(0, 200) : '',
      accuracy: clampNumber(raw.accuracy, 0, 1, 0.7),
      languageBoost,
      promptMediaId: typeof raw.promptMediaId === 'string' ? raw.promptMediaId : '',
      promptMediaPath: typeof raw.promptMediaPath === 'string' ? raw.promptMediaPath : '',
      promptMediaMime: typeof raw.promptMediaMime === 'string' ? raw.promptMediaMime : '',
      promptMediaName: typeof raw.promptMediaName === 'string' ? raw.promptMediaName : '',
      promptText: typeof raw.promptText === 'string' ? raw.promptText : '',
      text: typeof raw.text === 'string' ? raw.text : '',
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
