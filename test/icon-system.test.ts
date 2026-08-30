import { describe, expect, it } from 'vitest'
import { ICON_NAMES } from '../src/renderer/src/components/Icon'

describe('UI 图标系统', () => {
  it('保留每个节点类别和多选操作需要的统一图标', () => {
    const icons = new Set(ICON_NAMES)

    for (const name of [
      'text',
      'image',
      'image-gen',
      'crop',
      'edit',
      'video',
      'frame',
      'clip',
      'audio',
      'chat',
      'script',
      'processor',
      'json',
      'code',
      'storyboard',
      'director',
      'upload',
      'assets',
      'workflow',
      'history',
      'settings',
      'home',
      'align-left',
      'align-right',
      'align-horizontal',
      'align-vertical',
      'distribute-horizontal',
      'distribute-vertical',
      'group'
    ]) {
      expect(icons.has(name as (typeof ICON_NAMES)[number])).toBe(true)
    }
  })

  it('不允许图标注册表出现重复名称', () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length)
  })
})
