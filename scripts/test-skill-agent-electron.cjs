/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { _electron } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { qaOutputPath } = require('./qa-output.cjs')
async function clean(directory) {
  const absolute = path.resolve(directory)
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('canvas-skill-agent-')) throw new Error('SKILL_QA_CLEANUP_REJECTED')
  await fs.rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
;(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-agent-'))
  const output = qaOutputPath(process.env.CANVAS_SKILL_AGENT_INSTALL_ROOT ? 'qa/skill-agent/packaged' : 'qa/skill-agent/electron')
  await fs.mkdir(output, { recursive: true })
  const env = { ...process.env, CANVAS_DATA_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const packageRoot = process.env.CANVAS_SKILL_AGENT_INSTALL_ROOT
  const launch = () => _electron.launch({
    ...(packageRoot ? { executablePath: path.join(packageRoot, 'canvas-studio.exe'), args: [] } : { args: [path.resolve('.')] }), env,
    timeout: 60000
  })
  let app
  const open = async () => {
    app = await launch()
    const page = await app.firstWindow()
    await page.waitForFunction(() => typeof window.api?.listSkills === 'function')
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) { window.setTitle('[TEST] Skill Agent'); window.hide() }
    })
    return page
  }
  try {
    let page = await open()
    const name = 'Skill Agent isolated acceptance'
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await page.locator('input[placeholder="给这个项目起个名字"]').fill(name)
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.node-palette').waitFor()
    const projectId = await page.evaluate(async name => (await window.api.listProjects()).data.find(item => item.name === name).id, name)
    await page.getByRole('button', { name: '展开AI 与自动化节点', exact: true }).click()
    await page.getByRole('button', { name: /添加.*AI 对话.*节点/ }).click()
    await page.getByRole('button', { name: '展开AI 与自动化节点', exact: true }).click()
    await page.getByRole('button', { name: /添加.*AI 处理.*节点/ }).click()
    for (const type of ['chat', 'ai-process']) {
      const card = page.locator(`[data-node-type="${type}"]`).first()
      await card.locator('..').getByTitle('查看输入输出说明', { exact: true }).click()
      await page.getByRole('tab', { name: '设置', exact: true }).click()
      if (type === 'chat') {
        await page.getByLabel('上传技能文件', { exact: true }).setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown',
          buffer: Buffer.from('---\nname: 验收整理\nversion: v1\n---\nprivate-skill-body fake-secret-value') })
      }
      await page.getByRole('checkbox', { name: '验收整理 · v1', exact: true }).check()
      await page.waitForFunction(async ({ projectId, type }) => {
        const reply = await window.api.openProject(projectId)
        if (!reply.ok || !reply.data) return false
        return Object.values(reply.data.tldrawSnapshot?.store || {}).some(shape => {
          if (shape.props?.nodeType !== type) return false
          try { return JSON.parse(shape.props.config).agent.skills[0]?.version === 'v1' } catch { return false }
        })
      }, { projectId, type })
      await page.screenshot({ path: path.join(output, `${type}.png`) })
      await page.keyboard.press('Escape')
    }
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await page.getByRole('checkbox', { name: '验收整理 · v1', exact: true }).waitFor()
    assert.equal(await page.getByRole('checkbox', { name: '验收整理 · v1', exact: true }).isChecked(), true)
    await page.keyboard.press('Escape')
    await app.close(); app = null
    page = await open()
    const readback = await page.evaluate(async projectId => {
      const library = await window.api.listSkills()
      const file = await window.api.openProject(projectId)
      return { library, file }
    }, projectId)
    assert.equal(readback.library.ok, true)
    assert.equal(readback.file.ok, true)
    assert.ok(readback.library.data.some(item => item.name === '验收整理' && item.version === 'v1'))
    const shapes = Object.values(readback.file.data.tldrawSnapshot.store)
    for (const type of ['chat', 'ai-process']) {
      const config = JSON.parse(shapes.find(shape => shape.props?.nodeType === type).props.config)
      assert.equal(config.agent.skills[0].instructions, 'private-skill-body fake-secret-value')
    }
    await app.close(); app = null
    const events = []
    async function scan(root) {
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const target = path.join(root, entry.name)
        if (entry.isDirectory()) await scan(target)
        else if (entry.name.endsWith('.jsonl')) {
          const body = await fs.readFile(target, 'utf8')
          assert.ok(!/private-skill-body|fake-secret-value|验收整理/.test(body))
          for (const line of body.split('\n').filter(Boolean)) events.push(JSON.parse(line))
        }
      }
    }
    await scan(path.join(directory, 'diagnostics'))
    const starts = events.filter(event => event.event === 'skill.library.started')
    assert.ok(starts.length > 0)
    for (const start of starts)
      assert.equal(events.filter(event => event.traceId === start.traceId && ['skill.library.completed', 'skill.library.failed'].includes(event.event)).length, 1)
    await fs.cp(path.join(directory, 'diagnostics'), path.join(output, 'diagnostics'), { recursive: true })
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'pass', mode: packageRoot ? 'packaged' : 'source-build', checks: ['production preload and IPC install', 'both settings without model configuration', 'public autosave', 'new Electron process reopens fixed skills and node config', 'real diagnostic lifecycle and redaction'], skillOperations: starts.length, paidCalls: 0 }, null, 2))
    process.stdout.write('Skill Agent production Electron install/save/reopen and diagnostics passed.\n')
  } catch (error) {
    if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    if (app) await app.close()
    await clean(directory)
  }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
