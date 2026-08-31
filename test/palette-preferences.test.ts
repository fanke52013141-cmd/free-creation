import { describe, expect, it } from 'vitest'
import {
  PALETTE_CATEGORY_IDS,
  defaultPalettePreferences,
  normalizePalettePreferences
} from '../src/shared/palette-preferences'
import { movePaletteCategory } from '../src/renderer/src/canvas/palette-categories'

describe('节点分类 Dock 偏好', () => {
  it('为缺失或损坏数据回退到完整默认分类', () => {
    expect(normalizePalettePreferences(null)).toEqual(defaultPalettePreferences())
    expect(normalizePalettePreferences({ order: 'not-an-array' })).toEqual(
      defaultPalettePreferences()
    )
  })

  it('保留有效的自定义排序与名称，并补回遗漏的稳定分类', () => {
    const result = normalizePalettePreferences({
      order: ['video', 'input', 'video', 'unknown'],
      labels: { video: '动态影像', input: '  素材入口  ', unknown: '忽略' }
    })
    expect(result.order.slice(0, 2)).toEqual(['video', 'input'])
    expect(result.order).toHaveLength(PALETTE_CATEGORY_IDS.length)
    expect(new Set(result.order).size).toBe(PALETTE_CATEGORY_IDS.length)
    expect(result.labels).toEqual({ video: '动态影像', input: '素材入口' })
  })

  it('拖动排序只移动分类键，不会生成或丢失分类', () => {
    const original = [...PALETTE_CATEGORY_IDS]
    const moved = movePaletteCategory(original, 'video', 'input')
    expect(moved.indexOf('video')).toBe(original.indexOf('input'))
    expect(new Set(moved)).toEqual(new Set(original))
    expect(movePaletteCategory(original, 'input', 'input')).toEqual(original)
  })
})
