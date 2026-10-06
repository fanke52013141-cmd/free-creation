/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Explicit paid acceptance: isolated data directory and --configured-live are required.
const { _electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
;(async () => {
  const resumeProject = process.env.CHAT_IMAGE_QA_RESUME_PROJECT
  assert.ok(resumeProject || process.argv.includes('--configured-live'), 'Requires explicit --configured-live (one paid 1K call)')
  const dataDir = process.env.CHAT_IMAGE_QA_DATA_DIR
  assert.ok(dataDir && fs.existsSync(path.join(dataDir, 'app.db')), 'Requires isolated configured QA database')
  const out = path.resolve('artifacts/chat-image-skill-2026-10-06/electron')
  const downloadDir = path.join(out, `download-${Date.now()}`)
  fs.mkdirSync(downloadDir, { recursive: true })
  const launch = () => _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.'], env: { ...process.env, NODE_ENV: 'development', ELECTRON_RENDERER_URL: process.env.CANVAS_QA_URL || 'http://127.0.0.1:5191', CANVAS_DATA_DIR: dataDir } })
  let app = await launch()
  const facts = { paidCalls: 1, requestedResolution: '1k', quality: 'low' }
  try {
    let page = await app.firstWindow()
    await page.locator('.node-palette').or(page.getByRole('button', { name: '新建项目', exact: true })).first().waitFor()
    if (resumeProject) {
      Object.assign(facts, JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')))
      if (await page.locator('.node-palette').isVisible()) await page.getByRole('button', { name: '回到主页', exact: true }).click()
      await page.evaluate(async id => {
        const project = (await window.api.listProjects()).data.find(item => item.id === id)
        ;(await import('/src/stores/app.ts')).useAppStore.getState().openProject(project)
      }, resumeProject)
      await page.locator('.node-palette').waitFor()
      await page.getByRole('button', { name: '打开对话', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.chat-dialog-image img')?.naturalWidth === 1024)
      facts.projectId = resumeProject
      facts.status = 'success'
      facts.dimensions = await page.locator('.chat-dialog-image img').evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight }))
      const image = await page.evaluate(async () => JSON.parse((await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:live-chat-images').props.text).messages.at(-1).images[0])
      const original = fs.readFileSync(path.join(dataDir, image.mediaPath))
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, downloadDir)
      const download = page.locator('.chat-dialog-image figcaption').getByRole('button', { name: /^下载图片/ })
      for (let index = 0; index < 2; index++) {
        await download.click()
        const deadline = Date.now() + 10000
        while (fs.readdirSync(downloadDir).length < index + 1 && Date.now() < deadline) await page.waitForTimeout(100)
        assert.equal(fs.readdirSync(downloadDir).length, index + 1)
      }
      const hash = bytes => createHash('sha256').update(bytes).digest('hex')
      facts.downloadMatchesAsset = fs.readdirSync(downloadDir).every(file => hash(fs.readFileSync(path.join(downloadDir, file))) === hash(original))
      assert.equal(facts.downloadMatchesAsset, true)
      facts.duplicateDownloadDoesNotOverwrite = true
      await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
      await download.click()
      await page.waitForTimeout(300)
      assert.equal(fs.readdirSync(downloadDir).length, 2)
      facts.cancelDownload = true
      await page.locator('.chat-dialog-image-open').click()
      await page.getByRole('dialog', { name: '图片预览', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      facts.preview = await page.getByRole('dialog', { name: '图片预览', exact: true }).count() === 0
      facts.restartRestoresImage = true
      facts.persisted4k = await page.evaluate(async () => JSON.parse((await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:live-chat-images').props.text).imageSkill.resolution === '4k')
      assert.equal(facts.persisted4k, true)
      facts.passed = true
      await page.screenshot({ path: path.join(out, 'restored.png') })
      console.log('PASS actual image restored after process restart; no additional model call')
      return
    }
    if (await page.locator('.node-palette').isVisible()) await page.getByRole('button', { name: '回到主页', exact: true }).click()
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    const projectName = `对话生图验收-${Date.now()}`
    await page.locator('input[placeholder="给这个项目起个名字"]').fill(projectName)
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.node-palette').waitFor()
    facts.projectId = await page.evaluate(async name => (await window.api.listProjects()).data.find(item => item.name === name).id, projectName)
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const store = (await import('/src/stores/gateway.ts')).useGatewayStore
      await store.getState().load()
      const provider = store.getState().providers.find(item => item.specId === 'toapis' && item.models.some(model => model.id === 'gpt-image-2-vip'))
      if (!provider) throw new Error('Configured image provider missing')
      editor.createShape({ id: 'shape:live-chat-images', type: 'node-card', x: 340, y: 150, props: { nodeType: 'chat', title: '真实生图对话', text: JSON.stringify({ messages: [], autoCompress: false, imageSkill: { enabled: true, modelKey: `${provider.id}::gpt-image-2-vip`, resolution: '1k' } }) } })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    })
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    // No text model is needed for explicit generation; close the initial settings form.
    if (await page.locator('.chat-dialog-settings').isVisible()) await page.getByRole('button', { name: '对话设置', exact: true }).click()
    await page.getByRole('combobox', { name: '发送方式', exact: true }).click()
    await page.getByRole('option', { name: '生图', exact: true }).click()
    await page.getByRole('textbox', { name: '输入消息' }).fill('纯白背景，中间一个蓝色圆形，无文字。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
      const status = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:live-chat-images').meta.nodeRun?.status)
      if (['success', 'failed', 'skipped'].includes(status)) break
      await page.waitForTimeout(1000)
    }
    const state = await page.evaluate(async () => {
      const shape = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:live-chat-images')
      return { run: shape.meta.nodeRun, data: JSON.parse(shape.props.text) }
    })
    facts.status = state.run.status
    if (facts.status !== 'success') throw new Error(`Generation failed: ${state.run.error?.reason || state.run.reason || facts.status}`)
    const image = state.data.messages.at(-1).images[0]
    await page.waitForFunction(() => document.querySelector('.chat-dialog-image img')?.naturalWidth > 0)
    facts.dimensions = await page.locator('.chat-dialog-image img').evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight }))
    assert.equal(facts.dimensions.width, 1024)
    const original = fs.readFileSync(path.join(dataDir, image.mediaPath))
    await page.locator('.chat-dialog-image-open').click()
    await page.getByRole('dialog', { name: '图片预览', exact: true }).waitFor()
    await page.screenshot({ path: path.join(out, 'preview.png') })
    await page.keyboard.press('Escape')
    facts.preview = await page.getByRole('dialog', { name: '图片预览', exact: true }).count() === 0
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, downloadDir)
    await page.locator('.chat-dialog-image figcaption').getByRole('button', { name: /^下载图片/ }).click()
    await page.waitForFunction(() => document.body.textContent.includes('图片已下载到所选目录'))
    const files = fs.readdirSync(downloadDir)
    assert.equal(files.length, 1)
    const hash = bytes => createHash('sha256').update(bytes).digest('hex')
    facts.downloadMatchesAsset = hash(original) === hash(fs.readFileSync(path.join(downloadDir, files[0])))
    assert.equal(facts.downloadMatchesAsset, true)
    await page.screenshot({ path: path.join(out, 'conversation.png') })
    await page.getByRole('combobox', { name: '生图分辨率', exact: true }).click()
    await page.getByRole('option', { name: '4K', exact: true }).click()
    // Save through the normal autosave cycle, then verify a process restart.
    await page.waitForTimeout(2500)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.locator('.node-palette').or(page.getByRole('button', { name: '新建项目', exact: true })).first().waitFor()
    if (await page.locator('.node-palette').isVisible()) await page.getByRole('button', { name: '回到主页', exact: true }).click()
    await page.getByText(projectName, { exact: true }).dblclick()
    await page.locator('.node-palette').waitFor()
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.chat-dialog-image img')?.naturalWidth === 1024)
    facts.restartRestoresImage = true
    facts.persisted4k = await page.evaluate(async () => JSON.parse((await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:live-chat-images').props.text).imageSkill.resolution === '4k')
    assert.equal(facts.persisted4k, true)
    facts.passed = true
    console.log('PASS actual configured 1K image, preview, file download SHA256, process restart and 4K setting persistence')
  } finally {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(facts, null, 2))
    await app.close()
  }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
