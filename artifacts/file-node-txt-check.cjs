/* eslint-disable */
// 一次性核对（不入库）：浏览器验收页里 .txt 存成 data URL 时，文件节点能否认出扩展名并显示正文预览。
const { chromium } = require('playwright')
const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5199'
;(async () => {
  const browser = await chromium
    .launch({ channel: 'chrome', headless: true })
    .catch(() => chromium.launch({ headless: true }))
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '添加文件节点', exact: true }).click()
  const card = page.locator('.node-card-wrap:has(.file-asset-empty)').first()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    card.getByRole('button', { name: '导入文件', exact: true }).click()
  ])
  await chooser.setFiles({
    name: '剧本.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('第一幕：雨夜\n第二幕：天台', 'utf-8')
  })
  await page.waitForSelector('.file-asset-preview', { timeout: 10000 })
  console.log(
    JSON.stringify(
      await page.evaluate(() => {
        const el = document.querySelector('.file-asset-preview')
        const asset = el.closest('.file-asset')
        return {
          preview: el.textContent,
          sub: asset.querySelector('.file-asset-sub').textContent,
          overflow: [el.scrollHeight, el.clientHeight]
        }
      }),
      null,
      1
    )
  )
  await page.locator('.node-card-wrap:has(.file-asset-preview)').first().screenshot({ path: 'artifacts/file-node-txt-check.png' })
  await browser.close()
})()
