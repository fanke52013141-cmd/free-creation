/* eslint-disable */
// 一次性视觉核对（不入库）：文件节点在「支持格式但没抽出正文」时的文案是否还在节点框内。
const { chromium } = require('playwright')

const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5199'

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }))
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '添加文件节点', exact: true }).click()
  const card = page.locator('.node-card-wrap:has(.file-asset-empty)').first()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    card.getByRole('button', { name: '导入文件', exact: true }).click()
  ])
  await chooser.setFiles({ name: '扫描页.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') })
  await page.waitForSelector('.file-asset-binary', { timeout: 10000 })
  await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  const info = await page.evaluate(() => {
    const block = document.querySelector('.file-asset-binary')
    const card = block.closest('.node-card')
    const actions = card.querySelector('.node-media-next-actions')
    const b = block.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const a = actions.getBoundingClientRect()
    return {
      copy: block.textContent,
      blockScroll: [block.scrollHeight, block.clientHeight],
      cardBottomVsActions: +(c.bottom - a.bottom).toFixed(1),
      card: [Math.round(c.width), Math.round(c.height)]
    }
  })
  console.log(JSON.stringify(info, null, 1))
  const target = page.locator('.node-card-wrap:has(.file-asset-binary)').first()
  await target.screenshot({ path: 'artifacts/file-node-copy-check.png' })

  // 正向分支：能抽出正文的 .txt 必须走预览，而不是同一句「未抽出文字」。
  await page.getByRole('button', { name: '添加文件节点', exact: true }).click()
  const card2 = page.locator('.node-card-wrap:has(.file-asset-empty)').first()
  const [chooser2] = await Promise.all([
    page.waitForEvent('filechooser'),
    card2.getByRole('button', { name: '导入文件', exact: true }).click()
  ])
  await chooser2.setFiles({
    name: '剧本.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('第一幕：雨夜\n第二幕：天台', 'utf-8')
  })
  await page.waitForSelector('.file-asset-preview', { timeout: 10000 })
  const preview = await page.evaluate(() => {
    const el = document.querySelector('.file-asset-preview')
    const sub = el.closest('.file-asset').querySelector('.file-asset-sub')
    return { text: el.textContent, sub: sub.textContent }
  })
  console.log(JSON.stringify(preview, null, 1))
  await page.locator('.node-card-wrap:has(.file-asset-preview)').first().screenshot({
    path: 'artifacts/file-node-preview-check.png'
  })
  await browser.close()
})()
