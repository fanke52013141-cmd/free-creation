// BL-31：NODE_UI_STANDARD v3 单一现行版——几何/线宽/尺寸/层级数值必须能被测试直接读取。
// 这里解析 §27 数值真值表，与源码令牌和真实生效的终裁 CSS 逐一比对；数值漂移会同时命中测试。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NODE_UI,
  STORYBOARD_UI,
  TIMELINE_UI
} from '../src/renderer/src/canvas/node-ui-tokens'
import { NODE_PORT_OUTSET, NODE_PORT_SIZE } from '../src/renderer/src/canvas/edge-geometry'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

const spec = read('docs/NODE_UI_STANDARD.md')
const archive = read('docs/archive/NODE_UI_STANDARD-history.md')
const surfaces = read('src/renderer/src/assets/ui-surfaces.css')
const appCss = read('src/renderer/src/assets/app.css')
const visualSystem = read('src/renderer/src/canvas/node-visual-system.css')
const refinement = read('src/renderer/src/canvas/node-interaction-refinement.css')

function specValues(): Map<string, string> {
  const start = spec.indexOf('## 27.')
  expect(start).toBeGreaterThan(0)
  const table = spec.slice(start)
  const values = new Map<string, string>()
  for (const line of table.split('\n')) {
    const match = line.match(/^\| ([a-zA-Z0-9_.]+) \| ([^|]+?) \|/)
    if (!match || match[1] === '键') continue
    values.set(match[1], match[2].trim())
  }
  return values
}

function nodeValue(path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (typeof value !== 'object' || value === null) return undefined
    return (value as Record<string, unknown>)[key]
  }, NODE_UI)
}

function cssValue(source: string, selector: string, property: string): string | undefined {
  const selectorPattern = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = source.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
  return block.match(new RegExp(`${property}\\s*:\\s*([^;]+);`))?.[1]?.trim()
}

function rootTokenNumber(source: string, tokenName: string): number {
  const match = source.match(new RegExp(`${tokenName}\\s*:\\s*(\\d+)\\s*;`))
  return Number(match?.[1] ?? NaN)
}

const values = specValues()

describe('BL-31 NODE_UI_STANDARD v3：单一现行版与数值真值表', () => {
  it('v3 只保留现行条款，历史 §13–§21 已归档且不再重复权威', () => {
    expect(spec).toContain('version: v3')
    expect(spec).toContain('## 27. v3 数值真值表')
    expect(spec).toContain('archive/NODE_UI_STANDARD-history.md')
    for (const heading of [
      '## 13. 样式令牌与权威层',
      '## 14. 滑动样式',
      '## 17. 2026-09-29 统一实施记录',
      '## 18. v1.2 统一节点呈现协议',
      '## 19. v1.3 按内容布局协议',
      '## 21. 2026-11-03 节点精简与几何裁决'
    ]) {
      expect(spec).not.toContain(heading)
      expect(archive).toContain(heading)
    }
    expect(archive).toContain('status: archive')
    // 单一现行权威：只在头部作为唯一现行权威声明，不再各自宣称“当前呈现权威”。
    expect(spec).toContain('唯一现行权威')
    expect(spec).not.toContain('当前呈现权威')
  })

  it('§27 表格覆盖全部几何/尺寸令牌，且与 NODE_UI 及按钮终裁 CSS 一致', () => {
    const tokenKeys = [...values.keys()].filter((key) => key.startsWith('node.'))
    expect(tokenKeys.length).toBeGreaterThanOrEqual(25)
    for (const key of tokenKeys) {
      const expected = nodeValue(key.slice('node.'.length))
      if (typeof expected === 'number') expect(Number(values.get(key)), key).toBe(expected)
    }
    for (const key of [
      'node.width',
      'node.height.default',
      'node.height.expanded',
      'node.height.rich',
      'node.height.autoMax',
      'node.header.height',
      'node.radius',
      'node.content.padding',
      'node.primaryButton.height',
      'node.primaryButton.radius',
      'node.actionBar.bottomInset'
    ]) {
      expect(values.has(key), key).toBe(true)
    }
    expect(
      cssValue(
        visualSystem,
        '.canvas-page .node-card .node-standard-action-bar button:not(.icon-btn)',
        'border-radius'
      )
    ).toBe(`${values.get('node.primaryButton.radius')}px`)
  })

  it('§27 与分镜板/轨道线尺寸令牌一致', () => {
    expect(Number(values.get('storyboard.width'))).toBe(STORYBOARD_UI.width)
    expect(Number(values.get('storyboard.height'))).toBe(STORYBOARD_UI.height)
    expect(Number(values.get('storyboard.columnWidth'))).toBe(STORYBOARD_UI.columnWidth)
    expect(Number(values.get('timeline.width'))).toBe(TIMELINE_UI.width)
    expect(Number(values.get('timeline.height'))).toBe(TIMELINE_UI.height)
    expect(Number(values.get('timeline.minWidth'))).toBe(TIMELINE_UI.minWidth)
    expect(Number(values.get('timeline.minHeight'))).toBe(TIMELINE_UI.minHeight)
  })

  it('§27 的线宽、真实端口终裁层（.port-core / edge-geometry）及全局浮层阶梯一致', () => {
    expect(cssValue(surfaces, '.data-edge-visible', 'stroke-width')).toBe(
      `${values.get('edge.visible.strokeWidth')}`
    )
    expect(cssValue(surfaces, '.data-edge-flow', 'stroke-width')).toBe(
      `${values.get('edge.flow.strokeWidth')}`
    )
    expect(cssValue(surfaces, '.data-edge-flow', 'stroke-dasharray')).toBe(
      values.get('edge.flow.dasharray')
    )
    expect(cssValue(surfaces, '.data-edge.is-hovered .data-edge-visible', 'stroke-width')).toBe(
      `${values.get('edge.hover.strokeWidth')}`
    )
    const hit = cssValue(surfaces, '.data-edge-hit', 'stroke-width') ?? ''
    expect(hit).toContain(`${values.get('edge.hit.strokeWidth')}`)

    // 真实生效的端口核心来自 node-interaction-refinement.css .port-core，几何来自 edge-geometry.ts
    expect(cssValue(refinement, '.canvas-page .node-card-wrap .port-core', 'width')).toBe(
      `${values.get('port.core.size')}px`
    )
    expect(cssValue(refinement, '.canvas-page .node-card-wrap .port-core', 'height')).toBe(
      `${values.get('port.core.size')}px`
    )
    expect(Number(values.get('port.hit.size'))).toBe(NODE_PORT_SIZE)
    expect(Number(values.get('port.outset'))).toBe(NODE_PORT_OUTSET)

    // 全局浮层 z-index 必须与 §27 一致且严格递增（画布浮层 < 弹窗 < 弹窗内下拉 < 确认框 < Toast）
    const zFloating = rootTokenNumber(appCss, '--z-floating')
    const zModal = rootTokenNumber(appCss, '--z-modal')
    const zPopover = rootTokenNumber(appCss, '--z-popover')
    const zConfirm = rootTokenNumber(appCss, '--z-confirm')
    const zToast = rootTokenNumber(appCss, '--z-toast')
    expect(zFloating).toBe(Number(values.get('z.floating')))
    expect(zModal).toBe(Number(values.get('z.modal')))
    expect(zPopover).toBe(Number(values.get('z.popover')))
    expect(zConfirm).toBe(Number(values.get('z.confirm')))
    expect(zToast).toBe(Number(values.get('z.toast')))
    expect(zFloating).toBeLessThan(zModal)
    expect(zModal).toBeLessThan(zPopover)
    expect(zPopover).toBeLessThan(zConfirm)
    expect(zConfirm).toBeLessThan(zToast)
  })
})
