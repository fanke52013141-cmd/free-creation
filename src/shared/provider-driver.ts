// 供应商协议驱动是「网关走哪条链路」与「设置面板显示哪种自检」的唯一真值。
// 此前它只写在主进程 factory 里，渲染层要判断该不该展示协议自检只能再按 specId
// 猜一遍——两份判定早晚会对不上。
import type { ModelModality, ProviderSpecId } from './types'

export type ProviderDriver = 'openai-compatible' | 'video' | 'native-speech'

export function driverForSpec(specId: ProviderSpecId): ProviderDriver {
  if (specId === 'minimax' || specId === 'seedance') return 'video'
  if (specId === 'doubao-speech') return 'native-speech'
  return 'openai-compatible'
}

/** 模型 ID 里出现这些词就是语音模型：各家命名都覆盖了，且与供应商无关。 */
const SPEECH_MODEL_ID_RE = /(speech|tts|voice|audio)/i

/**
 * 新建供应商时给建议模型ID猜模态；用户可在面板里逐行改。
 * 语音节点只列 audio 模型，所以猜错模态等于该模型在节点里选不到。
 */
export function guessModelModality(id: string, specId: ProviderSpecId): ModelModality {
  // 豆包语音（Seed-Audio）与火山语音合成 1.0 共用这一个供应商实例，它没有文本
  // 模型；ID 形如 seed-audio-1.0 或音色名，只靠下面的正则会猜成 text。
  if (specId === 'doubao-speech') return 'audio'
  if (specId === 'seedance') return 'video'
  if (specId === 'toapis') return 'image'
  if (specId === 'minimax') return SPEECH_MODEL_ID_RE.test(id) ? 'audio' : 'video'
  if (SPEECH_MODEL_ID_RE.test(id)) return 'audio'
  if (/(image|dall|flux|seedream|mj|midjourney|banana)/i.test(id)) return 'image'
  return 'text'
}
