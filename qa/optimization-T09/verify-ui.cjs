/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  try {
    await page.goto('http://127.0.0.1:5191')
    await page.waitForSelector('.palette-category-item')
    await page.getByRole('button', { name: /展开图片创作/ }).hover()
    await page.getByRole('button', { name: /添加生图节点/ }).click()
    const card = page
      .locator('.node-card-wrap')
      .filter({ has: page.locator('.gen-prompt') })
      .last()
    await card.locator('textarea.gen-prompt').fill('蓝色立方体')
    await card.locator('textarea.gen-prompt').press('Tab')
    await card.locator('.node-run-btn').click()
    await page.waitForTimeout(3000)
    assert.match(await card.locator('.node-status').getAttribute('aria-label'), /成功/)
    await card.getByRole('button', { name: '固定当前输出', exact: true }).click()
    await card.getByText('已固定输出', { exact: true }).waitFor()
    await card.locator('textarea.gen-prompt').fill('红色球体')
    await card.locator('textarea.gen-prompt').press('Tab')
    assert.match(await card.locator('.node-status').getAttribute('aria-label'), /输入已修改/)
    await card.getByRole('button', { name: '解除固定', exact: true }).click()
    await page
      .getByText('下游将改用当前候选结果，来源可能变化。是否解除固定？', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await card.getByText('已固定输出', { exact: true }).waitFor()
    await card.getByRole('button', { name: '解除固定', exact: true }).click()
    await page.getByRole('button', { name: '解除固定', exact: true }).last().click()
    await card.getByText('输入已修改 · 保留旧结果', { exact: true }).waitFor()
    await card.screenshot({ path: __dirname + '/freshness-ui.png' })
    fs.writeFileSync(
      __dirname + '/results.json',
      JSON.stringify(
        {
          passed: true,
          checks: [
            '生成成功',
            '固定输出',
            '修改正文过期',
            '解除固定提示',
            '取消保留固定',
            '确认解除固定保留旧结果'
          ]
        },
        null,
        2
      )
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
