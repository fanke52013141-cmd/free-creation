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
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/app.ts')
      const { useResourceInsertRequest } = await import('/src/library/insertRequestStore.ts')
      const projectId = useAppStore.getState().currentProject.id
      const detail = {
        id: 'qa-resource',
        title: '复用测试',
        description: '',
        formPreset: 'prompt',
        latestRevisionId: 'v1',
        revisionNumber: 1,
        componentCount: 1,
        tags: [],
        collectionIds: [],
        updatedAt: 1,
        selectedRevisionId: 'v1',
        selectedRevisionNumber: 1,
        selectedTitle: '复用测试',
        selectedDescription: '',
        revisions: [],
        components: [
          {
            id: 'c',
            role: '提示词',
            valueType: 'recipe',
            text: '画一个{{subject}}',
            metadata: { variables: ['subject'] },
            order: 0
          }
        ]
      }
      window.api.getLibraryResource = async () => ({ ok: true, data: detail })
      window.api.previewLibraryFiles = async () => ({ ok: true, data: { missingComponentIds: [] } })
      window.api.materializeLibraryResource = async () => ({
        ok: true,
        data: {
          usageId: 'qa-usage',
          componentAssets: [],
          assets: [],
          textComponents: detail.components
        }
      })
      useResourceInsertRequest
        .getState()
        .set({ projectId, resourceId: detail.id, revisionId: 'v1', componentIds: ['c'] })
    })
    const modal = page.getByRole('dialog', { name: '加入资源节点' })
    await modal.waitFor()
    assert.equal(await modal.getByRole('button', { name: '预览并创建节点' }).isDisabled(), true)
    await modal.locator('input').fill('蓝色立方体')
    const before = await page.locator('.node-card-wrap').count()
    await modal.getByRole('button', { name: '预览并创建节点' }).click()
    await page.getByText(/将创建 1 个节点，复制 0 个文件/).waitFor()
    await page.getByRole('button', { name: '取消', exact: true }).last().click()
    assert.equal(await page.locator('.node-card-wrap').count(), before)
    await page.evaluate(() => {
      window.api.previewLibraryFiles = async () => ({
        ok: true,
        data: { missingComponentIds: ['c'] }
      })
    })
    await modal.getByRole('button', { name: '预览并创建节点' }).click()
    await modal.getByText('资源文件缺失或预检失败，尚未创建节点', { exact: true }).waitFor()
    assert.equal(await page.locator('.node-card-wrap').count(), before)
    await page.evaluate(() => {
      window.api.previewLibraryFiles = async () => ({ ok: true, data: { missingComponentIds: [] } })
    })
    await modal.getByRole('button', { name: '预览并创建节点' }).click()
    await page.getByRole('button', { name: '确认加入画布', exact: true }).click()
    await modal.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.node-card-wrap').count(), before + 1)
    await page.screenshot({ path: __dirname + '/reuse-ui.png' })
    await page.locator('.node-card-wrap .node-card').first().click({ button: 'right' })
    await page.getByRole('button', { name: '保存为可复用内容', exact: true }).click()
    const saveDialog = page.getByRole('dialog', { name: '保存为可复用内容' })
    await saveDialog.getByRole('radio', { name: /素材资源/ }).check()
    await saveDialog.getByRole('button', { name: '保存素材资源', exact: true }).waitFor()
    await saveDialog.getByRole('radio', { name: /流程模板/ }).check()
    await saveDialog.getByRole('button', { name: '保存流程模板', exact: true }).waitFor()
    await saveDialog.getByRole('button', { name: '关闭', exact: true }).click()
    fs.writeFileSync(
      __dirname + '/results.json',
      JSON.stringify(
        {
          passed: true,
          mode: 'browser with IPC fixtures',
          checks: ['变量未填禁止创建', '预览取消零节点变化', '缺文件零节点变化', '确认一次加入']
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
