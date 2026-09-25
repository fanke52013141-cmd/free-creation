// 供应商协议驱动是「网关走哪条链路」与「设置面板显示哪种自检」的唯一真值。
// 此前它只写在主进程 factory 里，渲染层要判断该不该展示协议自检只能再按 specId
// 猜一遍——两份判定早晚会对不上。
import type { ModelModality, ProviderSpecId } from './types'

export type ProviderDriver = 'openai-compatible' | 'video' | 'native-speech'

export function driverForSpec(specId: ProviderSpecId): ProviderDriver {
  if (specId === 'minimax' || specId === 'seedance') return 'video'
  if (specId === 'volc-speech') return 'native-speech'
  return 'openai-compatible'
}

/** 模型 ID 里出现这些词就是语音模型：各家命名都覆盖了，且与供应商无关。 */
const SPEECH_MODEL_ID_RE = /(speech|tts|voice|audio)/i
const IMAGE_MODEL_ID_RE = /(image|dall|flux|seedream|mj|midjourney|banana)/i
/** MiniMax 的视频产品线：H3 之外还有历史型号 hailuo / T2V-01 / I2V-01 / S2V-01。 */
const MINIMAX_VIDEO_ID_RE = /(h3|hailuo|t2v|i2v|s2v|v2v|video|director)/i
/** 同一个 Key 也能调 MiniMax 的大模型：M2 / M1 / Text-01 / abab，它们不是视频模型。 */
const MINIMAX_LLM_ID_RE = /(^|[^a-z])m[12]([^a-z]|$)|abab|minimax-(text|character)/i

/**
 * 新建供应商时给建议模型ID猜模态；用户可在面板里逐行改。
 * 语音节点只列 audio 模型，所以猜错模态等于该模型在节点里选不到。
 */
export function guessModelModality(id: string, specId: ProviderSpecId): ModelModality {
  // 火山语音合成使用 /api/v3/tts/create，模型 ID 形如 seed-audio-1.0，
  // 不能仅靠一般的模型名正则推断模态。
  if (specId === 'volc-speech') return 'audio'
  // 方舟的接入点 ID 形如 ep-2025xxxx-xxxx，没有任何可辨认的词汇，只能整家按视频建模；
  // 要文本模型请建「豆包（方舟）」模板。
  if (specId === 'seedance') return 'video'
  if (specId === 'toapis') return 'image'
  if (specId === 'minimax') {
    // MiniMax 一个供应商同时挂视频、语音和大模型，而它没有 /models 端点，模态只能按 ID
    // 猜。原先「不是语音就算视频」，于是用户手动补一行 MiniMax-M2 就会凭空出现在视频
    // 下拉里。认不出型号时仍然兜底成视频：新发布的 H 系列不该因为我们这份表落后就选不到。
    if (SPEECH_MODEL_ID_RE.test(id)) return 'audio'
    if (IMAGE_MODEL_ID_RE.test(id)) return 'image'
    if (MINIMAX_VIDEO_ID_RE.test(id)) return 'video'
    if (MINIMAX_LLM_ID_RE.test(id)) return 'text'
    return 'video'
  }
  if (SPEECH_MODEL_ID_RE.test(id)) return 'audio'
  if (IMAGE_MODEL_ID_RE.test(id)) return 'image'
  return 'text'
}
