// 模型网关渲染端状态：供应商配置缓存 + 设置面板开关
import { create } from 'zustand'
import type { GatewayModelInfo, ModelModality, ProviderSummary } from '@shared/types'
import { guessModelModality } from '@shared/provider-driver'
import type { FeatureBinding } from '@free-creation/model-contracts'

export interface ModelOption {
  provider: ProviderSummary
  model: GatewayModelInfo
  /** `${provider.id}::${model.id}`，节点参数里持久化的选择键 */
  key: string
  label: string
}

interface GatewayState {
  providers: ProviderSummary[]
  modelBindings: FeatureBinding[]
  loaded: boolean
  settingsOpen: boolean
  catalogOpen: boolean
  load: () => Promise<void>
  openSettings: () => void
  closeSettings: () => void
  openCatalog: () => void
  closeCatalog: () => void
}

// 首屏 N 个模型节点同时看到 loaded=false 会各自调用 load()，
// 造成 N 对 listProviders+listBindings IPC 并发。共享同一个在途 Promise 去重。
let loadInFlight: Promise<void> | null = null

export const useGatewayStore = create<GatewayState>((set, get) => ({
  providers: [],
  modelBindings: [],
  loaded: false,
  settingsOpen: false,
  catalogOpen: false,
  load: () => {
    // 已加载后的显式刷新（如保存供应商后）仍发起新请求；只合并首次加载风暴。
    if (loadInFlight && !get().loaded) return loadInFlight
    const run = async (): Promise<void> => {
      // The provider manager saves legacy-compatible providers. Nodes must immediately see
      // those saved models so users can select one; a selected model is still checked by the
      // real provider request rather than being silently treated as absent.
      const res = await window.api.gateway.listProviders()
      let modelBindings: FeatureBinding[] = []
      if (window.api.models?.listBindings) {
        const bindings = await window.api.models.listBindings()
        if (bindings.ok) modelBindings = bindings.data
      }
      if (res.ok) set({ providers: res.data, modelBindings, loaded: true })
    }
    loadInFlight = run().finally(() => {
      loadInFlight = null
    })
    return loadInFlight
  },
  // The compatibility panel keeps the original provider setup flow available.
  openSettings: () => set({ settingsOpen: true, catalogOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  // The model catalog owns capability verification used by the new node selectors.
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
      // 兼容早期 OpenRouter 配置：当时设置页把所有模型强制写成 image。按模型 ID
      // 重新识别文本条目，让既有文本模型立刻能在对话/AI 处理节点选择，无需重建供应商。
      const isLegacyOpenRouterText =
        modality === 'text' &&
        p.specId === 'openrouter' &&
        m.modality === 'image' &&
        guessModelModality(m.id, p.specId) === 'text'
      if (m.modality !== modality && !isLegacyOpenRouterText) continue
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
