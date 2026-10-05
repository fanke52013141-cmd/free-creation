import { describe, expect, it } from 'vitest'
import { PALETTE_NODE_GROUPS, sortPaletteNodes } from '../src/shared/palette-menu-order'
import {
  defaultPalettePreferences,
  normalizePalettePreferences
} from '../src/shared/palette-preferences'

describe('统一菜单排序', () => {
  it('完整覆盖 28 个节点且没有重复', () => {
    const types = Object.values(PALETTE_NODE_GROUPS).flat()
    expect(types).toHaveLength(28)
    expect(new Set(types).size).toBe(28)
  })
  it('排序保留同类型不同端口及未知节点，不修改原数组', () => {
    const nodes = [
      { type: 'text' },
      { type: 'image-gen', port: 'a' },
      { type: 'future' },
      { type: 'image-gen', port: 'b' }
    ]
    expect(sortPaletteNodes(nodes)).toEqual([nodes[1], nodes[3], nodes[0], nodes[2]])
    expect(nodes[0].type).toBe('text')
  })
  it('使用新默认顺序，保留已有有效自定义顺序', () => {
    expect(defaultPalettePreferences().order).toEqual(['image', 'input', 'video', 'audio', 'logic'])
    expect(normalizePalettePreferences({ order: ['audio', 'input'] }).order).toEqual([
      'audio',
      'input',
      'image',
      'video',
      'logic'
    ])
  })
})
