/* eslint-disable @typescript-eslint/no-require-imports */
// video-ai 设置面板运行时验证（真实鼠标事件）：启用深度视频 → 建卡 → 打开节点说明 → 设置页
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
  await page.getByRole('button', { name: /展开视频创作节点/ }).hover()
  const item = page.getByRole('button', { name: /添加深度视频节点/ })
  await item.waitFor({ state: 'visible', timeout: 4000 })
  await item.click()
  await page.waitForTimeout(900)

  // 真实鼠标点击卡片选中，再点头部「打开节点说明」
  const pt = await page.evaluate(() => {
    const wraps = Array.from(document.querySelectorAll('.node-card-wrap')).filter(
      (w) => w.getBoundingClientRect().height > 0
    )
    const wrap = wraps[wraps.length - 1]
    const card = wrap.querySelector('.node-card')
    const r = card.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.8) }
  })
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(700)
  const infoBtn = page.getByRole('button', { name: '打开节点说明' })
  if ((await infoBtn.count()) === 0) throw new Error('没找到 打开节点说明 按钮')
  await infoBtn.click()
  await page.waitForTimeout(900)

  // 切到「设置」页签
  const setTab = page.locator('button', { hasText: /^设置$/ }).first()
  await setTab.click()
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${__dirname}/audit-video-ai-settings.png` })

  const info = await page.evaluate(() => {
    const panel = document.querySelector('.video-ai-settings')
    if (!panel) return { present: false }
    const triggers = Array.from(panel.querySelectorAll('.app-select-trigger')).map((t) => ({
      text: t.textContent.trim().slice(0, 20),
      h: Math.round(t.getBoundingClientRect().height),
      radius: getComputedStyle(t).borderRadius
    }))
    const install = panel.querySelector('.video-ai-install-button')
    const ics = install ? getComputedStyle(install) : null
    return {
      present: true,
      nativeSelects: panel.querySelectorAll('select').length,
      appSelects: triggers,
      installButton:
        install !== null
          ? {
              height: Math.round(install.getBoundingClientRect().height),
              radius: ics.borderRadius,
              background: ics.backgroundColor,
              gradient: ics.backgroundImage !== 'none'
            }
          : null
    }
  })
  console.log('VIDEO-AI-SETTINGS:', JSON.stringify(info, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
