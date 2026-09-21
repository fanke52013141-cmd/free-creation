// 模型网关渲染端状态：供应商配置缓存 + 设置面板开关
import { create } from 'zustand'
import type { GatewayModelInfo, ModelModality, ProviderSummary } from '@shared/types'

export interface ModelOption {
  provider: ProviderSummary
  model: GatewayModelInfo
  /** `${provider.id}::${model.id}`，节点参数里持久化的选择键 */
  key: string
  label: string
}

interface GatewayState {
  providers: ProviderSummary[]
  loaded: boolean
  settingsOpen: boolean
  catalogOpen: boolean
  load: () => Promise<void>
  openSettings: () => void
  closeSettings: () => void
  openCatalog: () => void
  closeCatalog: () => void
}

export const useGatewayStore = create<GatewayState>((set) => ({
  providers: [],
  loaded: false,
  settingsOpen: false,
  catalogOpen: false,
  load: async () => {
    const res = await window.api.gateway.listExecutableProviders()
    if (res.ok) set({ providers: res.data, loaded: true })
  },
  // 模型目录是唯一可调用模型的配置入口。旧 providers 表不参与已验证模型解析，
  // 因此不能再把节点的“配置模型”按钮带到旧表单，避免出现“已填写却不可调用”。
  openSettings: () => set({ settingsOpen: false, catalogOpen: true }),
  closeSettings: () => set({ settingsOpen: false })
  ,
  openCatalog: () => set({ settingsOpen: false, catalogOpen: true }),
  closeCatalog: () => set({ catalogOpen: false })
}))

/** 全部供应商里指定模态的模型，展平成下拉选项 */
export function modelsByModality(
  providers: ProviderSummary[],
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
  providers: ProviderSummary[],
  providerId: string
): ProviderSummary | undefined {
  return providers.find((p) => p.id === providerId)
}

/** 按 modelKey 查找文本模型，支持回退到第一个可用文本模型 */
export function findTextModel(
  providers: ProviderSummary[],
  modelKey: string,
  fallback: boolean
): ModelOption | undefined {
  const textModels = modelsByModality(providers, 'text')
  if (modelKey) {
    const found = textModels.find((m) => m.key === modelKey)
    if (found) return found
  }
  return fallback ? textModels[0] : undefined
}
