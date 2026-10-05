/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5189')
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.createShape({ id: 'shape:board-table', type: 'node-card', x: 190, y: 130, props: { nodeType: 'storyboard', text: JSON.stringify({ titles: { scene: '画面内容', custom: '自定义列' }, shots: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, scene: '人物走入书房。'.repeat(20), dialogue: '你好', duration: '5s', custom: i, camera: '中景' })) }) } })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    })
    await page.waitForSelector('.storyboard-table')
    await page.waitForTimeout(800)
    const getSize = () => page.evaluate(async () => { const shape = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:board-table'); return { w: shape.props.w, h: shape.props.h } })
    const size = await getSize()
    assert.ok(size.w >= 1324 && size.h > 440, JSON.stringify(size))
    await page.waitForTimeout(500)
    assert.deepEqual(await getSize(), size, '自适应不能持续增长')
    fs.mkdirSync('qa/storyboard-table', { recursive: true })
    await page.screenshot({ path: 'qa/storyboard-table/table.png' })
    assert.ok((await page.locator('.storyboard-table th').allTextContents()).includes('画面内容'))
    assert.ok(!(await page.locator('.storyboard-table th').allTextContents()).includes('id'))
    assert.equal(await page.locator('.storyboard-cell-value').first().evaluate(el => getComputedStyle(el).maxHeight), 'none')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const shape = editor.getShape('shape:board-table')
      const resized = editor.getShapeUtil(shape).onResize(shape, { mode: 'resize_bounds', handle: 'bottom_right', scaleX: 3, scaleY: 3, initialBounds: editor.getShapeGeometry(shape).bounds, initialShape: shape, newPoint: { x: shape.x, y: shape.y } })
      editor.updateShape({ id: shape.id, type: shape.type, ...resized })
    })
    await page.waitForTimeout(500)
    assert.ok((await getSize()).h > size.h * 2, '自由尺寸不能受 440px 限制')
    for (const type of ['storyboard', 'processor', 'json', 'structured', 'iterate']) {
      await page.evaluate(async type => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const id = `shape:example-${type}`
        editor.createShape({ id, type: 'node-card', x: 190, y: 130, props: { nodeType: type } })
        ;(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('contract', id, 'overview')
      }, type)
      await page.getByRole('tab', { name: '输入输出', exact: true }).click()
      await page.getByRole('region', { name: '输入输出示例' }).waitFor().catch(() => page.locator('.node-io-examples').waitFor())
      assert.ok(await page.locator('.node-io-example pre').count() >= 2)
      await page.locator('.node-io-example').first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: `qa/storyboard-table/example-${type}.png` })
    }
    fs.mkdirSync('qa/storyboard-table', { recursive: true })
    await page.screenshot({ path: 'qa/storyboard-table/examples.png' })
    console.log('分镜板多列长内容、自适应稳定、尺寸无上限与五类输入输出弹窗示例通过')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
