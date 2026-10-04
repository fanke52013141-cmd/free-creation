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
    await card.locator('textarea.gen-prompt').fill('长期来源测试：蓝色立方体')
    await card.locator('textarea.gen-prompt').press('Tab')
    await card.locator('.node-run-btn').click()
    await page.waitForTimeout(3000)
    assert.match(await card.locator('.node-status').getAttribute('aria-label'), /成功/)
    const saved = await page.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/app.ts')
      const projectId = useAppStore.getState().currentProject.id
      const assets = await window.api.listMedia(projectId)
      for (const asset of assets.data) {
        const recipe = await window.api.getArtifactRecipe({ projectId, mediaId: asset.id })
        if (recipe.ok && recipe.data) return recipe.data
      }
      return null
    })
    assert.equal(saved.fullPrompt, '长期来源测试：蓝色立方体')
    assert.ok(saved.modelKey)
    await page.getByRole('button', { name: '打开资产管理', exact: true }).click()
    const buttons = page.getByRole('button', { name: '查看生成来源', exact: true })
    for (let i = 0; i < (await buttons.count()); i++) {
      await buttons.nth(i).click()
      await page.waitForTimeout(150)
      if (await page.locator('.asset-recipe textarea').count()) break
    }
    await page.locator('.asset-recipe textarea').first().waitFor()
    assert.equal(
      await page.locator('.asset-recipe textarea').first().inputValue(),
      saved.fullPrompt
    )
    await page.screenshot({ path: __dirname + '/source-ui.png' })
    fs.writeFileSync(
      __dirname + '/results.json',
      JSON.stringify(
        {
          passed: true,
          mode: 'browser in-memory recipe store',
          checks: ['实际生成写入来源', '完整提交提示词', '模型身份', '素材面板查看来源']
        },
        null,
        2
      )
    )
  } finally {
    await browser.close()
  }
})().catch((e) => {
  process.stderr.write(String(e))
  process.exitCode = 1
})
