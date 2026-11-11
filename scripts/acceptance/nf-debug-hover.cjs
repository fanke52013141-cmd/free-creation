/* eslint-disable */
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
    child.stdout.on('data', (d) => (out += d))
    child.once('exit', (code) => { clearTimeout(timer); try { resolve({ code, response: JSON.parse(out) }) } catch { resolve({ code, raw: out }) } })
  })
}
const ok = (r, l) => { if (r.code !== 0 || !r.response || r.response.error) throw new Error(`${l}:${JSON.stringify(r.response || r).slice(0, 300)}`); return r.response.data }
;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nf-hover-dbg-'))
  let app, page
  const dump = {}
  try {
    const env = { ...process.env, CANVAS_DATA_DIR: dir, CANVAS_OWNER: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env })
    page = await app.firstWindow()
    await page.waitForLoadState()
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'agent-access/connection.json')); i++) await sleep(200)
    let created = null
    for (let i = 0; i < 15 && !created; i++) {
      const r = await cli(dir, ['project', 'create'], { name: '[TEST] hover' })
      if (r.code === 0 && r.response && !r.response.error) created = r.response.data
      else await sleep(1000)
    }
    ok(await cli(dir, ['project', 'open'], { projectId: created.meta.id }), 'OPEN')
    await page.waitForSelector('.node-palette', { timeout: 30000 })
    // 建文本节点并保存为节点流
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
    await dlg.locator('input').first().fill('悬浮调试')
    await dlg.locator('label:has-text("组合节点") input[type="radio"]').check()
    await dlg.locator('input[placeholder="character-design"]').fill('nf-hover')
    await dlg.locator('button:has-text("保存并发布组合")').click()
    await dlg.waitFor({ state: 'detached', timeout: 30000 })
    await page.click('button[aria-label="打开节点流"]')
    await page.waitForSelector('.workflow-panel')
    const card = page.locator('.workflow-panel .asset-card', { has: page.locator('.asset-name:text-is("悬浮调试")') })
    await card.waitFor({ timeout: 10000 })
    dump.before = await card.locator('.composite-card-actions').evaluate((el) => {
      const cs = getComputedStyle(el)
      return { opacity: cs.opacity, pointerEvents: cs.pointerEvents, position: cs.position, rect: el.getBoundingClientRect() }
    })
    dump.cardPosition = await card.evaluate((el) => getComputedStyle(el).position)
    await card.hover()
    await sleep(400)
    dump.hoverState = await card.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      const chain = []
      let n = at
      while (n && chain.length < 6) {
        chain.push(`${n.tagName}.${String(n.className).slice(0, 40)}`)
        n = n.parentElement
      }
      return {
        cardIsHover: el.matches(':hover'),
        centerHit: chain,
        cardPointerEvents: getComputedStyle(el).pointerEvents,
        cardRect: r
      }
    })
    dump.afterHover = await card.locator('.composite-card-actions').evaluate((el) => {
      const cs = getComputedStyle(el)
      return { opacity: cs.opacity, pointerEvents: cs.pointerEvents, rect: el.getBoundingClientRect() }
    })
    const btn = card.locator('button:text-is("编辑节点")')
    const box = await btn.boundingBox()
    dump.btnBox = box
    dump.hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return el ? { tag: el.tagName, cls: String(el.className).slice(0, 100), text: (el.textContent || '').slice(0, 30) } : null
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    await page.screenshot({ path: path.join(root, 'qa/nf-walkthrough/debug-hover.png') })
    fs.writeFileSync(path.join(root, 'qa/nf-walkthrough/debug-hover.json'), JSON.stringify(dump, null, 2))
    console.log(JSON.stringify(dump, null, 2))
  } catch (e) {
    dump.error = String(e?.stack || e)
    fs.writeFileSync(path.join(root, 'qa/nf-walkthrough/debug-hover.json'), JSON.stringify(dump, null, 2))
    console.log(JSON.stringify(dump, null, 2))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()