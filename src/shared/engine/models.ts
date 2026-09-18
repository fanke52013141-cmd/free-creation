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

/**
 * 生图节点共享的模型解析（renderer Body 与执行器使用同一套默认值逻辑）：
 * modelKey 显式命中 > providerKey 供应商的首个图片模型 > 默认供应商（ToAPIS 优先）。
 * `fallbackToDefault: false` 时只做显式 modelKey 命中（执行器用，保持既有跳过语义）。
 */
export function resolveImageModelOption(
  options: ModelOption[],
  config: { modelKey?: string; providerKey?: string },
  { fallbackToDefault = true }: { fallbackToDefault?: boolean } = {}
): ModelOption | undefined {
  if (config.modelKey) {
    const found = options.find((item) => item.key === config.modelKey)
    if (found) return found
  }
  if (!fallbackToDefault) return undefined
  if (config.providerKey) {
    const byProvider = options.find((item) => item.provider.id === config.providerKey)
    if (byProvider) return byProvider
  }
  const preferred = options.find(
    (item) =>
      item.provider.specId === 'toapis' ||
      item.provider.name.toLowerCase().includes('toapis') ||
      item.provider.id.toLowerCase().includes('toapis') ||
      item.model.id.toLowerCase().includes('gpt-image-2') ||
      item.model.id.toLowerCase().includes('image-2')
  )
  return preferred ?? options[0]
}

/** 生图供应商下拉的默认选中：ToAPIS 实例优先，其次第一个含图片模型的供应商。 */
export function defaultImageProviderId(options: ModelOption[]): string | undefined {
  return resolveImageModelOption(options, {})?.provider.id
}
