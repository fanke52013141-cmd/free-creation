/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
    await page.goto(process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5202')
    await page.evaluate(async () => {
      const kinds = ['video', 'image', 'audio', 'text']
      const resources = kinds.map((kind, index) => ({
        id: `resource-${index}`, title: `资源 ${kind}`, iconKind: kind, description: index === 0 ? '测试说明' : '',
        formPreset: 'custom', latestRevisionId: 'v1', revisionNumber: 1, componentCount: 1,
        tags: [], collectionIds: [], folderIds: [], updatedAt: 100 - index
      }))
      window.api.getLibraryResource = async () => ({ ok: true, data: {
        ...resources[0], selectedTitle: resources[0].title, selectedRevisionId: 'v1',
        selectedRevisionNumber: 1, components: [],
        revisions: [{ id: 'v1', revisionNumber: 1, createdAt: 100 }]
      } })
      window.api.listLibraryCategories = async () => ({ ok: true, data: [] })
      window.api.searchLibrary = async () => ({ ok: true, data: { items: resources, nextCursor: null } })
      const { useAppStore } = await import('/src/stores/app.ts')
      useAppStore.getState().setHome()
    })
    await page.getByRole('button', { name: '资源库', exact: true }).click()
    await page.getByRole('button', { name: '资源 video 测试说明' }).waitFor()
    const search = page.getByRole('textbox', { name: '搜索资源' })
    assert.equal(await search.getAttribute('placeholder'), null)
    assert.equal(await page.locator('.library-resource-card-title span').count(), 0)
    assert.equal(await page.locator('.library-resource-card-body p').count(), 1)
    for (const kind of ['video', 'image', 'audio', 'text']) {
      const card = page.locator('.library-resource-card').filter({ hasText: `资源 ${kind}` })
      assert.equal(await card.locator('.library-default-cover').getAttribute('data-icon-kind'), kind)
      assert.equal(await card.locator('.library-resource-cover img').count(), 0)
    }
    assert.equal(await page.getByRole('button', { name: '导入资产包' }).count(), 1)
    assert.equal(await page.locator('.library-default-cover').first().evaluate((icon) =>
      getComputedStyle(icon).backgroundColor), 'rgba(0, 0, 0, 0)')
    await page.getByRole('button', { name: '资源 video 测试说明' }).click()
    const detail = page.getByRole('dialog', { name: '资源详情' })
    await detail.getByRole('heading', { name: '资源 video', exact: true }).waitFor()
    assert.equal(await detail.locator('header').getByText('1.0', { exact: true }).count(), 0)
    const revision = detail.getByRole('group', { name: '资源版本历史' })
    assert.equal(await revision.locator('strong').innerText(), '1.0')
    assert.match(await revision.locator('time').innerText(), /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/)

    if (process.env.LIBRARY_CARDS_SCREENSHOT) await page.screenshot({ path: process.env.LIBRARY_CARDS_SCREENSHOT })
    console.log('PASS: resource cards, empty descriptions and toolbar')
  } finally {
    await browser.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
