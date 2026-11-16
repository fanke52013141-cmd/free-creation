// 生图节点供应商/模型选择记忆：用户在某个生图节点切换供应商/模型后，
// 后续新建的生图节点默认沿用该选择（用户裁决 2026-11-16）。
// 仅影响新建节点的初始配置，不回写任何已有节点。
import type { ProviderSummary } from '@shared/types'
import { modelsByModality } from '@shared/engine/models'

const STORAGE_KEY = 'canvas.image-gen.last-selection'

export interface ImageGenSelection {
  providerKey: string
  modelKey: string
}

export function rememberImageGenSelection(selection: ImageGenSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection))
  } catch {
    /* 存储不可用时静默降级为默认供应商 */
  }
}

export function readImageGenSelection(): ImageGenSelection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<ImageGenSelection> | null
    return typeof value?.providerKey === 'string' && typeof value?.modelKey === 'string'
      ? { providerKey: value.providerKey, modelKey: value.modelKey }
      : null
  } catch {
    return null
  }
}

/** 新建生图节点的初始配置；记忆的供应商/模型已不在目录时回退默认（返回 undefined）。 */
export function imageGenInitialConfig(providers: ProviderSummary[]): string | undefined {
  const selection = readImageGenSelection()
  if (!selection) return undefined
  const hit = modelsByModality(providers, 'image').find(
    (option) => option.provider.id === selection.providerKey && option.key === selection.modelKey
  )
  if (!hit) return undefined
  return JSON.stringify({ providerKey: selection.providerKey, modelKey: selection.modelKey })
}