// BL-31：NODE_UI_STANDARD v3 单一现行版——几何/线宽/尺寸数值必须能被测试直接读取。
// 这里解析 §27 数值真值表，与源码令牌和 CSS 实现逐一比对；数值漂移会同时命中测试。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NODE_UI,
  STORYBOARD_UI,
  TIMELINE_UI
} from '../src/renderer/src/canvas/node-ui-tokens'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

const spec = read('docs/NODE_UI_STANDARD.md')
const archive = read('docs/archive/NODE_UI_STANDARD-history.md')
const surfaces = read('src/renderer/src/assets/ui-surfaces.css')
const foundation = read('src/renderer/src/assets/ui-foundation.css')

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

const values = specValues()

describe('BL-31 NODE_UI_STANDARD v3：单一现行版与数值真值表', () => {
  it('v3 只保留现行条款，历史 §13–§21 已归档且不再重复权威', () => {
    expect(spec).toContain('version: v3（单一现行版）')
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
    // 单一现行权威：只在 §22/§23 作为基线描述，不再各自宣称“当前权威”。
    expect(spec).toContain('唯一现行权威')
    expect(spec).not.toContain('当前呈现权威')
  })

  it('§27 表格覆盖全部几何/尺寸令牌，且与 NODE_UI 一致', () => {
    const tokenKeys = [...values.keys()].filter((key) => key.startsWith('node.'))
    expect(tokenKeys.length).toBeGreaterThanOrEqual(25)
    for (const key of tokenKeys) {
      const expected = nodeValue(key.slice('node.'.length))
      if (typeof expected === 'number') expect(Number(values.get(key)), key).toBe(expected)
    }
    // 明确校验几类关键结构（避免表格只抄了部分字段）。
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
      'node.actionBar.bottomInset'
    ]) {
      expect(values.has(key), key).toBe(true)
    }
  })

  it('§27 与节点流/时间线尺寸令牌一致', () => {
    expect(Number(values.get('storyboard.width'))).toBe(STORYBOARD_UI.width)
    expect(Number(values.get('storyboard.height'))).toBe(STORYBOARD_UI.height)
    expect(Number(values.get('storyboard.columnWidth'))).toBe(STORYBOARD_UI.columnWidth)
    expect(Number(values.get('timeline.width'))).toBe(TIMELINE_UI.width)
    expect(Number(values.get('timeline.height'))).toBe(TIMELINE_UI.height)
    expect(Number(values.get('timeline.minWidth'))).toBe(TIMELINE_UI.minWidth)
    expect(Number(values.get('timeline.minHeight'))).toBe(TIMELINE_UI.minHeight)
  })

  it('§27 的线宽/流动段/端口数值与 CSS 实现一致', () => {
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
    const dot = cssValue(foundation, '.port-dot::after', 'width') ?? ''
    expect(dot).toBe(`${values.get('port.dot.size')}px`)
    const hitInset = cssValue(foundation, '.port-dot::before', 'inset') ?? ''
    expect(hitInset).toBe(`${values.get('port.hit.inset')}px`)
  })
})