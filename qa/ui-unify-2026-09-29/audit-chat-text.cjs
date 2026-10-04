/* eslint-disable @typescript-eslint/no-require-imports */
// 补测：chat（需经工作台节点设置启用）与 text 两个节点的运行时审查。
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

  // 启用 AI 对话（默认预设隐藏）
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
  const allBoxes = await page.evaluate(() => Array.from(document.querySelectorAll('.project-create-dialog input[type=checkbox]')).map((c) => c.closest('label')?.textContent?.trim() || c.getAttribute('aria-label') || '?'))
  console.log('CHECKBOXES:', JSON.stringify(allBoxes))
  const chatBox = page.getByRole('checkbox', { name: /对话/ })
  if ((await chatBox.count()) > 0 && !(await chatBox.isChecked())) await chatBox.click()
  await page.locator('.project-create-submit').click()
  await page.waitForTimeout(1200)

  const addNode = async (categoryPattern, itemPattern) => {
    const before = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('.node-card-wrap')).filter(
          (w) => w.getBoundingClientRect().height > 0
        ).length
    )
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.getByRole('button', { name: new RegExp(categoryPattern) }).hover()
      await page.waitForTimeout(400)
      const item = page.getByRole('button', { name: new RegExp(itemPattern) })
      try {
        await item.waitFor({ state: 'visible', timeout: 3500 })
        await item.click()
        break
      } catch {
        if (attempt === 1) {
          const names = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.palette-node-item')).map((b) => b.getAttribute('aria-label'))
          )
          console.log('FLYOUT-ITEMS:', JSON.stringify(names))
          return null
        }
      }
    }
    await page.waitForTimeout(600)
    return page.evaluate(() => {
      const wraps = Array.from(document.querySelectorAll('.node-card-wrap')).filter(
        (w) => w.getBoundingClientRect().height > 0
      )
      if (wraps.length < 1) return null
      return wraps[wraps.length - 1]?.getAttribute('data-node-id') ?? null
    })
  }

  const audit = (id) =>
    page.evaluate((nodeId) => {
      const wrap = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
      if (!wrap) return null
      const card = wrap.querySelector('.node-card')
      const buttons = Array.from(wrap.querySelectorAll('button'))
        .filter((b) => b.getBoundingClientRect().height > 0)
        .map((b) => {
          const s = getComputedStyle(b)
          return {
            label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 14),
            h: Math.round(b.getBoundingClientRect().height),
            radius: s.borderRadius,
            gradient: s.backgroundImage !== 'none'
          }
        })
      return {
        cardRadius: card ? getComputedStyle(card).borderRadius : null,
        nativeSelects: wrap.querySelectorAll('select').length,
        buttons
      }
    }, id)

  const evidence = {}
  for (const [key, cat, item] of [
    ['chat', '展开输入与', '对话节点'],
    ['text', '展开输入与', '文本节点']
  ]) {
    const id = await addNode(cat, item)
    if (!id) {
      evidence[key] = { skipped: true }
      continue
    }
    const wrap = page.locator(`.node-card-wrap[data-node-id="${id}"]`)
    await wrap.screenshot({ path: `${__dirname}/audit-${key}.png` })
    evidence[key] = await audit(id)
  }
  console.log(JSON.stringify(evidence, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
