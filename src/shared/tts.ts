/** TTS 语音复刻节点配置：本地 ComfyUI 与 MiniMax 使用明确、互不混淆的后端。 */

/** IndexTTS-2.5 支持的合成语言；zhen 为中英混说自动判别。 */
export type TtsLang = 'zhen' | 'ZH' | 'EN' | 'JA' | 'ES' | 'AR'
export type TtsBackend = 'comfyui' | 'minimax'

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

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  version: 1,
  backend: 'comfyui',
  providerId: '',
  modelId: 'speech-2.8-turbo',
  voiceId: '',
  needNoiseReduction: false,
  needVolumeNormalization: false,
  aigcWatermark: false,
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
