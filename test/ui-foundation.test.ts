import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const foundation = readFileSync(resolve(root, 'src/renderer/src/assets/ui-foundation.css'), 'utf8')
const legacy = readFileSync(resolve(root, 'src/renderer/src/assets/app.css'), 'utf8')

describe('统一画布视觉基础', () => {
  it('连线和端口只保留低噪声的基础样式来源', () => {
    expect(foundation).toContain('.conn-main-path')
    expect(foundation).toContain('.port-dot')
    expect(foundation).toMatch(/stroke-dasharray\s*:\s*7\s+7/)
    expect(legacy).not.toContain('.conn-main-path')
    expect(legacy).not.toContain('.conn-glow-path')
  })

  it('常用下拉框与悬浮提示有统一组件样式', () => {
    expect(foundation).toContain('.app-select')
    expect(
      readFileSync(resolve(root, 'src/renderer/src/assets/ui-surfaces.css'), 'utf8')
    ).toContain('.app-tooltip')
  })

  it('节点卡片与端口点是磨砂玻璃材质（半透明底 + backdrop 模糊 + 内高光）', () => {
    // 卡片：不再是不透明色块；透出画布网格与背后内容。
    expect(foundation).toMatch(/\.node-card\s*\{[\s\S]*?backdrop-filter:\s*blur\(14px\)/)
    expect(foundation).toMatch(/\.node-card\s*\{[\s\S]*?inset 0 1px 0 rgba\(255, 255, 255, 0\.07\)/)
    expect(foundation).not.toMatch(/\.node-card\s*\{[^}]*background:\s*var\(--card\);/)
    // 端口：18px 命中区不变，视觉收缩为 10px 玻璃珠（::after），不再是大号虚线圈。
    expect(foundation).toMatch(/\.port-dot::after\s*\{[\s\S]*?width:\s*10px;/)
    expect(foundation).toMatch(/\.port-dot::after\s*\{[\s\S]*?backdrop-filter:\s*blur\(5px\)/)
    expect(foundation).not.toMatch(/\.port-dot\s*\{[\s\S]*?border:\s*2px dashed/)
    // 拖线光标是镜面玻璃珠：端口色底 + 径向渐变高光。
    expect(foundation).toContain('.conn-cursor-glass')
    const connectionLayer = readFileSync(
      resolve(root, 'src/renderer/src/canvas/ConnectionLayer.tsx'),
      'utf8'
    )
    expect(connectionLayer).toContain('radialGradient')
    expect(connectionLayer).toContain('conn-cursor-glass')
    // 浅色主题有对应玻璃变体。
    const surfaces = readFileSync(resolve(root, 'src/renderer/src/assets/ui-surfaces.css'), 'utf8')
    expect(surfaces).toMatch(
      /\.canvas-theme-light \.node-card\s*\{[\s\S]*?backdrop-filter:\s*blur\(14px\)/
    )
    expect(surfaces).toMatch(/\.canvas-theme-light \.port-dot::after\s*\{/)
  })

  it('节点外壳结构类只有一个权威来源：ui-foundation.css（呈现规范 §14）', () => {
    const surfaces = readFileSync(resolve(root, 'src/renderer/src/assets/ui-surfaces.css'), 'utf8')
    // app.css 不再承载任何 node 外壳结构定义（历史上三套同名规则互相覆盖，
    // 导致磨砂失效与色条悬浮 + padding 补偿的高度计算问题）。
    for (const selector of [
      '.node-card {',
      '.node-header {',
      '.node-body {',
      '.node-card-wrap {'
    ]) {
      expect(
        legacy.includes(`\n${selector}`) || legacy.startsWith(selector),
        `app.css 不应再定义 ${selector.trim()}`
      ).toBe(false)
    }
    expect(legacy).not.toContain('.node-color-bar')
    expect(legacy).not.toContain('.node-hover-toolbar')
    // ui-surfaces.css 只保留浅色主题变体，不再收口结构定义。
    expect(surfaces).not.toMatch(/(^|\n)\.node-header\s*\{/)
    expect(surfaces).not.toMatch(/(^|\n)\.node-color-bar\s*\{/)
    // 类型色条：文档流内、卡片顶部 4px（v1.0 §8.1），不再 absolute 悬浮。
    expect(foundation).toMatch(/\.node-color-bar\s*\{[^}]*height:\s*4px;/)
    expect(foundation).toMatch(/\.node-color-bar\s*\{[^}]*flex-shrink:\s*0;/)
    expect(foundation).not.toMatch(/\.node-color-bar\s*\{[^}]*position:\s*absolute/)
    expect(foundation).not.toMatch(/\.node-card\s*\{[^}]*padding-bottom:\s*8px/)
    // 死代码已删：.node-hover-toolbar 无任何组件引用。
    expect(foundation).not.toContain('.node-hover-toolbar')
    const nodeCardView = readFileSync(
      resolve(root, 'src/renderer/src/canvas/NodeCardView.tsx'),
      'utf8'
    )
    // 色条是卡片内首个文档流元素，标题悬浮在卡片外的 .node-card-wrap 上。
    const colorBarIdx = nodeCardView.indexOf('className="node-color-bar"')
    const bodyIdx = nodeCardView.indexOf('className="node-body"')
    const headerIdx = nodeCardView.indexOf('className="node-header"')
    const cardIdx = nodeCardView.indexOf('node-card type-')
    expect(colorBarIdx).toBeGreaterThan(-1)
    expect(colorBarIdx).toBeGreaterThan(cardIdx)
    expect(colorBarIdx).toBeLessThan(bodyIdx)
    expect(headerIdx).toBeGreaterThan(-1)
    expect(headerIdx).toBeLessThan(cardIdx)
  })
})
