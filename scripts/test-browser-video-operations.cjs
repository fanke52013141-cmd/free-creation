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
    await page.getByRole('button', { name: '视频截取', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '视频操作工作台' })
    await dialog.waitFor()
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
    for (let iteration = 0; iteration < 15; iteration++) {
      for (const name of ['抽帧', '视频截取']) {
        const tab = dialog.getByRole('tab', { name })
        await tab.click()
        assert.equal(await tab.getAttribute('aria-selected'), 'true')
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
    assert.equal(await dialog.getByRole('button', { name: '首帧', exact: true }).count(), 1)
    assert.equal(await dialog.getByRole('tab', { name: '抽帧' }).getAttribute('aria-selected'), 'true')
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
