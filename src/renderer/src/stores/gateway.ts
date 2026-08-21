// 模型网关渲染端状态：供应商配置缓存 + 设置面板开关
import { create } from 'zustand'
import type { GatewayModelInfo, ModelModality, ProviderConfig } from '@shared/types'

export interface ModelOption {
  provider: ProviderConfig
  model: GatewayModelInfo
  /** `${provider.id}::${model.id}`，节点参数里持久化的选择键 */
  key: string
  label: string
}

interface GatewayState {
  providers: ProviderConfig[]
  loaded: boolean
  settingsOpen: boolean
  load: () => Promise<void>
  openSettings: () => void
  closeSettings: () => void
}

export const useGatewayStore = create<GatewayState>((set) => ({
  providers: [],
  loaded: false,
  settingsOpen: false,
  load: async () => {
    const res = await window.api.gateway.listProviders()
    if (res.ok) set({ providers: res.data, loaded: true })
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false })
}))

/** 全部供应商里指定模态的模型，展平成下拉选项 */
export function modelsByModality(
  providers: ProviderConfig[],
  modality: ModelModality
): ModelOption[] {
  const out: ModelOption[] = []
  for (const p of providers) {
    for (const m of p.models) {
      if (m.modality !== modality) continue
      out.push({
        provider: p,
        model: m,
        key: `${p.id}::${m.id}`,
        label: `${p.name} · ${m.name || m.id}`
      })
    }
  }
  return out
}

export function findProvider(
  providers: ProviderConfig[],
  providerId: string
): ProviderConfig | undefined {
  return providers.find((p) => p.id === providerId)
}
