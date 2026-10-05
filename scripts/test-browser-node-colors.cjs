/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 实际渲染验收：所有节点标题、分类、菜单和详情图标保持相同身份色。
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')

function rgb(color) {
  if (color.startsWith('#')) return [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16))
  if (color.startsWith('color(srgb')) return color.match(/[\d.]+/g).slice(0, 3).map((value) => Number(value) * 255)
  return color.match(/[\d.]+/g).slice(0, 3).map(Number)
}
function contrast(a, b) {
  const luminance = (color) => rgb(color).map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const first = luminance(a), second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

;(async () => {
  const output = `qa/node-colors-${Date.now()}`
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const evidence = { themes: {}, categories: {}, entries: {} }
  try {
    const page = await browser.newPage({ viewport: { width: 2700, height: 1850 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.waitForSelector('.tl-canvas')
    const nodes = await page.evaluate(async () => {
      const { PALETTE_NODE_GROUPS } = await import('/src/canvas/palette-categories.ts')
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const nodes = Object.entries(PALETTE_NODE_GROUPS).flatMap(([category, ids], row) => ids.map((id, col) => {
        const spec = getNodeType(id)
        editor.createShape({ id: `shape:color-${id}`, type: 'node-card', x: 210 + col * 355, y: 100 + row * 335, props: { nodeType: id, title: spec.label } })
        return { id, category, label: spec.label, color: spec.color }
      }))
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      editor.selectNone()
      return nodes
    })
    await page.waitForTimeout(800)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.querySelectorAll('.canvas-host, .canvas-page').forEach((element) => {
          element.classList.toggle('canvas-theme-dark', theme === 'dark')
          element.classList.toggle('canvas-theme-light', theme === 'light')
        })
      }, theme)
      const colors = await page.evaluate(() => [...document.querySelectorAll('.node-card-wrap')].map((wrap) => {
        const icon = wrap.querySelector('.node-icon'), card = wrap.querySelector('.node-card')
        const bodyIcon = card.querySelector('.node-standard-identity-icon, .node-empty-icon, .asset-empty > svg, .audio-empty-icon, .sound-adjust-body-icon, .website-node-icon')
        return { id: card.dataset.nodeType, color: getComputedStyle(icon).color, opacity: getComputedStyle(icon).opacity, stroke: getComputedStyle(icon.querySelector('svg')).stroke, background: getComputedStyle(wrap.closest('.canvas-host')).getPropertyValue('--bg').trim(), bodyColor: bodyIcon && getComputedStyle(bodyIcon).color, bodyBackground: bodyIcon && getComputedStyle(bodyIcon).backgroundColor, sectionIcons: [...card.querySelectorAll('.tts-section-label svg')].map((el) => getComputedStyle(el).color) }
      }))
      assert.equal(colors.length, nodes.length)
      for (const node of colors) {
        const expected = nodes.find((item) => item.id === node.id)
        const actual = rgb(node.color)
        const base = rgb(expected.color)
        const target = theme === 'dark' ? base : base.map((channel, i) => channel * 0.55 + [23, 35, 45][i] * 0.45)
        actual.forEach((channel, i) => assert.ok(Math.abs(channel - target[i]) < 1, `${theme} ${node.id} 身份色`))
        assert.equal(node.opacity, '1', `${node.id} 图标不得淡化`)
        assert.deepEqual(rgb(node.stroke), actual)
        node.contrast = contrast(node.color, node.background)
        assert.ok(node.contrast >= 3, `${theme} ${node.id} 对比度 ${node.contrast}`)
        if (node.bodyColor) {
          rgb(node.bodyColor).forEach((channel, i) => assert.ok(Math.abs(channel - actual[i]) < 1, `${theme} ${node.id} 正文图标`))
          const background = theme === 'light' ? node.bodyBackground : '#303640'
          node.bodyContrast = contrast(node.bodyColor, background)
          assert.ok(node.bodyContrast >= 3, `${theme} ${node.id} 图标底板对比度 ${node.bodyContrast}`)
        }
        node.sectionIcons.forEach((color) => rgb(color).forEach((channel, i) => assert.ok(Math.abs(channel - actual[i]) < 1, `${theme} ${node.id} 配置区图标`)))
      }
      evidence.themes[theme] = colors
      await page.screenshot({ path: `${output}/all-nodes-${theme}.png` })
    }
    await page.evaluate(() => document.querySelectorAll('.canvas-host, .canvas-page').forEach((el) => { el.classList.remove('canvas-theme-light'); el.classList.add('canvas-theme-dark') }))
    for (const label of ['输入与 AI', '图片创作', '视频创作', '声音创作', '流程与高级']) {
      const category = page.getByRole('button', { name: `展开${label}节点`, exact: true })
      await category.hover()
      await page.waitForSelector('.palette-node-flyout')
      await page.waitForTimeout(250)
      const items = await page.locator('.palette-node-flyout .palette-node-item').evaluateAll((buttons) => buttons.map((button) => ({ label: button.getAttribute('aria-label'), color: getComputedStyle(button.querySelector('.palette-icon')).color })))
      for (const item of items) {
        const node = nodes.find((node) => item.label === `添加${node.label}节点`)
        assert.ok(node)
        rgb(item.color).forEach((channel, i) => assert.ok(Math.abs(channel - rgb(node.color)[i]) < 1))
      }
      const categoryColor = await category.locator('.palette-icon').evaluate((el) => getComputedStyle(el).color)
      const expectedCategoryColor = await page.evaluate(async (label) => Object.values((await import('/src/canvas/palette-categories.ts')).PALETTE_CATEGORY_META).find((meta) => meta.label === label).color, label)
      rgb(categoryColor).forEach((channel, i) => assert.ok(Math.abs(channel - rgb(expectedCategoryColor)[i]) < 1, `${label}: ${categoryColor}, expected ${expectedCategoryColor}`))
      evidence.categories[label] = { color: categoryColor, items }
      await page.screenshot({ path: `${output}/menu-${Object.keys(evidence.categories).length}.png` })
    }
    await page.mouse.move(2600, 1800)
    await page.evaluate(async () => (await import('/src/stores/search.ts')).useSearchStore.getState().toggle())
    await page.getByRole('textbox', { name: '搜索画布节点或节点库' }).fill('音频')
    await page.waitForSelector('.search-hit')
    const searchColors = await page.locator('.search-hit').evaluateAll((buttons) => buttons.map((el) => ({ label: el.getAttribute('aria-label').split('：')[1], color: getComputedStyle(el.querySelector('.search-hit-icon')).color })))
    assert.ok(searchColors.length > 0)
    searchColors.forEach((item) => {
      const node = nodes.find((node) => node.label === item.label)
      assert.ok(node, item.label)
      rgb(item.color).forEach((channel, i) => assert.ok(Math.abs(channel - rgb(node.color)[i]) < 1, `搜索 ${item.label}`))
    })
    evidence.entries.search = searchColors
    await page.evaluate(async () => {
      (await import('/src/stores/search.ts')).useSearchStore.getState().close()
      ;(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('contract', 'shape:color-audio', 'overview')
    })
    await page.waitForSelector('.contract-head')
    evidence.entries.panel = await page.locator('.contract-head > span').evaluate((el) => getComputedStyle(el).color)
    rgb(evidence.entries.panel).forEach((channel, i) => assert.ok(Math.abs(channel - rgb(nodes.find((node) => node.id === 'audio').color)[i]) < 1))
    await page.evaluate(async () => {
      (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close()
      const { default: React } = await import('/@id/react')
      const { default: ReactDom } = await import('/@id/react-dom/client')
      const { ProjectCreateDialog } = await import('/src/components/ProjectCreateDialog.tsx')
      const mount = document.createElement('div')
      document.body.appendChild(mount)
      window.__colorQaRoot = ReactDom.createRoot(mount)
      window.__colorQaRoot.render(React.createElement(ProjectCreateDialog, { title: '颜色验收', submitLabel: '保存', onCancel() { /* Visual test keeps the dialog open. */ }, async onSubmit() { /* Visual test does not create a project. */ } }))
    })
    await page.getByRole('button', { name: /高级：自定义可见工具/ }).click()
    const dialogColors = await page.locator('.project-create-node').evaluateAll((elements) => elements.map((el) => ({ label: el.querySelector('.project-create-node-label').textContent, color: getComputedStyle(el.querySelector('.project-create-node-icon')).color })))
    assert.equal(dialogColors.length, nodes.length)
    for (const item of dialogColors) rgb(item.color).forEach((channel, i) => assert.ok(Math.abs(channel - rgb(nodes.find((node) => node.label === item.label).color)[i]) < 1))
    evidence.entries.projectDialog = dialogColors
    await page.screenshot({ path: `${output}/project-dialog.png` })
    await page.evaluate(async () => {
      window.__colorQaRoot.unmount()
      const { default: React } = await import('/@id/react')
      const { default: ReactDom } = await import('/@id/react-dom/client')
      const { NodeCreateMenu } = await import('/src/canvas/NodeCreateMenu.tsx')
      const mount = document.createElement('div')
      document.body.appendChild(mount)
      window.__colorQaRoot = ReactDom.createRoot(mount)
      window.__colorQaRoot.render(React.createElement(NodeCreateMenu, { x: 200, y: 200, onPick() { /* Visual test does not create nodes. */ }, onTemplate() { /* Visual test does not apply templates. */ }, onUpload() { /* Visual test does not upload files. */ }, onGallery() { /* Visual test does not open the library. */ }, onClose() { /* Visual test keeps the menu open. */ } }))
    })
    await page.locator('.node-menu-category-item').filter({ hasText: '声音创作' }).hover()
    await page.waitForSelector('.node-menu-submenu .item-icon')
    evidence.entries.createMenu = await page.locator('.node-menu-submenu .node-menu-item').evaluateAll((items) => items.map((el) => ({ label: el.textContent.trim(), color: getComputedStyle(el.querySelector('.item-icon')).color })))
    assert.equal(evidence.entries.createMenu.length, 5)
    for (const item of evidence.entries.createMenu) rgb(item.color).forEach((channel, i) => assert.ok(Math.abs(channel - rgb(nodes.find((node) => item.label.startsWith(node.label)).color)[i]) < 1))
    await page.screenshot({ path: `${output}/create-menu.png` })
    fs.writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2))
    console.log(`Node colors passed: ${nodes.length} nodes, two themes, five menus, search, panel, project dialog and create menu. Minimum contrast: ${Math.min(...Object.values(evidence.themes).flat().flatMap((item) => [item.contrast, item.bodyContrast ?? Infinity])).toFixed(2)}:1`)
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
