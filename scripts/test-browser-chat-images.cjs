/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Deterministic UI fixture, not a paid supplier acceptance.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const out = path.resolve('artifacts/chat-image-skill-2026-10-06/browser')
  fs.mkdirSync(out, { recursive: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5191')
    await page.locator('.node-palette').waitFor()
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const store = (await import('/src/stores/gateway.ts')).useGatewayStore
      const provider = { id: 'qa-images', name: '本地测试夹具', specId: 'toapis', baseURL: 'https://example.invalid',
        hasApiKey: true, createdAt: 0, models: [{ id: 'gpt-image-2-vip', modality: 'image', operations: ['image.generate'] }, { id: 'text-fixture', modality: 'text' }] }
      store.setState({ providers: [provider], loaded: true })
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.createShape({ id: 'shape:chat-images', type: 'node-card', x: 340, y: 180, props: { nodeType: 'chat', title: '生图对话', text: JSON.stringify({
        messages: [], modelKey: 'qa-images::text-fixture', autoCompress: false,
        imageSkill: { enabled: true, modelKey: 'qa-images::gpt-image-2-vip', resolution: '1k' }
      }) } })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      window.__chatImageCalls = []
      window.__chatDownloadCalls = []
      const project = (await import('/src/stores/app.ts')).useAppStore.getState().currentProject
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024
      const context = canvas.getContext('2d'); context.fillStyle = '#2677dd'; context.fillRect(0, 0, 1024, 1024)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
      window.api.gateway.imageGenerate = async input => {
        window.__chatImageCalls.push(input)
        return window.api.importMediaBuffer({ projectId: project.id, data: bytes, mime: 'image/png', name: '本地生图测试.png' })
      }
      window.api.batchExportMedia = async (projectId, ids) => {
        window.__chatDownloadCalls.push({ projectId, ids })
        return { ok: true, data: { exported: ids.length, failed: 0, targetDir: 'fixture-download' } }
      }
    })
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await page.getByRole('combobox', { name: '发送方式', exact: true }).click()
    await page.getByRole('option', { name: '生图', exact: true }).click()
    await page.getByRole('textbox', { name: '输入消息' }).fill('画一张蓝色背景')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.locator('.chat-dialog-image img').waitFor()
    await page.waitForFunction(() => document.querySelector('.chat-dialog-image img')?.naturalWidth === 1024)
    assert.equal(await page.evaluate(() => window.__chatImageCalls[0].resolution), '1k')
    await page.locator('.chat-dialog-image-open').first().click()
    await page.getByRole('dialog', { name: '图片预览', exact: true }).waitFor()
    await page.screenshot({ path: path.join(out, 'preview.png') })
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog', { name: '图片预览', exact: true }).count(), 0)
    assert.equal(await page.locator('.chat-dialog').count(), 1)
    await page.locator('.chat-dialog-image figcaption').getByRole('button', { name: /^下载图片/ }).first().click()
    assert.equal(await page.evaluate(() => window.__chatDownloadCalls.length), 1)
    await page.getByRole('combobox', { name: '生图分辨率', exact: true }).click()
    await page.getByRole('option', { name: '4K', exact: true }).click()
    await page.getByRole('textbox', { name: '输入消息' }).fill('再画一张')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.chat-dialog-image').length === 2)
    await page.getByRole('textbox', { name: '输入消息' }).fill('下一轮可继续发送')
    await page.waitForFunction(() => !document.querySelector('.chat-dialog-send')?.disabled)
    const geometry = await page.locator('.chat-dialog-composer textarea').boundingBox()
    assert.ok(geometry.width > 300, `Composer input too narrow: ${geometry.width}`)
    assert.equal(await page.evaluate(() => window.__chatImageCalls[1].resolution), '4k')
    await page.screenshot({ path: path.join(out, 'conversation.png') })
    const snapshot = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.store.getStoreSnapshot('document'))
    await page.getByRole('button', { name: '关闭对话', exact: true }).click()
    await page.evaluate(async snapshot => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.store.loadStoreSnapshot(snapshot)
    }, snapshot)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    assert.equal(await page.locator('.chat-dialog-image').count(), 2)
    await page.getByRole('button', { name: '对话设置', exact: true }).click()
    await page.getByLabel('允许对话生成图片').click()
    await page.waitForFunction(() => !document.querySelector('.chat-dialog-image-settings input[type="checkbox"]')?.checked)
    await page.getByRole('button', { name: '对话设置', exact: true }).click()
    assert.equal(await page.getByRole('combobox', { name: '生图分辨率' }).count(), 0)
    const result = { passed: true, fixture: true, imageCount: 2, previewEscape: true, downloadDispatch: true, snapshotRestore: true }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log('对话生图1K/4K、真实PNG展示、预览/Escape、下载参数、附件快照与技能开关通过（本地夹具）')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
