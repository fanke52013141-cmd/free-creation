/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { launchQaBrowser } = require('./qa-browser.cjs')
const { qaOutputPath } = require('./qa-output.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
;(async () => {
  const browser = await launchQaBrowser()
  const output = qaOutputPath('qa/skill-agent/browser')
  fs.mkdirSync(output, { recursive: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    let baselineAssetErrors = 0
    page.on('pageerror', error => {
      if (error.message === 'The source image cannot be decoded.' || error.stack?.includes('fetchTranslation')) baselineAssetErrors++
      else errors.push(error.stack)
    })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5194')
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      for (const [index, type] of ['chat', 'ai-process'].entries())
        editor.createShape({ id: `shape:skill-${type}`, type: 'node-card', x: 300 + index * 380, y: 200,
          props: { nodeType: type, title: `技能测试 ${type}` } })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      const library = []
      window.api.listSkills = async () => ({ ok: true, data: [...library] })
      window.api.installSkill = async skill => {
        const entry = { ...skill, contentHash: `sha256:${'a'.repeat(64)}` }
        library.push(entry)
        return { ok: true, data: entry }
      }
    })
    for (const type of ['chat', 'ai-process']) {
      await page.evaluate(async type => {
        const { useNodePanelStore } = await import('/src/stores/nodePanel.ts')
        useNodePanelStore.getState().open('contract', `shape:skill-${type}`, 'settings')
      }, type)
      await page.getByRole('button', { name: '上传并安装 Skill', exact: true }).waitFor()
      if (type === 'chat') {
        await page.getByLabel('上传技能文件', { exact: true }).setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown',
          buffer: Buffer.from('---\nname: 自动整理\ndescription: 按输入整理输出\nversion: v1\n---\n直接整理并检查结果。') })
      }
      const checkbox = page.getByRole('checkbox', { name: '自动整理 · v1', exact: true })
      await checkbox.check()
      const saved = await page.evaluate(async type => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        return JSON.parse(editor.getShape(`shape:skill-${type}`).props.config).agent
      }, type)
      assert.equal(saved.skills.length, 1)
      assert.equal(saved.skills[0].version, 'v1')
      assert.equal(saved.skills[0].instructions, '直接整理并检查结果。')
      assert.equal(saved.maxSteps, 6)
      await page.getByRole('spinbutton', { name: '最多执行步数' }).fill('3')
      await page.screenshot({ path: path.join(output, `${type}-settings.png`) })
      await page.evaluate(async () => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close())
      await page.evaluate(async type => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('contract', `shape:skill-${type}`, 'settings'), type)
      assert.equal(await checkbox.isChecked(), true)
      assert.equal(await page.getByRole('spinbutton', { name: '最多执行步数' }).inputValue(), '3')
      await page.getByLabel('上传技能文件', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"scripts":"shell"}') })
      await page.getByRole('alert').filter({ hasText: '技能格式无效' }).waitFor()
      assert.equal(await checkbox.isChecked(), true)
      await checkbox.uncheck()
      const remaining = await page.evaluate(async type => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        return JSON.parse(editor.getShape(`shape:skill-${type}`).props.config).agent.skills.length
      }, type)
      assert.equal(remaining, 0)
      await page.evaluate(async () => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close())
    }
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await page.getByRole('button', { name: '上传并安装 Skill', exact: true }).waitFor()
    await page.getByRole('button', { name: '对话设置', exact: true }).click()
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('未发送的草稿')
    await page.getByRole('button', { name: '对话设置', exact: true }).click()
    await page.getByRole('checkbox', { name: '自动整理 · v1', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.chat-dialog-settings .skill-agent-settings input[type="checkbox"]')?.checked)
    await page.getByRole('button', { name: '对话设置', exact: true }).click()
    assert.equal(await page.getByRole('textbox', { name: '输入消息', exact: true }).inputValue(), '未发送的草稿')
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'baseline-assets.json'), JSON.stringify({ baselineAssetErrors, scope: 'Existing demo image decode and remote tldraw translation errors; unrelated to skill controls.' }, null, 2))
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status: 'pass', checks: ['chat and processing settings', 'Markdown upload', 'binding fixed content', 'step budget', 'panel reopen', 'invalid package rejection', 'disable skill'], boundary: 'Browser UI with fixture library; production IPC/storage covered separately. No paid model.' }, null, 2))
    process.stdout.write('Skill Agent browser settings passed.\n')
  } finally { await browser.close() }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
