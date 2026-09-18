import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_UI, resolveNodeHeight } from '../src/renderer/src/canvas/node-ui-tokens'

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

  it('节点卡片保持磨砂玻璃，端口点是类型色实心圆（用户 2026-09-18 拍板去渐变）', () => {
    // 卡片：不再是不透明色块；透出画布网格与背后内容。
    expect(foundation).toMatch(/\.node-card\s*\{[\s\S]*?backdrop-filter:\s*blur\(14px\)/)
    expect(foundation).toMatch(/\.node-card\s*\{[\s\S]*?inset 0 1px 0 rgba\(255, 255, 255, 0\.07\)/)
    expect(foundation).not.toMatch(/\.node-card\s*\{[^}]*background:\s*var\(--card\);/)
    // 端口：18px 命中区不变，视觉是 10px 实色圆点——不做渐变、不做磨砂、不带内阴影。
    expect(foundation).toMatch(/\.port-dot::after\s*\{[^}]*width:\s*10px;/)
    expect(foundation).toMatch(/\.port-dot::after\s*\{[^}]*background:\s*var\(--pc/)
    expect(foundation).not.toMatch(/\.port-dot::after\s*\{[^}]*backdrop-filter/)
    expect(foundation).toMatch(/\.port-dot::after\s*\{[^}]*box-shadow:\s*none;/)
    expect(foundation).not.toContain('.port-dot-inner')
    expect(foundation).not.toMatch(/\.port-dot\s*\{[\s\S]*?border:\s*2px dashed/)
    // 拖线光标同样是实心圆，玻璃珠高光已删除。
    expect(foundation).not.toContain('.conn-cursor-glass')
    const connectionLayer = readFileSync(
      resolve(root, 'src/renderer/src/canvas/ConnectionLayer.tsx'),
      'utf8'
    )
    expect(connectionLayer).not.toContain('radialGradient')
    expect(connectionLayer).not.toContain('conn-cursor-glass')
    // 浅色主题有对应变体。
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

  it('节点高度按固定档位跳档，autoMax 封顶后内部滚动（呈现规范 §3）', () => {
    expect(resolveNodeHeight(100)).toBe(260)
    expect(resolveNodeHeight(260)).toBe(260)
    expect(resolveNodeHeight(261)).toBe(320)
    expect(resolveNodeHeight(320)).toBe(320)
    expect(resolveNodeHeight(321)).toBe(380)
    expect(resolveNodeHeight(380)).toBe(380)
    expect(resolveNodeHeight(381)).toBe(440)
    expect(resolveNodeHeight(900)).toBe(NODE_UI.height.autoMax)
    // 超档内容在 node-body 内部滚动，不再撑高卡片。
    expect(foundation).toMatch(/\.node-body\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('节点尺寸单一真值：NodeCardShape 与 Registry 同源 NODE_UI（§24A）', () => {
    const shapeSource = readFileSync(
      resolve(root, 'src/renderer/src/canvas/NodeCardShape.tsx'),
      'utf8'
    )
    const registrySource = readFileSync(
      resolve(root, 'src/renderer/src/nodes/registry.tsx'),
      'utf8'
    )
    expect(shapeSource).toContain('NODE_UI.height.default')
    expect(registrySource).toContain('NODE_UI.width')
    expect(registrySource).not.toContain('STANDARD_NODE_SIZE = { w: 340')
    const view = readFileSync(resolve(root, 'src/renderer/src/canvas/NodeCardView.tsx'), 'utf8')
    expect(view).toContain('resolveNodeHeight(')
    expect(view).not.toContain('MAX_AUTO_NODE_HEIGHT')
  })

  it('节点 UI 不再携带操作教学文案（呈现规范 §11：身份留、教学删）', () => {
    const view = readFileSync(resolve(root, 'src/renderer/src/canvas/NodeCardView.tsx'), 'utf8')
    for (const teaching of [
      '按住圆点',
      '反向拖线',
      '批量连接',
      '当前输出可用',
      '当前尚无可用输出'
    ]) {
      expect(view).not.toContain(teaching)
    }
    const editor = readFileSync(resolve(root, 'src/renderer/src/canvas/CanvasEditor.tsx'), 'utf8')
    expect(editor).not.toContain('将在此处创建节点')
  })

  it('图片引用为 48×36 缩略图卡 + hover 全貌浮层（呈现规范 §11/§17）', () => {
    // 缩略图尺寸与 NODE_UI Token 同源；无名称文字，来源信息进 tooltip/浮层。
    expect(NODE_UI.reference.imageWidth).toBe(48)
    expect(NODE_UI.reference.imageHeight).toBe(36)
    expect(legacy).toMatch(/\.reference-thumb\s*\{[^}]*width:\s*48px;/)
    expect(legacy).toMatch(/\.reference-thumb\s*\{[^}]*height:\s*36px;/)
    expect(legacy).toContain('.reference-fullview')
    expect(legacy).not.toContain('.connected-inputs-title')
    const preview = readFileSync(
      resolve(root, 'src/renderer/src/canvas/ConnectedInputPreview.tsx'),
      'utf8'
    )
    expect(preview).toContain('createPortal')
    expect(preview).toContain('setTimeout(showFullView, 300)')
    expect(preview).toContain("openPreview({ url: mediaUrl(mediaPath), kind: 'image'")
    // 引用超过约两行时折叠为 +N。
    expect(preview).toContain('REFERENCE_VISIBLE_LIMIT')
    expect(preview).toContain('reference-more')
  })
})
