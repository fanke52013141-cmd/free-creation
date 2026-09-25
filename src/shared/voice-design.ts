/**
 * 音色设计（voice-design）节点配置。
 *
 * 对应 MiniMax POST /v1/voice_design：用一段自然语言描述凭空设计音色，
 * 返回 voice_id 与一段 hex 编码的试听音频。接口只接受 prompt / preview_text /
 * voice_id / aigc_watermark 四个字段，因此这里不臆造 model 等未文档化参数——
 * 供应商实例只用于提供 Base URL 与密钥。
 */

export interface VoiceDesignConfig {
  featureKey?: string
  version: 1
  /** MiniMax 供应商实例 ID。 */
  providerId: string
  /** 内部模型网关能力路由所需；MiniMax voice_design 请求体不发送此字段。 */
  modelId: string
  /** 试听文本，≤500 字符；决定试听音频读什么。 */
  previewText: string
  /** 可选自定义 voice_id；留空时由服务端生成。 */
  voiceId: string
  aigcWatermark: boolean
}

/** 服务端对 preview_text 的硬上限。 */
export const VOICE_DESIGN_PREVIEW_LIMIT = 500

export const DEFAULT_VOICE_DESIGN_CONFIG: VoiceDesignConfig = {
  version: 1,
  providerId: '',
  modelId: '',
  previewText: '你好，很高兴认识你。',
  voiceId: '',
  aigcWatermark: false
}

export function parseVoiceDesignConfig(text: string): VoiceDesignConfig {
  try {
    const raw = JSON.parse(text) as Partial<VoiceDesignConfig>
    const previewText =
      typeof raw.previewText === 'string'
        ? raw.previewText.slice(0, VOICE_DESIGN_PREVIEW_LIMIT)
        : DEFAULT_VOICE_DESIGN_CONFIG.previewText
    return {
      version: 1,
      providerId: typeof raw.providerId === 'string' ? raw.providerId : '',
      modelId: typeof raw.modelId === 'string' ? raw.modelId : '',
      previewText,
      voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : '',
      aigcWatermark: raw.aigcWatermark === true
    }
  } catch {
    return { ...DEFAULT_VOICE_DESIGN_CONFIG }
  }
}

export function serializeVoiceDesignConfig(config: VoiceDesignConfig): string {
  return JSON.stringify(config)
}

/**
 * 音色档案：音色设计/复刻节点的 out-json 载荷，也是配音节点 in-voice 的输入。
 * 只携带可追溯的标识与来源，不把音频二进制塞进 JSON 数据流。
 */
export interface VoiceProfile {
  voice_id: string
  /** 产出该音色的供应商 spec（minimax 等）。 */
  provider?: string
  /** 产出该音色的模型或接口名。 */
  source?: string
  /** 人类可读的音色描述/名称。 */
  label?: string
  /** 试听音频在本地图库中的 mediaId（如有）。 */
  preview_media_id?: string
}

export function parseVoiceProfile(value: unknown): VoiceProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const voiceId = typeof data.voice_id === 'string' ? data.voice_id.trim() : ''
  if (!voiceId) return null
  return {
    voice_id: voiceId,
    ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
    ...(typeof data.source === 'string' ? { source: data.source } : {}),
    ...(typeof data.label === 'string' ? { label: data.label } : {}),
    ...(typeof data.preview_media_id === 'string'
      ? { preview_media_id: data.preview_media_id }
      : {})
  }
}
