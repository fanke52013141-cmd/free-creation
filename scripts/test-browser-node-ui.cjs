/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Requires the browser dev server; uses an isolated profile and never edits desktop projects.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
    await page.goto('http://127.0.0.1:5173/')
    await page.getByRole('button', { name: '添加图片节点', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '导入图片', exact: true }).click()
    await (
      await chooser
    ).setFiles({
      name: 'ui-fixture.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64'
      )
    })
    await page.waitForFunction(() => {
      const img = document.querySelector('.type-image .node-media img')
      return img && img.complete && img.naturalWidth === 1
    })
    await page.locator('.type-image .node-media img').click()
    await page.locator('.media-preview-mask').waitFor()
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.locator('.media-preview-mask').waitFor({ state: 'detached' })
    // 浏览器演示同样要能完成真实的画布内图片拆分，而不是把能力 mock 成失败。
    await page.getByRole('button', { name: '添加拆分节点', exact: true }).click()
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    const splitNode = page.locator('.node-card-wrap:has(.type-image-split)').first()
    await splitNode.waitFor()
    assert.match(await splitNode.innerText(), /图片拆分/)
    const upload = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传本地文件', exact: true }).click()
    await (
      await upload
    ).setFiles({
      name: 'ui-text.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('你好，导入测试')
    })
    await page.getByText('你好，导入测试', { exact: true }).waitFor()
    await page.getByRole('button', { name: '添加文本节点', exact: true }).click()
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    const nodes = page.locator('.node-card-wrap:has(.type-text)')
    assert.equal(await nodes.count(), 2)
    const source = nodes.first()
    const destination = nodes.last()
    await source.locator('.node-card').click({ position: { x: 120, y: 100 } })
    assert.match(await source.getAttribute('class'), /is-selected/)
    const before = await source.boundingBox()
    const a = await source.locator('.port-dot.out').boundingBox()
    const b = await destination.locator('.port-dot.in').boundingBox()
    const edgeCountBeforeTextConnect = await page.locator('.data-edge').count()
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
    await page.mouse.up()
    await page.waitForFunction(
      (count) => document.querySelectorAll('.data-edge').length > count,
      edgeCountBeforeTextConnect
    )
    const after = await source.boundingBox()
    assert.equal(after.width, before.width, 'port drag must not resize width')
    assert.equal(after.height, before.height, 'port drag must not resize height')
    // The edge away from the port must still resize normally.
    await page.mouse.move(after.x + after.width, after.y + 40)
    await page.mouse.down()
    await page.mouse.move(after.x + after.width + 45, after.y + 40, { steps: 10 })
    await page.mouse.up()
    assert.ok(
      (await source.boundingBox()).width > after.width + 20,
      'edge away from port must resize'
    )
    assert.equal(await page.locator('.node-readiness-badge').count(), 0)
    const headerAlignment = await source.evaluate((card) => {
      const cardRect = card.getBoundingClientRect()
      const runRect = card.querySelector('.node-run-btn')?.getBoundingClientRect()
      return runRect ? cardRect.right - runRect.right : Number.POSITIVE_INFINITY
    })
    assert.ok(headerAlignment <= 4, '运行按钮必须贴齐节点右上角')

    // 两个已连接节点分组后，数据边必须继续存在。
    await source.locator('.node-card').click()
    await destination.locator('.node-card').click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: '打组', exact: true }).click()
    await page.locator('.canvas-group-outline').waitFor()
    assert.ok(await page.locator('.data-edge').count(), '分组后应保留真实数据边')
    await page.getByRole('button', { name: '切换为浅色画布', exact: true }).click()
    await destination.getByRole('button', { name: '打开节点说明' }).click()
    await page.getByRole('tab', { name: '输入输出', exact: true }).click()
    const colors = await page
      .locator('.node-contract-panel textarea')
      .first()
      .evaluate((el) => ({
        bg: getComputedStyle(el).backgroundColor,
        text: getComputedStyle(el).color
      }))
    assert.equal(colors.bg, 'rgb(255, 255, 255)')
    assert.equal(colors.text, 'rgb(24, 33, 45)')
    assert.equal(
      await page
        .locator('.node-seq')
        .first()
        .evaluate((el) => getComputedStyle(el).color),
      'rgb(229, 57, 53)'
    )
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT })
    console.log(
      'PASS: image import/preview, image-split availability, footer text import, port connection, grouping, light inspector, sequence color, readiness removal'
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
