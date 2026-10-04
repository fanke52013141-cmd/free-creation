/* eslint-disable @typescript-eslint/no-require-imports */
// Electron 缩放闪烁抓帧实验：CDP screencast 收集缩放期间每一合成帧，
// 对比三组：原样式 / 去背景渐变 / 去顶栏与底座 backdrop-filter。
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const CDP = 'http://127.0.0.1:9333'
const OUT = __dirname

async function main() {
  const browser = await chromium.connectOverCDP(CDP)
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => String(p.url()).startsWith('http')) || ctx.pages()[0]
  await page.bringToFront()
  await page.setViewportSize({ width: 1400, height: 850 })

  // 建项目进画布（若已在画布则跳过）
  if ((await page.locator('.palette-category-item').count()) === 0) {
    await page.getByRole('button', { name: '新建项目' }).click()
    await page.locator('input[placeholder="给这个项目起个名字"]').fill('闪烁实验')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.palette-category-item').first().waitFor({ timeout: 20000 })
  }
  // 放几个节点，让画面更接近真实
  for (const [cat, item] of [
    ['展开输入与', '文本节点'],
    ['展开图片创作', '生图节点']
  ]) {
    await page.getByRole('button', { name: new RegExp(cat) }).hover()
    await page.getByRole('button', { name: new RegExp(item) }).waitFor({ timeout: 4000 }).catch(() => undefined)
    await page.getByRole('button', { name: new RegExp(item) }).click().catch(() => undefined)
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(800)

  const cdp = await ctx.newCDPSession(page)
  const frames = []
  cdp.on('Page.screencastFrame', (ev) => {
    frames.push(ev.data)
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, everyNthFrame: 1, maxWidth: 900, maxHeight: 560 })

  const zoomBurst = async (ms = 2600) => {
    const box = await page.evaluate(() => {
      const el = document.querySelector('.tl-canvas') || document.body
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.mouse.move(box.x, box.y)
    const end = Date.now() + ms
    let up = true
    while (Date.now() < end) {
      await page.mouse.wheel(0, up ? -300 : 300)
      up = !up
      await page.waitForTimeout(35)
    }
  }

  const capture = async (label, count) => {
    const before = frames.length
    await zoomBurst()
    await page.waitForTimeout(300)
    const slice = frames.slice(before)
    console.log(label, '捕获合成帧数:', slice.length)
    slice.forEach((data, i) => {
      fs.writeFileSync(path.join(OUT, `flick-${label}-${String(i).padStart(3, '0')}.jpg`), Buffer.from(data, 'base64'))
    })
    return slice.length
  }

  await page.waitForTimeout(500)
  const n1 = await capture('base', 14)

  await page.addStyleTag({ content: '.canvas-theme-dark .tl-background { background-image: none !important; }' })
  await page.waitForTimeout(400)
  const n2 = await capture('nobg', 14)

  await page.addStyleTag({
    content: '.canvas-topbar, .multiselect-toolbar, .dock-minimap { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'
  })
  await page.waitForTimeout(400)
  const n3 = await capture('nobg-noblur', 14)

  console.log(JSON.stringify({ n1, n2, n3 }))
  await cdp.send('Page.stopScreencast').catch(() => undefined)
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
