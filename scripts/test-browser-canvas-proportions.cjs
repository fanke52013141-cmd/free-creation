/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(process.env.CANVAS_QA_URL || process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191')
    await page.locator('.node-palette').waitFor()
    for (const viewport of [{ width: 1022, height: 550 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(200)
      await page.evaluate(async () => {
        const e = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        e.deleteShapes([...e.getCurrentPageShapeIds()])
        e.createShape({ id: 'shape:proportions', type: 'node-card', x: 300, y: 150, props: { nodeType: 'text', title: '比例验收', text: '短文本' } })
        e.setCamera({ x: 0, y: 0, z: 0.39 }, { immediate: true })
      })
      await page.keyboard.press('Shift+Alt+f')
      await page.waitForTimeout(600)
      const geometry = await page.evaluate(async () => {
        const e = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const toolbar = document.querySelector('.canvas-topbar').getBoundingClientRect()
        const card = document.querySelector('[data-node-id="shape:proportions"] .node-card').getBoundingClientRect()
        const palette = document.querySelector('.node-palette').getBoundingClientRect()
        const title = document.querySelector('.topbar-center').getBoundingClientRect()
        return { zoom: e.getZoomLevel(), toolbarHeight: toolbar.height, titleBottom: title.bottom, toolbarBottom: toolbar.bottom, cardLeft: card.left, paletteRight: palette.right }
      })
      assert.equal(geometry.toolbarHeight, 44, 'topbar must remain a single 44px row')
      assert.ok(geometry.titleBottom <= geometry.toolbarBottom, 'title must not wrap into a second toolbar row')
      assert.ok(geometry.zoom >= 0.95, `single card should remain readable, got ${geometry.zoom}`)
      assert.ok(geometry.cardLeft >= geometry.paletteRight + 16, 'card and ports must clear the palette')
      for (const zoom of [0.4, 1]) {
        await page.evaluate(async zoom => {
          (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.setCamera({ z: zoom, x: 0, y: 0 }, { immediate: true })
        }, zoom)
        for (const selector of ['.topbar-shortcut svg', '.palette-category-item svg', '.palette-utility svg']) {
          const icon = await page.locator(selector).first().boundingBox()
          assert.equal(icon.width, 16, `${selector}: compact 16px icon at canvas zoom ${zoom}`)
          assert.equal(icon.height, 16)
        }
      }
      await page.keyboard.press('Shift+Alt+f')
      await page.waitForTimeout(600)
      console.log(`PASS ${viewport.width}x${viewport.height}: single-row toolbar and readable card fit`)
    }
    await page.screenshot({ path: 'artifacts/node-remediation-2026-10-06/canvas-proportions-final.png' })
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
