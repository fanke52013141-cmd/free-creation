/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 浏览器验收：节点卡片与右侧设置面板必须共享同一份 props.config（NODE_UI_SPEC §16.25）。
// 回归的是「面板把挂载时的 config 拷进 useState，之后既显示过期值、又会把画布侧写入整份
// 覆盖回去」这一类缺陷；vitest 不挂载 React 组件，所以这条只能跑在浏览器通道里。
//
// 前置：npm run dev:browser -- --port 5199 --strictPort
// 运行：BROWSER_ORIGIN=http://127.0.0.1:5199 npm run test:browser-panel-sync
const { chromium } = require('playwright')
const assert = require('node:assert/strict')

const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5173'

async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const options of attempts) {
    try {
      return await chromium.launch({ ...options, headless: true, timeout: 30_000 })
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
  await page.goto(`${ORIGIN}/`)

  await page.getByRole('button', { name: '添加拆分节点', exact: true }).click()
  const topbarBottom = await page.evaluate(() => {
    const bar = document.querySelector('.canvas-topbar')
    return bar ? bar.getBoundingClientRect().bottom : 0
  })
  await page.waitForFunction(
    (minY) =>
      Math.min(
        ...Array.from(document.querySelectorAll('.node-card-wrap')).map(
          (c) => c.getBoundingClientRect().top
        )
      ) >= minY,
    topbarBottom
  )
  await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  const card = page.locator('.node-card-wrap:has(.type-image-split)').first()
  await card.waitFor()
  const cardRows = card.locator('.image-split-quick-controls label:has-text("行数") input')
  const cardColumns = card.locator('.image-split-quick-controls label:has-text("列数") input')
  const cardScale = card.locator('.image-split-quick-controls label:has-text("面积") input')

  await card.getByRole('button', { name: '打开节点说明' }).click()
  await page.getByRole('tab', { name: '设置', exact: true }).click()
  const panel = page.locator('.image-split-settings')
  await panel.waitFor()
  const panelRows = panel.locator('.image-split-controls label:has-text("行数") input')
  const panelColumns = panel.locator('.image-split-controls label:has-text("列数") input')
  const panelScale = panel.locator('.image-split-controls label:has-text("面积") input')
  assert.equal(await panelRows.inputValue(), '3', '面板挂载时应读到卡片默认行数')
  assert.equal(await panelScale.inputValue(), '100', '面板挂载时应读到卡片默认面积')

  // 卡片侧改行列：面板必须立刻跟随，而不是停在挂载时的那份快照。
  await cardRows.fill('2')
  await cardColumns.fill('4')
  assert.equal(await panelRows.inputValue(), '2', '卡片改行数后面板必须跟随（过期快照缺陷）')
  assert.equal(await panelColumns.inputValue(), '4', '卡片改列数后面板必须跟随（过期快照缺陷）')

  // 面板随后改面积：不得把卡片刚写的行列覆盖回 3×3。
  await panelScale.fill('40')
  await page.waitForFunction(() => {
    const controls = document.querySelector('.image-split-quick-controls')
    if (!controls) return false
    const scale = controls.querySelector('label:nth-of-type(3) input')
    return scale && scale.value === '40'
  })
  assert.equal(await cardRows.inputValue(), '2', '面板写面积不得回退卡片行数')
  assert.equal(await cardColumns.inputValue(), '4', '面板写面积不得回退卡片列数')
  assert.equal(await cardScale.inputValue(), '40', '面板面积改动必须回写卡片')
  // 无原图时网格不渲染，行列只体现在预览容器的 aria-label 上。
  assert.equal(
    await card.locator('.image-split-quick-grid').getAttribute('aria-label'),
    '2 行 4 列拆分预览',
    '卡片预览必须按新行列重算'
  )

  console.log('PASS: 卡片与设置面板共享文档真值，无过期快照覆盖')
  await browser.close()
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
