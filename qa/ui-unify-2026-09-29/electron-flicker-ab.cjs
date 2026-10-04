/* eslint-disable @typescript-eslint/no-require-imports */
// 同构建运行时 A/B：旧构建实例上依次注入修复②③，同 harness 对比缩放期间合成帧抖动。
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const OUT = __dirname

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => String(p.url()).startsWith('http')) || ctx.pages()[0]
  await page.bringToFront()
  // 确保在画布内：不在则新建项目进入
  if ((await page.locator('.palette-category-item').count()) === 0) {
    await page.getByRole('button', { name: '新建项目' }).click()
    await page.locator('input[placeholder="给这个项目起个名字"]').fill('闪烁A-B')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.palette-category-item').first().waitFor({ timeout: 20000 })
  }
  // 放两个节点，让缩放期间有真实内容损伤
  for (const [cat, item] of [
    ['展开输入与', '文本节点'],
    ['展开图片创作', '生图节点']
  ]) {
    await page.getByRole('button', { name: new RegExp(cat) }).hover()
    await page
      .getByRole('button', { name: new RegExp(item) })
      .waitFor({ timeout: 4000 })
      .catch(() => undefined)
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
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    everyNthFrame: 1,
    maxWidth: 1400
  })

  const zoomBurst = async (ms = 3000) => {
    const box = await page.evaluate(() => {
      const r = (document.querySelector('.tl-canvas') || document.body).getBoundingClientRect()
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

  const capture = async (label) => {
    const before = frames.length
    await zoomBurst()
    await page.waitForTimeout(300)
    const slice = frames.slice(before)
    slice.forEach((data, i) => {
      const name = `flick-${label}-${String(i).padStart(3, '0')}.jpg`
      fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'))
    })
    console.log(label, 'frames:', slice.length)
  }

  await page.waitForTimeout(600)
  await capture('a-old')

  // 修复②：点阵搬屏幕空间（与源码修复等价的运行时注入）
  await page.addStyleTag({
    content:
      '.canvas-theme-dark .tl-background { background: transparent !important; } ' +
      '.canvas-theme-dark.canvas-page { background-color: #111419; ' +
      'background-image: radial-gradient(circle at 1px 1px, rgba(202,216,235,0.12) 0.72px, transparent 0.85px), radial-gradient(circle at 1px 1px, rgba(202,216,235,0.055) 0.72px, transparent 0.85px), radial-gradient(ellipse at 50% 42%, rgba(66,185,245,0.035), transparent 48%); ' +
      'background-position: 0 0, 48px 48px, 0 0; background-size: 24px 24px, 96px 96px, 100% 100%; }'
  })
  await page.waitForTimeout(500)
  await capture('b-dots')

  // 修复③：底座/小地图/多选工具条去模糊、不透明底
  await page.addStyleTag({
    content:
      '.dock-minimap, .multiselect-toolbar { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background: #1a1f26 !important; }'
  })
  await page.waitForTimeout(500)
  await capture('c-noblur')

  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
