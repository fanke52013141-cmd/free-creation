/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5189')
    await page.waitForSelector('.tl-canvas')
    const labels = ['图片创作', '输入与 AI', '视频创作', '声音创作', '流程与高级']
    assert.deepEqual(await page.locator('.palette-category-item').allTextContents(), labels)
    await page.evaluate(async () => {
      const { default: React } = await import('/@id/react')
      const { default: ReactDom } = await import('/@id/react-dom/client')
      const { NodeCreateMenu } = await import('/src/canvas/NodeCreateMenu.tsx')
      const mount = document.createElement('div')
      document.body.appendChild(mount)
      window.__menuOrderRoot = ReactDom.createRoot(mount)
      window.__menuOrderRoot.render(React.createElement(NodeCreateMenu, {
        x: 750, y: 100, onPick() { /* 仅验证菜单 */ }, onTemplate() { /* 不创建模板 */ }, onUpload() { /* 不上传 */ }, onGallery() { /* 不打开图库 */ }, onClose() { /* 验证期间保持打开 */ }
      }))
    })
    await page.waitForSelector('.node-menu-category-item')
    assert.deepEqual(await page.locator('.node-menu-category-item').allTextContents(), labels)
    const gaps = await page.locator('.node-menu-category-item').evaluateAll(rows => rows.map(row => {
      const icon = row.querySelector('.item-icon').getBoundingClientRect()
      const text = row.querySelector('span:last-child').getBoundingClientRect()
      return text.left - icon.right
    }))
    for (const gap of gaps) assert.ok(Math.abs(gap - 8) < 1, `图标间距 ${gap}`)
    await page.locator('.node-menu-category-item').filter({ hasText: '图片创作' }).hover()
    await page.waitForSelector('.node-menu-submenu .node-menu-item')
    const expected = await page.evaluate(async () => {
      const { PALETTE_NODE_GROUPS } = await import('/src/canvas/palette-categories.ts')
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      return PALETTE_NODE_GROUPS.image.map(type => getNodeType(type).label)
    })
    assert.deepEqual(await page.locator('.node-menu-submenu .node-menu-label').allTextContents(), expected)
    await page.evaluate(async () => {
      window.__menuOrderRoot.unmount()
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.createShape({ id: 'shape:menu-drag', type: 'node-card', x: 240, y: 140, props: { nodeType: 'text' } })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    })
    const port = page.locator('.port-dot.out[data-port-id="out-text"]').first()
    await port.waitFor()
    const box = await port.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(850, 550, { steps: 12 })
    await page.waitForSelector('.conn-overlay .conn-main-path')
    assert.equal(await page.locator('.conn-overlay .conn-start').count(), 0)
    await page.mouse.up()
    await page.waitForSelector('.conn-menu-link')
    assert.equal(await page.locator('.conn-menu-link .conn-start').count(), 0)
    assert.equal(await page.locator('.conn-menu-anchor').count(), 1)
    const filteredLabels = await page.locator('.node-menu-category-item').allTextContents()
    assert.deepEqual(filteredLabels, labels.filter(label => filteredLabels.includes(label)))
    console.log('左侧与创建菜单一级顺序、图片二级顺序及图标文字间距通过')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })


