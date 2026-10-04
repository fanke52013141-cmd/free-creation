/* eslint-disable @typescript-eslint/no-require-imports */
// 缩放闪烁归因实验：滚轮缩放期间采集 rAF 帧间隔；对比「原样式」与「去掉背景渐变」两组。
const { chromium } = require('playwright')

const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5333'

async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const options of attempts) {
    try {
      return await chromium.launch({ ...options, headless: true })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function main() {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(10_000)
  await page.goto(`${ORIGIN}/`, { timeout: 30_000 })
  await page.waitForSelector('.palette-category-item', { timeout: 20_000 })
  await page.waitForTimeout(1000)

  const runZoom = async (label) => {
    // 在画布中心滚动缩放 2.5 秒，期间收集 rAF 间隔
    const box = await page.evaluate(() => {
      const el = document.querySelector('.tl-canvas') || document.body
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.evaluate(() => {
      window.__deltas = []
      window.__rec = true
      const tick = (t) => {
        if (!window.__last) window.__last = t
        window.__deltas.push(t - window.__last)
        window.__last = t
        if (window.__rec) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.mouse.move(box.x, box.y)
    const end = Date.now() + 2500
    let up = true
    while (Date.now() < end) {
      await page.mouse.wheel(0, up ? -240 : 240)
      up = !up
      await page.waitForTimeout(40)
    }
    const stats = await page.evaluate(() => {
      window.__rec = false
      const d = window.__deltas.slice(5)
      const sorted = [...d].sort((a, b) => a - b)
      const sum = d.reduce((a, b) => a + b, 0)
      return {
        frames: d.length,
        avg: Math.round((sum / d.length) * 10) / 10,
        p50: sorted[Math.floor(d.length * 0.5)],
        p95: sorted[Math.floor(d.length * 0.95)],
        worst: sorted[sorted.length - 1],
        jank: d.filter((x) => x > 40).length
      }
    })
    console.log(label, JSON.stringify(stats))
    return stats
  }

  const base = await runZoom('WITH-gradients ')
  // 注入覆盖：去掉背景渐变（仅实验，不改仓库文件）
  await page.addStyleTag({
    content: '.canvas-theme-dark .tl-background { background-image: none !important; }'
  })
  await page.waitForTimeout(400)
  const none = await runZoom('NO-background  ')
  console.log('VERDICT:', {
    p95_improved_ms: base.p95 - none.p95,
    jank_base: base.jank,
    jank_without_bg: none.jank
  })
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
