// 供应商协议驱动是「网关走哪条链路」与「设置面板显示哪种自检」的唯一真值。
// 此前它只写在主进程 factory 里，渲染层要判断该不该展示协议自检只能再按 specId
// 猜一遍——两份判定早晚会对不上。
import type { ProviderSpecId } from './types'

export type ProviderDriver = 'openai-compatible' | 'video' | 'native-speech'

export function driverForSpec(specId: ProviderSpecId): ProviderDriver {
  if (specId === 'minimax' || specId === 'seedance') return 'video'
  if (specId === 'doubao-speech') return 'native-speech'
  return 'openai-compatible'
}
