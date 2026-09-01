// 模型查找辅助（从 renderer/stores/gateway.ts 抽出的纯函数部分）
//
// zustand store（useGatewayStore）依赖 renderer 的 window.api，留在 renderer 层。
import type { GatewayModelInfo, ModelModality, ProviderSummary } from '../types'

export interface ModelOption {
  provider: ProviderSummary
  model: GatewayModelInfo
  /** `${provider.id}::${model.id}`，节点参数里持久化的选择键 */
  key: string
  label: string
}

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
  fallback = false
): ModelOption | undefined {
  const textModels = modelsByModality(providers, 'text')
  if (modelKey) {
    const found = textModels.find((m) => m.key === modelKey)
    if (found) return found
  }
  return fallback ? textModels[0] : undefined
}
