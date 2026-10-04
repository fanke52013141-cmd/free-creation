/* eslint-disable @typescript-eslint/no-require-imports */
// T01/F16 浏览器实测：生图、AI处理、语音合成三卡在演示模式运行，
// 断言不出现裸 JS 异常（此前 resolveBinding undefined 崩溃）。
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
  const rawErrors = []
  page.on('pageerror', (e) => rawErrors.push(`pageerror: ${String(e).slice(0, 120)}`))

  await page.goto(`${ORIGIN}/`, { timeout: 30_000 })
  await page.waitForSelector('.palette-category-item', { timeout: 20_000 })
  await page.waitForTimeout(800)

  const addNode = async (cat, item) => {
    const before = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('.node-card-wrap')).filter(
          (w) => w.getBoundingClientRect().height > 0
        ).length
    )
    for (let i = 0; i < 2; i += 1) {
      await page.getByRole('button', { name: new RegExp(cat) }).hover()
      await page.waitForTimeout(350)
      const btn = page.getByRole('button', { name: new RegExp(item) })
      try {
        await btn.waitFor({ state: 'visible', timeout: 3000 })
        await btn.click()
        break
      } catch {
        continue
      }
    }
    await page.waitForTimeout(600)
    const ok = await page.evaluate(
      (n) =>
        Array.from(document.querySelectorAll('.node-card-wrap')).filter(
          (w) => w.getBoundingClientRect().height > 0
        ).length ===
        n + 1,
      before
    )
    if (!ok) return null
    return page.evaluate(() => {
      const wraps = Array.from(document.querySelectorAll('.node-card-wrap')).filter(
        (w) => w.getBoundingClientRect().height > 0
      )
      return wraps[wraps.length - 1].getAttribute('data-node-id')
    })
  }

  const runAndGetState = async (id) => {
    await page.locator(`.node-card-wrap[data-node-id="${id}"] .node-run-btn`).click()
    await page.waitForTimeout(2500)
    return page.evaluate((nodeId) => {
      const wrap = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
      const status = wrap.querySelector('.node-status')
      const toasts = Array.from(document.querySelectorAll('[class*="toast" i]'))
        .map((t) => t.textContent.trim())
        .filter(Boolean)
      return {
        aria: status?.getAttribute('aria-label') ?? '',
        toastText: toasts.join(' | ').slice(0, 200),
        hasRawException: toasts.some((t) =>
          /Cannot read properties|is not a function|undefined/i.test(t)
        )
      }
    }, id)
  }

  const results = {}

  // 1) 生图：填提示词后运行（演示模型绑定 ok 场景）
  const gen = await addNode('展开图片创作', '添加生图节点')
  if (gen) {
    await page
      .locator(`.node-card-wrap[data-node-id="${gen}"] textarea.gen-prompt`)
      .fill('蓝色立方体')
    results.imageGen = await runAndGetState(gen)
    await page.locator(`.node-card-wrap[data-node-id="${gen}"]`).screenshot({
      path: `${__dirname}/t01-imagegen-run.png`
    })
  } else results.imageGen = { skipped: true }

  // 2) AI 处理：启用后建卡运行
  await page.getByRole('button', { name: '项目菜单', exact: true }).click()
  await page.waitForSelector('.node-menu-item', { timeout: 5000 })
  await page.getByRole('button', { name: '工作台节点设置', exact: true }).evaluate((el) => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForSelector('.project-create-dialog', { timeout: 5000 })
  const box = page.getByRole('checkbox', { name: 'AI 处理', exact: true })
  if ((await box.count()) > 0 && !(await box.isChecked())) await box.click()
  await page.locator('.project-create-submit').click()
  await page.waitForTimeout(1200)
  const ai = await addNode('展开输入与', 'AI.?处理')
  if (ai) {
    results.aiProcess = await runAndGetState(ai)
    await page.locator(`.node-card-wrap[data-node-id="${ai}"]`).screenshot({
      path: `${__dirname}/t01-aiprocess-run.png`
    })
  } else results.aiProcess = { skipped: true }

  // 3) 语音合成：无文本运行（应得业务提示而非异常）
  const speech = await addNode('展开声音创作', '添加语音合成节点')
  if (speech) {
    results.speech = await runAndGetState(speech)
    await page.locator(`.node-card-wrap[data-node-id="${speech}"]`).screenshot({
      path: `${__dirname}/t01-speech-run.png`
    })
  } else results.speech = { skipped: true }

  results.rawPageErrors = rawErrors
  console.log(JSON.stringify(results, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
