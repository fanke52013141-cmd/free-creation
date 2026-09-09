/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 浏览器节点视觉审查：为每个左侧“添加节点”入口生成单卡截图和结构化布局数据。
 * 仅作用于 browserMock 的隔离页面，不读写桌面项目。
 *
 * Usage: node scripts/audit-node-ui.cjs [baseUrl] [outputDir]
 */
const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3123/'
const outputDir = process.argv[3] ?? join(process.cwd(), 'artifacts', 'node-ui-audit')

function safeFileName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '')
}

async function main() {
  mkdirSync(outputDir, { recursive: true })
  let browser
  let lastError
  for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      browser = await chromium.launch({ ...options, headless: true })
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!browser) throw lastError
  try {
    // 首先只发现入口；每个节点随后使用独立上下文，避免 browserMock / tldraw 的
    // 历史节点顺序影响“新建节点”的定位。
    const discoveryContext = await browser.newContext({ viewport: { width: 1708, height: 879 } })
    const discoveryPage = await discoveryContext.newPage()
    discoveryPage.setDefaultTimeout(8_000)
    await discoveryPage.goto(baseUrl, { waitUntil: 'networkidle' })
    const addButtons = await discoveryPage
      .locator('button[aria-label^="添加"]')
      .evaluateAll((buttons) =>
        buttons
          .map((button) => ({
            label: button.getAttribute('aria-label') ?? '',
            text: button.textContent?.trim() ?? ''
          }))
          .filter((button) => /添加.+节点/.test(button.label))
      )
    await discoveryContext.close()
    const records = []
    for (const entry of addButtons) {
      const context = await browser.newContext({ viewport: { width: 1708, height: 879 } })
      const page = await context.newPage()
      page.setDefaultTimeout(8_000)
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      const beforeIds = await page
        .locator('.node-card-wrap[data-node-id]')
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-node-id')).filter(Boolean)
        )
      await page.getByRole('button', { name: entry.label, exact: true }).click()
      const newId = await page
        .waitForFunction((knownIds) => {
          const cards = Array.from(document.querySelectorAll('.node-card-wrap[data-node-id]'))
          return (
            cards
              .map((card) => card.getAttribute('data-node-id'))
              .find((id) => id && !knownIds.includes(id)) ?? null
          )
        }, beforeIds)
        .then((handle) => handle.jsonValue())
      const card = page.locator(`.node-card-wrap[data-node-id="${newId}"]`)
      await card.scrollIntoViewIfNeeded()
      const audit = await card.evaluate((element) => {
        const cardElement = element.querySelector('.node-card')
        const body = element.querySelector('.node-body')
        const rect = element.getBoundingClientRect()
        const cardRect = cardElement?.getBoundingClientRect()
        const bodyRect = body?.getBoundingClientRect()
        return {
          nodeType: cardElement?.getAttribute('data-node-type') ?? 'unknown',
          title: element.querySelector('.node-title')?.textContent?.trim() ?? '',
          rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
          cardRect: cardRect ? { width: cardRect.width, height: cardRect.height } : null,
          bodyRect: bodyRect ? { width: bodyRect.width, height: bodyRect.height } : null,
          overflow: body
            ? { x: body.scrollWidth > body.clientWidth, y: body.scrollHeight > body.clientHeight }
            : null,
          inputs: element.querySelectorAll('.port-dot.in').length,
          outputs: element.querySelectorAll('.port-dot.out').length,
          buttons: Array.from(element.querySelectorAll('button')).map(
            (button) => button.textContent?.trim() ?? ''
          ),
          text: element.textContent?.replace(/\s+/g, ' ').trim() ?? ''
        }
      })
      const fileStem = `${String(records.length + 1).padStart(2, '0')}-${safeFileName(audit.nodeType)}`
      // 标题栏和端口都刻意位于卡片 page bounds 外，因此不能用 locator.screenshot()
      // 截断它们；扩展裁剪区后才能用于视觉审查。
      const box = await card.boundingBox()
      if (!box) throw new Error(`无法读取 ${audit.nodeType} 的截图边界`)
      const padding = { left: 30, right: 30, top: 44, bottom: 14 }
      const clip = {
        x: Math.max(0, box.x - padding.left),
        y: Math.max(0, box.y - padding.top),
        width:
          Math.min(1708, box.x + box.width + padding.right) - Math.max(0, box.x - padding.left),
        height:
          Math.min(879, box.y + box.height + padding.bottom) - Math.max(0, box.y - padding.top)
      }
      await page.screenshot({ path: join(outputDir, `${fileStem}.png`), clip })
      records.push({ entry, screenshot: `${fileStem}.png`, ...audit })
      await context.close()
    }
    writeFileSync(
      join(outputDir, 'report.json'),
      JSON.stringify({ baseUrl, viewport: { width: 1708, height: 879 }, nodes: records }, null, 2)
    )
    console.log(JSON.stringify({ outputDir, count: records.length, nodes: records }, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
