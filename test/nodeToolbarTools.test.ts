// @vitest-environment jsdom
// 悬浮工具栏自定义配置（借鉴 infinite-atelier 的 localStorage ids+showLabels 机制）
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_IDS,
  readToolbarConfig,
  TOOLBAR_CONFIG_STORAGE_KEY,
  TOOLBAR_TOOLS,
  writeToolbarConfig
} from '@renderer/canvas/node-toolbar/nodeToolbarTools'

describe('nodeToolbarTools 配置读写', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('未存储时返回默认配置（默认可见工具，不显示文字标签）', () => {
    const config = readToolbarConfig()
    expect(config.ids).toEqual(DEFAULT_TOOL_IDS)
    expect(config.showLabels).toBe(false)
  })

  it('写入后可读回，往返一致', () => {
    writeToolbarConfig({ ids: ['view', 'crop'], showLabels: true })
    expect(readToolbarConfig()).toEqual({ ids: ['view', 'crop'], showLabels: true })
  })

  it('损坏的 JSON 回退默认配置', () => {
    window.localStorage.setItem(TOOLBAR_CONFIG_STORAGE_KEY, '{oops')
    expect(readToolbarConfig().ids).toEqual(DEFAULT_TOOL_IDS)
  })

  it('过滤未知工具 id，防止手改 localStorage 注入不存在的按钮', () => {
    window.localStorage.setItem(
      TOOLBAR_CONFIG_STORAGE_KEY,
      JSON.stringify({ ids: ['view', 'hacker-tool'], showLabels: false })
    )
    expect(readToolbarConfig().ids).toEqual(['view'])
  })

  it('全空配置回退默认，避免工具栏被配置成空且无法打开设置', () => {
    window.localStorage.setItem(
      TOOLBAR_CONFIG_STORAGE_KEY,
      JSON.stringify({ ids: [], showLabels: false })
    )
    expect(readToolbarConfig().ids).toEqual(DEFAULT_TOOL_IDS)
  })
})

describe('TOOLBAR_TOOLS 定义完整性', () => {
  it('id 唯一，且默认配置里的 id 都在定义表中', () => {
    const ids = TOOLBAR_TOOLS.map((tool) => tool.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of DEFAULT_TOOL_IDS) {
      expect(ids).toContain(id)
    }
  })

  it('label/title/icon 均非空（工具栏按钮渲染依赖）', () => {
    for (const tool of TOOLBAR_TOOLS) {
      expect(tool.label.trim()).not.toBe('')
      expect(tool.title.trim()).not.toBe('')
      expect(tool.icon.trim()).not.toBe('')
    }
  })
})
