/* eslint-disable @typescript-eslint/no-require-imports */
// video-ai 设置面板专项检查（真实鼠标事件版）：tldraw 只响应真实指针事件。
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
  await page.waitForTimeout(800)

  // 启用深度视频
  await page.getByRole('button', { name: '项目菜单', exact: true }).click()
  await page.waitForSelector('.node-menu-item', { timeout: 5000 })
  await page
    .getByRole('button', { name: '工作台节点设置', exact: true })
    .evaluate((el) => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  await page.waitForSelector('.project-create-dialog', { timeout: 5000 })
  await page.waitForTimeout(400)
  const box = page.getByRole('checkbox', { name: '深度视频', exact: true })
  if ((await box.count()) > 0 && !(await box.isChecked())) await box.click()
  await page.locator('.project-create-submit').click()
  await page.waitForTimeout(1200)

  // 添加深度视频
  const before = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.node-card-wrap')).filter(
        (w) => w.getBoundingClientRect().height > 0
      ).length
  )
  await page.getByRole('button', { name: /展开视频创作节点/ }).hover()
  const item = page.getByRole('button', { name: /添加深度视频节点/ })
  await item.waitFor({ state: 'visible', timeout: 4000 })
  await item.click()
  await page.waitForTimeout(900)

  // 真实鼠标点击卡片中部选中（避开控件）
  const point = await page.evaluate(() => {
    const wraps = Array.from(document.querySelectorAll('.node-card-wrap')).filter(
      (w) => w.getBoundingClientRect().height > 0
    )
    const wrap = wraps[wraps.length - 1]
    const card = wrap.querySelector('.node-card')
    const r = card.getBoundingClientRect()
    for (const fy of [0.8, 0.9, 0.5]) {
      const x = Math.round(r.x + r.width / 2)
      const y = Math.round(r.y + r.height * fy)
      const hit = document.elementFromPoint(x, y)
      if (hit && card.contains(hit) && !hit.closest('button,input,select,textarea')) return { x, y }
    }
    return null
  })
  if (!point) throw new Error('找不到可点击区域')
  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(900)

  // 打开侧栏「设置」页
  const settingsTab = page.locator('button', { hasText: /^设置$/ }).first()
  if ((await settingsTab.count()) > 0) {
    await settingsTab.click({ force: true }).catch(() => undefined)
    await page.waitForTimeout(900)
  }
  await page.screenshot({ path: `${__dirname}/ui-video-ai-settings.png` })
  const info = await page.evaluate(() => {
    const panel = document.querySelector('.video-ai-settings')
    if (!panel) return { present: false }
    const trigger = panel.querySelector('.app-select-trigger')
    const install = panel.querySelector('.video-ai-install-button')
    const ics = install ? getComputedStyle(install) : null
    return {
      present: true,
      nativeSelects: panel.querySelectorAll('select').length,
      appSelects: panel.querySelectorAll('.app-select-trigger').length,
      triggerHeight: trigger ? trigger.getBoundingClientRect().height : null,
      installButton:
        install !== null
          ? {
              height: install.getBoundingClientRect().height,
              radius: ics.borderRadius,
              background: ics.backgroundColor,
              border: `${ics.borderWidth} ${ics.borderColor}`
            }
          : null
    }
  })
  console.log('SETTINGS:', JSON.stringify(info, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
