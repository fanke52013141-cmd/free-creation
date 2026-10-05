/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 2200, height: 1500 } })
    await page.goto(process.env.CANVAS_QA_URL || process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191')
    await page.locator('.node-palette').waitFor()
    for (const nodeType of ['text', 'storyboard']) {
      await page.evaluate(async nodeType => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        editor.deleteShapes([...editor.getCurrentPageShapeIds()])
        editor.createShape({ id: 'shape:resize-probe', type: 'node-card', x: 300, y: 150, props: { nodeType, title: nodeType, text: nodeType === 'text' ? '尺寸验收样例' : '' } })
        editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
        editor.selectNone()
      }, nodeType)
      const card = page.locator('[data-node-id="shape:resize-probe"]')
      if (nodeType === 'text') {
        await card.locator('.node-run-btn').click()
        await page.waitForTimeout(300)
        const runStatus = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:resize-probe').meta.nodeRun?.status)
        assert.equal(runStatus, 'success', 'first click on an unselected run button must execute')
      }
      await card.locator('.node-card').click({ position: { x: 8, y: 8 } })
      for (const zoom of [0.5, 0.75, 1, 1.5]) {
        await page.evaluate(async zoom => {
          const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
          editor.setCamera({ x: 0, y: 0, z: zoom }, { immediate: true })
        }, zoom)
        await page.waitForTimeout(100)
        const runHit = await card.locator('.node-run-btn').evaluate(button => {
          const rect = button.getBoundingClientRect()
          return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.node-run-btn'))
        })
        assert.equal(runHit, true, `${nodeType}/${zoom}: resize controls must not cover the run button`)
      }
      await page.evaluate(async () => {
        (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      })
      await page.waitForTimeout(150)
      const corner = page.getByTestId('selection.target.bottom-right')
      await corner.waitFor()
      const handle = await corner.boundingBox()
      const before = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:resize-probe').props)
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 + 400, handle.y + handle.height / 2 + 650, { steps: 20 })
      await page.mouse.up()
      const result = await page.evaluate(async () => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const shape = editor.getShape('shape:resize-probe')
        const snapshot = editor.store.getStoreSnapshot('document')
        editor.store.loadStoreSnapshot(snapshot)
        return { width: shape.props.w, height: shape.props.h, mode: shape.meta.nodeHeightMode, restored: editor.getShape(shape.id).props }
      })
      assert.ok(result.width > before.w + 300, `${nodeType}: real pointer must increase width`)
      assert.equal(result.mode, 'manual')
      assert.equal(result.restored.w, result.width)
      assert.equal(result.restored.h, result.height)
      if (nodeType === 'storyboard') assert.ok(result.height > 900, 'storyboard must exceed ordinary height limit')
      else {
        assert.equal(result.height, 440, 'ordinary card height must stop at 440')
        await card.locator('.node-card').click({ position: { x: 8, y: 8 } })
        const lowerHandle = await corner.boundingBox()
        await page.mouse.move(lowerHandle.x + lowerHandle.width / 2, lowerHandle.y + lowerHandle.height / 2)
        await page.mouse.down()
        await page.mouse.move(lowerHandle.x + lowerHandle.width / 2, lowerHandle.y + lowerHandle.height / 2 - 350, { steps: 15 })
        await page.mouse.up()
        const smallHeight = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:resize-probe').props.h)
        assert.equal(smallHeight, 260, 'ordinary card height must not shrink below 260')
      }
      console.log(`PASS ${nodeType}: pointer resize, manual mode, dimension boundaries, snapshot restore`)
    }
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
