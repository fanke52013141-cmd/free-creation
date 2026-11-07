/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Run against the browser demo with isolated in-memory project data.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1715, height: 917 } })
    await page.goto(process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5202')
    await page.waitForSelector('.tl-canvas')
    const videoData = `data:video/mp4;base64,${readFileSync(path.join(__dirname, '../test/fixtures/agent-video.mp4')).toString('base64')}`
    await page.evaluate(async (videoData) => {
      document.documentElement.classList.add('desktop-window-overlay')
      window.api.getLocalMediaCapabilities = async () => ({ ok: true, data: { ffmpeg: { available: true }, audioSeparator: { available: false } } })
      window.api.generateVideoThumbnails = async () => ({ ok: true, data: { thumbnails: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42nP4z3D4PwQGAQ8Ai/1+GQAAAABJRU5ErkJggg=='] } })
      const { useEditorStore } = await import('/src/stores/editor.ts')
      const editor = useEditorStore.getState().editor
      editor.createShape({
        id: 'shape:video-operation-test',
        type: 'node-card',
        x: 350,
        y: 150,
        props: {
          nodeType: 'video-asset',
          title: '视频验收',
          mediaId: 'video-test',
          mediaPath: videoData,
          mediaMime: 'video/mp4'
        }
      })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    }, videoData)
    // Exercise both video node types at several sizes, including a width-constrained preview.
    await page.evaluate(async (videoData) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      for (const [id, type, x, width, height] of [
        ['shape:video-layout-wide', 'video-asset', 800, 500, 300],
        ['shape:video-layout-tall', 'video', 1300, 340, 440]
      ]) {
        editor.createShape({ id, type: 'node-card', x, y: 150, props: {
          nodeType: type, title: '布局验收', w: width, h: height,
          mediaId: 'video-test', mediaPath: videoData, mediaMime: 'video/mp4'
        } })
      }
    }, videoData)
    for (const id of ['shape:video-operation-test', 'shape:video-layout-wide', 'shape:video-layout-tall']) {
      const node = page.locator(`[data-node-id="${id}"]`)
      await node.locator('.video-thumbnail-stage').waitFor()
      const layout = await node.evaluate((element) => {
        const preview = element.querySelector('.video-thumbnail-stage .node-media').getBoundingClientRect()
        const stage = element.querySelector('.video-thumbnail-stage').getBoundingClientRect()
        const footer = element.querySelector('.node-standard-action-bar').getBoundingClientRect()
        return { preview: { x: preview.x, y: preview.y, width: preview.width, height: preview.height, bottom: preview.bottom },
          stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height, bottom: stage.bottom },
          footerTop: footer.top }
      })
      assert.ok(Math.abs(layout.preview.width / layout.preview.height - 16 / 9) < 0.01, `${id} 预览保持 16:9`)
      assert.ok(Math.abs((layout.preview.x + layout.preview.width / 2) - (layout.stage.x + layout.stage.width / 2)) < 1, `${id} 水平居中`)
      assert.ok(Math.abs((layout.preview.y + layout.preview.height / 2) - (layout.stage.y + layout.stage.height / 2)) < 1, `${id} 垂直居中`)
      assert.ok(layout.preview.width <= layout.stage.width + 1 && layout.preview.bottom <= layout.stage.bottom + 1 && layout.preview.bottom <= layout.footerTop + 1, `${id} 预览完整且不遮挡按钮`)
      for (const name of ['替换', '视频截取', '抽帧']) {
        assert.equal(await node.getByRole('button', { name, exact: true }).locator('svg').count(), 0, `${id} ${name} 不带图标`)
      }
    }
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes(['shape:video-layout-wide', 'shape:video-layout-tall'])
    })
    const center = page.getByRole('button', { name: '在画布中定位居中', exact: true })
    assert.equal(await center.evaluate((element) => Boolean(element.closest('.node-header'))), true)
    await center.click()
    await page.getByRole('button', { name: '视频截取', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '视频操作工作台' })
    await dialog.waitFor()
    const shell = dialog.locator('.video-operations-dialog')
    const initialSize = await shell.boundingBox()
    await dialog.getByRole('radio', { name: '仅画面', exact: true }).check()
    assert.equal(await dialog.getByRole('button', { name: '截取画面', exact: true }).count(), 1)
    await dialog.getByRole('radio', { name: '画面 + 音频', exact: true }).check()
    assert.equal(await dialog.getByRole('button', { name: '截取画面和音频', exact: true }).count(), 1)
    const settings = dialog.getByText('输出参数设置', { exact: true })
    await settings.click()
    await dialog.getByText('画面质量', { exact: true }).waitFor()
    assert.equal(await dialog.getByRole('radio', { name: '平衡 · CRF 18' }).isChecked(), true)
    await dialog.getByRole('radio', { name: '高质量 · CRF 14' }).check()
    await dialog.getByRole('combobox', { name: '音频格式', exact: true }).click()
    await page.getByRole('option', { name: 'M4A（体积小）' }).click()
    assert.match(await dialog.getByRole('combobox', { name: '音频格式', exact: true }).innerText(), /M4A/)
    await settings.click()
    const dialogTop = await dialog.locator('.video-operations-dialog').evaluate((element) =>
      element.getBoundingClientRect().top
    )
    assert.ok(dialogTop >= 46, 'workbench header stays below the native drag region')
    const video = dialog.locator('video.video-operations-preview')
    await video.waitFor()
    await video.evaluate((element) => element.readyState >= 1 ? Promise.resolve() : new Promise((resolve) => element.addEventListener('loadedmetadata', resolve, { once: true })))
    const bounds = await dialog.locator('.video-operations-player-frame').boundingBox()
    assert.ok(bounds && Math.abs(bounds.width / bounds.height - 16 / 9) < 0.02, 'preview preserves video aspect ratio')
    await dialog.locator('.video-operations-axis:last-child .video-timeline-thumbnails img').waitFor()
    const timeline = dialog.locator('.video-operations-timeline .video-timeline-track')
    assert.equal(await timeline.count(), 1)
    const start = timeline.getByRole('slider', { name: '起始时间' })
    const startBefore = Number(await start.getAttribute('aria-valuenow'))
    const startBox = await start.boundingBox()
    const trackBox = await timeline.boundingBox()
    await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(trackBox.x + trackBox.width / 4, startBox.y + startBox.height / 2, { steps: 5 })
    await page.mouse.up()
    const editedStart = Number(await start.getAttribute('aria-valuenow'))
    assert.ok(editedStart > startBefore)
    assert.equal(await timeline.locator('.video-operations-playhead').count(), 1)
    const clipPointerStyle = await timeline.locator('.video-operations-playhead').evaluate((element) => {
      const needle = getComputedStyle(element)
      const grip = getComputedStyle(element, '::before')
      return { needle: needle.backgroundSize, width: grip.width, height: grip.height, background: grip.backgroundImage, radius: grip.borderRadius }
    })
    await dialog.getByRole('slider', { name: '播放进度' }).press('Home')
    assert.equal(Number(await start.getAttribute('aria-valuenow')), editedStart)
    for (let iteration = 0; iteration < 15; iteration++) {
      for (const name of ['抽帧', '视频截取']) {
        const tab = dialog.getByRole('tab', { name })
        await tab.click()
        assert.equal(await tab.getAttribute('aria-selected'), 'true')
        const size = await shell.boundingBox()
        assert.equal(size.height, initialSize.height)
        assert.equal(size.width, initialSize.width)
        assert.equal(await dialog.locator('.video-operations-axis:last-child .video-timeline-thumbnails img').count(), 1)
      }
    }
    const clipTab = dialog.getByRole('tab', { name: '视频截取' })
    const frameTab = dialog.getByRole('tab', { name: '抽帧' })
    await clipTab.press('ArrowRight')
    assert.equal(await frameTab.getAttribute('aria-selected'), 'true')
    assert.ok(await frameTab.evaluate((element) => element === document.activeElement))
    await frameTab.press('Home')
    assert.equal(await clipTab.getAttribute('aria-selected'), 'true')
    if (process.env.VIDEO_OPERATIONS_SCREENSHOT) await page.screenshot({ path: process.env.VIDEO_OPERATIONS_SCREENSHOT })
    await dialog.getByRole('tab', { name: '抽帧' }).click()
    assert.equal(await dialog.getByRole('radio', { name: '首帧', exact: true }).count(), 1)
    assert.equal(await dialog.getByRole('tab', { name: '抽帧' }).getAttribute('aria-selected'), 'true')
    assert.equal(await timeline.count(), 1)
    assert.equal(await timeline.locator('.video-operations-playhead').count(), 0)
    await timeline.click({ position: { x: trackBox.width / 4, y: 15 } })
    const marker = timeline.getByRole('slider', { name: '取帧位置' })
    assert.ok(Number(await marker.getAttribute('aria-valuenow')) > 0)
    assert.equal(await dialog.getByRole('radio', { name: '指定时刻' }).isChecked(), true)
    const markerBox = await marker.boundingBox()
    assert.ok(markerBox.width >= 28)
    const framePointerStyle = await marker.evaluate((element) => {
      const needle = getComputedStyle(element)
      const grip = getComputedStyle(element, '::after')
      return { needle: needle.backgroundSize, width: grip.width, height: grip.height, background: grip.backgroundImage, radius: grip.borderRadius }
    })
    assert.equal(clipPointerStyle.width, clipPointerStyle.height, '播放针顶部使用等宽高圆点')
    assert.equal(clipPointerStyle.radius, '50%')
    assert.equal(clipPointerStyle.background, 'none', '播放针无中段双线拖柄')
    assert.equal(framePointerStyle.needle, clipPointerStyle.needle)
    assert.notEqual(framePointerStyle.background, 'none', '抽帧仍保留双线拖柄')
    assert.ok(parseFloat(framePointerStyle.needle) <= 2, '针线保持纤细，拖动热区独立保留')
    const frameBeforeDrag = Number(await marker.getAttribute('aria-valuenow'))
    await page.mouse.move(markerBox.x + 2, markerBox.y + markerBox.height / 2)
    await page.mouse.down()
    assert.equal(Number(await marker.getAttribute('aria-valuenow')), frameBeforeDrag)
    await page.mouse.move(markerBox.x + 100, markerBox.y + markerBox.height + 5, { steps: 5 })
    await page.mouse.up()
    assert.ok(Number(await marker.getAttribute('aria-valuenow')) > frameBeforeDrag)
    assert.equal(await dialog.getByRole('textbox', { name: '取帧' }).count(), 1)
    if (process.env.VIDEO_FRAME_SCREENSHOT) {
      await page.waitForTimeout(200)
      await page.screenshot({ path: process.env.VIDEO_FRAME_SCREENSHOT })
    }
    console.log('PASS: desktop caption clearance, video aspect ratio, 30 tab clicks and keyboard navigation')
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
