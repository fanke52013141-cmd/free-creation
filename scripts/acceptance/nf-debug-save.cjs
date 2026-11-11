/* eslint-disable */
// 聚焦诊断：编辑节点内添加分镜板后点「保存」，dump toast / draftGet / 形状数 / 控制台错误。
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const key = () => `${Date.now()}:${randomUUID()}`
async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input) fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }))
  return await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(root, 'out/main/local-agent.js'), ...args, '--data-dir', dir, ...(input ? ['--input-file', file] : [])], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, 40000)
    child.stdout.on('data', (c) => (out += c))
    child.once('exit', (code) => { clearTimeout(timer); try { resolve({ code, response: JSON.parse(out) }) } catch { resolve({ code, raw: out }) } })
  })
}
const ok = (r, l) => { if (r.code !== 0 || !r.response || r.response.error) throw new Error(`${l}:${JSON.stringify(r.response || r).slice(0, 400)}`); return r.response.data }
;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-nf-dbg-'))
  let app, page
  const dump = { console: [], steps: {} }
  try {
    const env = { ...process.env, CANVAS_DATA_DIR: dir, CANVAS_OWNER: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env })
    page = await app.firstWindow()
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') dump.console.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
    page.on('pageerror', (e) => dump.console.push(`[pageerror] ${String(e).slice(0, 300)}`))
    await page.waitForLoadState()
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'agent-access/connection.json')); i++) await sleep(200)
    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] nf-debug' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    await page.waitForSelector('.node-palette', { timeout: 30000 })
    // 主画布加文本节点
    await page.hover('button[aria-label="展开输入与素材节点"]')
    await page.locator('button[aria-label="添加文本节点"]').waitFor({ timeout: 5000 })
    await page.hover('.palette-node-flyout-list')
    await page.locator('button[aria-label="添加文本节点"]').click()
    await sleep(800)
    const textCard = page.locator('.node-card-wrap:has([data-node-type="text"])').first()
    await textCard.click({ button: 'right' })
    await page.waitForSelector('.node-context-menu')
    await page.click('.node-context-menu button:has-text("保存节点")')
    const dlg = page.locator('.workflow-save-dialog')
    await dlg.waitFor()
    await dlg.locator('input').first().fill('调试流')
    await dlg.locator('label:has-text("组合节点") input[type="radio"]').check()
    await dlg.locator('input[placeholder="character-design"]').fill('nf-dbg')
    await dlg.locator('button:has-text("保存并发布组合")').click()
    await dlg.waitFor({ state: 'detached', timeout: 30000 })
    // 打开编辑器
    await page.click('button[aria-label="打开节点流"]')
    await page.waitForSelector('.workflow-panel')
    const card = page.locator('.workflow-panel .asset-card', { has: page.locator('.asset-name:text-is("调试流")') })
    await card.locator('button:text-is("编辑节点")').click()
    await page.waitForSelector('.composite-canvas-overlay', { timeout: 15000 })
    await sleep(1000)
    dump.steps.innerBefore = await page.locator('.composite-canvas-stage .node-card-wrap').count()
    // 加分镜板
    await page.hover('.composite-canvas-stage button[aria-label="展开视频创作节点"]')
    const item = page.locator('.palette-node-flyout button[aria-label="添加分镜板节点"]')
    await item.waitFor({ timeout: 5000 })
    await page.hover('.composite-canvas-stage .palette-node-flyout-list')
    await item.click()
    await sleep(700)
    dump.steps.innerAfter = await page.locator('.composite-canvas-stage .node-card-wrap').count()
    // 保存按钮状态
    const saveBtn = page.locator('.nf-action-bar').getByRole('button', { name: '保存', exact: true })
    dump.steps.saveBtn = { count: await saveBtn.count(), visible: await saveBtn.isVisible().catch(() => false), disabled: await saveBtn.isDisabled().catch(() => null) }
    dump.steps.draftBefore = await page.evaluate(async () => {
      const r = await window.api.composite.draftGet('nf-dbg')
      return r.ok && r.data ? r.data.revision : null
    })
    const box = await saveBtn.boundingBox()
    dump.steps.hitTarget = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return el ? { tag: el.tagName, cls: String(el.className).slice(0, 120), text: (el.textContent || '').slice(0, 40) } : null
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    await saveBtn.click()
    await sleep(2000)
    dump.steps.toast = await page.locator('.global-toast').innerText().catch(() => '')
    dump.steps.draftAfterPlaywright = await page.evaluate(async () => {
      const r = await window.api.composite.draftGet('nf-dbg')
      return r.ok && r.data ? { revision: r.data.revision, nodes: r.data.manifest.graph.nodes.length } : null
    })
    // 若 Playwright 点击未生效，试原生 DOM click 对照
    await page.evaluate(() => {
      const bar = document.querySelector('.nf-action-bar')
      const btn = [...bar.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')
      btn?.click()
    })
    await sleep(2000)
    dump.steps.draftAfterNative = await page.evaluate(async () => {
      const r = await window.api.composite.draftGet('nf-dbg')
      return r.ok && r.data ? { revision: r.data.revision, nodes: r.data.manifest.graph.nodes.length } : null
    })
    dump.steps.toast2 = await page.locator('.global-toast').innerText().catch(() => '')
    dump.steps.draft = await page.evaluate(async () => {
      const r = await window.api.composite.draftGet('nf-dbg')
      return r.ok ? (r.data ? { revision: r.data.revision, nodes: r.data.manifest.graph.nodes.map((n) => ({ id: n.id, type: n.nodeType, title: n.title })) } : null) : { error: r.error }
    })
    dump.steps.cliDraft = (await cli(dir, ['composite', 'draft', 'get'], { capabilityId: 'nf-dbg' })).response
    dump.steps.diagnostics = await page.locator('.composite-canvas-diagnostics').innerText().catch(() => '')
    await page.screenshot({ path: path.join(root, 'qa/nf-walkthrough/debug-save.png') })
    fs.writeFileSync(path.join(root, 'qa/nf-walkthrough/debug-dump.json'), JSON.stringify(dump, null, 2))
    console.log(JSON.stringify(dump, null, 2))
  } catch (e) {
    dump.error = String(e?.stack || e)
    console.log(JSON.stringify(dump, null, 2))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()