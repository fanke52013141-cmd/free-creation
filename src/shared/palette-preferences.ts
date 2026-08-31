/**
 * 左侧节点分类 Dock 的本机偏好。
 *
 * 这些 ID 是稳定的 UI 分类键，不是节点协议的一部分；用户只能调整顺序和显示名，
 * 不会改变 NodeTypeSpec.category、节点类型或已有画布连线。
 */
export const NODE_CATEGORY_IDS = ['input', 'image', 'video', 'audio', 'logic'] as const

export type NodeCategoryId = (typeof NODE_CATEGORY_IDS)[number]

export const PALETTE_CATEGORY_IDS = ['favorites', ...NODE_CATEGORY_IDS] as const

export type PaletteCategoryId = (typeof PALETTE_CATEGORY_IDS)[number]

export interface PalettePreferences {
  /** 一级分类 Dock 的显示顺序。 */
  order: PaletteCategoryId[]
  /** 可选的本机显示名覆盖；缺失时由 UI 提供默认名称。 */
  labels: Partial<Record<PaletteCategoryId, string>>
}

export function defaultPalettePreferences(): PalettePreferences {
  return { order: [...PALETTE_CATEGORY_IDS], labels: {} }
}

function isPaletteCategoryId(value: unknown): value is PaletteCategoryId {
  return typeof value === 'string' && PALETTE_CATEGORY_IDS.includes(value as PaletteCategoryId)
}

/**
 * 对从 SQLite 读出的偏好做白名单归一化。旧版本、损坏数据或未来版本中的未知分类
 * 都不会使 Dock 消失；所有当前分类都会恰好出现一次。
 */
export function normalizePalettePreferences(value: unknown): PalettePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return defaultPalettePreferences()
  const raw = value as { order?: unknown; labels?: unknown }
  const seen = new Set<PaletteCategoryId>()
  const order = Array.isArray(raw.order)
    ? raw.order.filter(isPaletteCategoryId).filter((id) => {
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
    : []
  for (const id of PALETTE_CATEGORY_IDS) {
    if (!seen.has(id)) order.push(id)
  }

  const labels: Partial<Record<PaletteCategoryId, string>> = {}
  if (raw.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)) {
    for (const id of PALETTE_CATEGORY_IDS) {
      const label = (raw.labels as Record<string, unknown>)[id]
      if (typeof label === 'string') {
        const normalized = label.trim().slice(0, 16)
        if (normalized) labels[id] = normalized
      }
    }
  }
  return { order, labels }
}
