/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const out = path.resolve('qa/wheel-flicker')
  fs.mkdirSync(out, { recursive: true })
  try {
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5173')
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.createShapes([
        { id: 'shape:zoom-a', type: 'node-card', x: 250, y: 180, props: { nodeType: 'text', title: '缩放验证 A' } },
        { id: 'shape:zoom-b', type: 'node-card', x: 660, y: 180, props: { nodeType: 'text', title: '缩放验证 B' } }
      ])
      editor.select('shape:zoom-a', 'shape:zoom-b')
    })
    await page.waitForTimeout(400)
    const read = () => page.evaluate(() => {
      const selectors = ['.canvas-page', '.tl-background', '.multiselect-toolbar', '.canvas-selection-underlay', '.node-card']
      return Object.fromEntries(selectors.map((selector) => {
        const element = document.querySelector(selector)
        if (!element) return [selector, null]
        const style = getComputedStyle(element)
        return [selector, { background: style.background, filter: style.backdropFilter, opacity: style.opacity }]
      }))
    })
    const before = await read()
    assert.ok(before['.multiselect-toolbar'], '必须验证实际多选工具条')
    await page.mouse.move(1100, 500)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(60)
    const during = await read()
    await page.waitForTimeout(350)
    const after = await read()
    await page.keyboard.up('Control')
    assert.deepEqual(during, before, '缩放过程中不得切换背景、模糊或透明度')
    assert.deepEqual(after, before, '停止滚轮后不得延迟切换材质')
    const samples = []
    for (const delta of [-100, 100, -40, 40]) {
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, delta)
      await page.waitForTimeout(80)
      samples.push(await read())
      await page.waitForTimeout(320)
      samples.push(await read())
      await page.keyboard.up('Control')
    }
    for (const sample of samples) assert.deepEqual(sample, before)
    const zoom = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return editor.getCamera().z
    })
    assert.notEqual(zoom, 1, '实际滚轮应当改变画布缩放')
    // 焦点让弹出小地图保持打开；随后滚轮位于空白画布。
    await page.getByRole('button', { name: '小地图导航', exact: true }).focus()
    await page.waitForSelector('.dock-minimap')
    await page.waitForTimeout(300)
    const mapBefore = await page.locator('.dock-minimap').evaluate((el) => {
      const style = getComputedStyle(el)
      return { background: style.background, filter: style.backdropFilter }
    })
    assert.equal(mapBefore.filter, 'none')
    await page.mouse.wheel(0, 60)
    await page.waitForTimeout(60)
    const mapDuring = await page.locator('.dock-minimap').evaluate((el) => {
      const style = getComputedStyle(el)
      return { background: style.background, filter: style.backdropFilter }
    })
    assert.deepEqual(mapDuring, mapBefore)
    await page.waitForTimeout(350)
    assert.deepEqual(await read(), before)
    await page.screenshot({ path: path.join(out, 'fixed.png') })
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ before, during, after, samples, zoom, mapBefore, mapDuring }, null, 2))
    console.log('PASS: 连续及间歇双向 Ctrl 滚轮缩放、空白画布滚动、多选工具条和小地图材质稳定')
  } finally {
    await browser.close()
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
