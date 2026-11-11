/* eslint-disable */
// 节点流用户视角全流程走查（2026-11-11 新 UI）：
// 画布建节点 → 保存为节点流 1.0 → 面板卡片三按钮 → 编辑节点（加节点/保存/取消）
// → 恢复草稿 → 另存为新版本 2.0 → 历史版本弹层切换旧版本 → 编辑基础信息（保存/另存为）
// → 卡片插入实例 → 删除引用保护 → 删除无引用条目。
// 隔离数据目录 + [TEST] 窗口标题；截图留证 qa/nf-walkthrough/；退出关闭应用并清理临时目录。
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'nf-walkthrough')
const key = () => `${Date.now()}:${randomUUID()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input) fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }))
  return await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [
      path.join(root, 'out/main/local-agent.js'),
      ...args,
      '--data-dir', dir,
      ...(input ? ['--input-file', file] : [])
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, 40000)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err = (err + c).slice(-1000)))
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      try { resolve({ code, response: JSON.parse(out), err }) } catch { resolve({ code, response: null, raw: out, err }) }
    })
  })
}
function ok(res, label) {
  if (res.code !== 0 || !res.response || res.response.status === 'failed' || res.response.error) {
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 600)}`)
  }
  return res.response.data
}

;(async () => {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-nf-walk-'))
  let app, page
  const receipt = { mode: 'playwright-driven-real-electron', checks: [], observations: [], screenshots: [] }
  let shotIndex = 0
  const shot = async (name) => {
    if (!page) return
    const file = path.join(evidenceDir, `${String(++shotIndex).padStart(2, '0')}-${name}.png`)
    await page.screenshot({ path: file }).catch(() => undefined)
    receipt.screenshots.push(path.basename(file))
  }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const note = (label) => { receipt.observations.push(label); console.log(`[note] ${label}`) }
  const toastText = async () => (await page.locator('.global-toast').innerText().catch(() => '')) || ''

  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir, CANVAS_OWNER: '1' }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] 节点流用户流程走查')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    let created = null
    for (let i = 0; i < 15; i++) {
      const res = await cli(dir, ['project', 'create'], { name: '[TEST] 节点流走查' })
      if (res.code === 0 && res.response && !res.response.error) { created = res.response.data; break }
      await sleep(1000)
    }
    if (!created) throw new Error('CREATE_FAILED_AFTER_RETRIES')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    await page.waitForSelector('.node-palette', { timeout: 30000 })
    await shot('00-canvas-ready')

    const latestNodes = async () =>
      ok(await cli(dir, ['graph', 'get'], { projectId, view: 'latest', limit: 200 }), 'GRAPH').nodes
    const addNode = async (categoryLabel, nodeLabel) => {
      const before = new Set((await latestNodes()).map((n) => n.nodeId))
      for (let attempt = 0; ; attempt++) {
        try {
          await page.hover(`button[aria-label="展开${categoryLabel}节点"]`)
          const item = page.locator(`button[aria-label="添加${nodeLabel}节点"]`)
          await item.waitFor({ timeout: 5000 })
          await page.hover('.palette-node-flyout-list')
          await item.click({ timeout: 5000 })
          break
        } catch (e) { if (attempt >= 3) throw e; await sleep(600) }
      }
      let node = null
      for (let i = 0; i < 40; i++) {
        node = (await latestNodes()).find((n) => !before.has(n.nodeId))
        if (node) break
        await sleep(300)
      }
      if (!node) throw new Error(`NODE_NOT_CREATED:${nodeLabel}`)
      await sleep(400)
      return page.locator(`.node-card-wrap[data-node-id="${node.nodeId}"]`)
    }
    const typeIntoCard = async (card, text) => {
      await card.hover()
      await card.locator('button[data-original-action="text-empty-action"]').click()
      const area = card.locator('textarea.node-textarea')
      await area.waitFor({ timeout: 10000 })
      await area.fill(text)
      await card.locator('button:has-text("保存文本")').click()
      await sleep(300)
    }

    // ── 1. 画布建两个节点并连线 ──
    const text1 = await addNode('输入与素材', '文本')
    await typeIntoCard(text1, '赛博朋克侦探角色设定')
    const ai1 = await addNode('AI 与自动化', 'AI 处理')
    const outPort = text1.locator('.port-dot.out[data-port-id="out-text"]')
    const inPort = ai1.locator('.port-dot.in').first()
    const from = await outPort.boundingBox()
    const to = await inPort.boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 18 })
    await page.mouse.up()
    await sleep(600)
    await shot('01-two-nodes-connected')
    check('画布添加文本+AI处理并拖线连接')

    // ── 2. 多选 → 右键保存节点 → 组合节点 → 发布 1.0 ──
    await text1.click()
    await ai1.click({ modifiers: ['Shift'] })
    await ai1.click({ button: 'right' })
    await page.waitForSelector('.node-context-menu', { timeout: 10000 })
    await page.click('.node-context-menu button:has-text("保存节点")')
    const saveDialog = page.locator('.workflow-save-dialog')
    await saveDialog.waitFor({ timeout: 10000 })
    await saveDialog.locator('input').first().fill('角色到分镜')
    await saveDialog.locator('label:has-text("组合节点") input[type="radio"]').check()
    await saveDialog.locator('input[placeholder="character-design"]').fill('nf-walk')
    await sleep(400)
    // 边界自动推导：创建弹窗不再提供手动类型挑选。
    if ((await saveDialog.locator('select').count()) > 0) throw new Error('CREATE_DIALOG_HAS_BOUNDARY_SELECT')
    if (!(await saveDialog.locator('.workflow-save-boundary-hint').isVisible()))
      throw new Error('CREATE_DIALOG_BOUNDARY_HINT_MISSING')
    await shot('02-create-dialog')
    await saveDialog.locator('button:has-text("保存并发布组合")').click()
    await saveDialog.waitFor({ state: 'detached', timeout: 30000 })
    const v1 = ok(await cli(dir, ['composite', 'get'], { capabilityId: 'nf-walk', version: '1.0' }), 'GET_10')
    check('多选保存为节点流「角色到分镜」1.0（创建弹窗）')

    // ── 3. 节点流面板：卡片三按钮 ──
    await page.click('button[aria-label="打开节点流"]')
    await page.waitForSelector('.workflow-panel', { timeout: 10000 })
    const libCard = (name) => page.locator('.workflow-panel .asset-card', { has: page.locator(`.asset-name:text-is("${name}")`) })
    const cardAction = async (name, label) => {
      const c = libCard(name)
      const btn = c.locator('button:text-is("' + label + '")')
      // 悬浮才显示动作（pointer-events:none 默认）。真实悬浮 reveal 已由
      // nf-debug-hover.cjs 验证（hover 后 opacity=1 且命中按钮）；走查用原生
      // click 推进业务流程，避免自动化可命中检查与悬浮层竞态。
      await btn.evaluate((el) => el.click())
    }
    const card = libCard('角色到分镜')
    await card.waitFor({ timeout: 10000 })
    const btnNames = await card.locator('.composite-card-actions button').allInnerTexts()
    if (JSON.stringify(btnNames.map((s) => s.trim())) !== JSON.stringify(['删除', '编辑节点', '编辑']))
      throw new Error(`CARD_BUTTONS_WRONG:${JSON.stringify(btnNames)}`)
    // 卡片只显示名称：无版本/节点流字样；动作悬浮才可见。
    const cardText = await card.innerText()
    if (cardText.includes('v1.0') || cardText.includes('节点流')) throw new Error(`CARD_META_PRESENT:${cardText}`)
    const actionsOpacity = await card.locator('.composite-card-actions').evaluate((el) => getComputedStyle(el).opacity)
    if (actionsOpacity !== '0') throw new Error(`CARD_ACTIONS_NOT_HOVER_ONLY:${actionsOpacity}`)
    await shot('03-library-card')
    check('卡片动作 = 编辑 / 编辑节点 / 删除（无归档）')

    // ── 4. 编辑节点：全屏画布复刻检查 + 加分镜板 + 保存 + 取消 ──
    await cardAction('角色到分镜', '编辑节点')
    await page.waitForSelector('.composite-canvas-overlay', { timeout: 15000 })
    await sleep(900)
    for (const sel of ['.composite-canvas-stage .node-palette', '.composite-canvas-stage .canvas-dock', '.nf-action-bar']) {
      if (!(await page.locator(sel).isVisible())) throw new Error(`EDITOR_CHROME_MISSING:${sel}`)
    }
    const topText = await page.locator('.composite-canvas-topbar').innerText()
    if (topText.includes('未保存') || topText.includes('当前 v') || topText.trim() !== '角色到分镜')
      throw new Error(`TOPBAR_NOT_NAME_ONLY:${topText}`)
    await shot('04-editor-chrome')
    check('全屏编辑器：左侧面板+底部缩放坞+右下动作簇；顶栏仅名称')
    const innerCount = async () => page.locator('.composite-canvas-stage .node-card-wrap').count()
    const before = await innerCount()
    for (let attempt = 0; ; attempt++) {
      try {
        await page.hover('.composite-canvas-stage button[aria-label="展开视频创作节点"]')
        const item = page.locator('.palette-node-flyout button[aria-label="添加分镜板节点"]')
        await item.waitFor({ timeout: 5000 })
        await page.hover('.composite-canvas-stage .palette-node-flyout-list')
        await item.click({ timeout: 5000 })
        break
      } catch (e) { if (attempt >= 3) throw e; await sleep(600) }
    }
    await sleep(500)
    if ((await innerCount()) !== before + 1) throw new Error('EDITOR_ADD_NODE_FAILED')
    await shot('05-editor-added-storyboard')
    check('编辑节点内用左侧面板添加分镜板（与主画布同规格）')
    await page.locator('.nf-action-bar').getByRole('button', { name: '保存', exact: true }).click()
    await sleep(900)
    const draft1 = ok(await cli(dir, ['composite', 'draft', 'get'], { capabilityId: 'nf-walk' }), 'DRAFT_1')
    if (!draft1 || draft1.manifest.graph.nodes.length !== before + 1) throw new Error('DRAFT_SAVE_MISSING_NODE')
    note(`保存 toast：${await toastText()}`)
    await shot('06-editor-saved')
    await page.locator('.nf-action-bar').getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForSelector('.composite-canvas-overlay', { state: 'detached', timeout: 10000 })
    check('保存=草稿（CLI 复核含新节点）；取消直接退出（无未保存修改）')

    // ── 5. 重新编辑节点：草稿恢复 → 改正文 → 另存为新版本 2.0 ──
    await cardAction('角色到分镜', '编辑节点')
    await page.waitForSelector('.composite-canvas-overlay', { timeout: 15000 })
    await sleep(900)
    if ((await innerCount()) !== before + 1) throw new Error('DRAFT_NOT_RESTORED_IN_EDITOR')
    const innerText = page.locator('.composite-canvas-stage .node-card-wrap:has([data-node-type="text"])').first()
    await typeIntoCard(innerText, '赛博朋克侦探角色设定（第二版修改）')
    await shot('07-editor-draft-restored-modified')
    await page.locator('.nf-action-bar').getByRole('button', { name: '另存为新版本', exact: true }).click()
    const preview = page.locator('.composite-publish-preview')
    await preview.waitFor({ timeout: 20000 })
    await shot('08-publish-preview')
    await preview.locator('button:has-text("确认发布")').click()
    await page.waitForSelector('.composite-canvas-overlay', { state: 'detached', timeout: 30000 })
    const v2 = ok(await cli(dir, ['composite', 'get'], { capabilityId: 'nf-walk', version: '2.0' }), 'GET_20')
    if (!JSON.stringify(v2.manifest).includes('第二版修改')) throw new Error('PUBLISH_20_CONTENT_MISSING')
    // 公开边界按节点规范自动推导：文本开头 → 文本输入；每个汇节点暴露其主输出，
    // 输出类型必须与源节点端口规范一致（不允许手动挑选类型）。
    if (v2.manifest.inputs[0]?.type !== 'text') throw new Error(`BOUNDARY_INPUT_WRONG:${JSON.stringify(v2.manifest.inputs)}`)
    const nodeById = new Map(v2.manifest.graph.nodes.map((n) => [n.id, n]))
    for (const out of v2.manifest.outputs) {
      const src = nodeById.get(out.source.nodeId)
      const port = src?.ports?.find((p) => p.id === out.source.portId)
      if (!port || port.type !== out.type) throw new Error(`BOUNDARY_OUTPUT_TYPE_MISMATCH:${JSON.stringify(out)}`)
    }
    if (v2.manifest.outputs.length < 1) throw new Error('BOUNDARY_OUTPUT_EMPTY')
    check('草稿自动恢复；另存为新版本 2.0（预览→确认，CLI 复核内容）')
    check('公开边界自动推导：文本输入 + 汇节点单个主输出，无手动挑选')

    // ── 6. 历史版本底部弹层：查看列表 → 切换为 1.0 ──
    await cardAction('角色到分镜', '编辑节点')
    await page.waitForSelector('.composite-canvas-overlay', { timeout: 15000 })
    await sleep(700)
    await page.locator('.nf-action-bar').getByRole('button', { name: '历史版本', exact: true }).click()
    const sheet = page.locator('.nf-sheet')
    await sheet.waitFor({ timeout: 10000 })
    await sheet.locator('.nf-version-row').first().waitFor({ timeout: 10000 })
    const rows = await sheet.locator('.nf-version-row').allInnerTexts()
    if (rows.length !== 2) throw new Error(`VERSION_ROWS_WRONG:${JSON.stringify(rows)}`)
    await shot('09-version-sheet')
    check('历史版本底部弹层：v2.0 当前 + v1.0 可切换')
    const oldRow = sheet.locator('.nf-version-row', { hasText: 'v1.0' })
    await oldRow.locator('button:has-text("切换为此版本")').click()
    const confirm = page.locator('.confirm-overlay')
    await confirm.waitFor({ timeout: 10000 })
    await shot('10-switch-confirm')
    await confirm.locator('button:has-text("切换")').click()
    await page.waitForSelector('.composite-canvas-overlay', { state: 'detached', timeout: 30000 })
    const v3 = ok(await cli(dir, ['composite', 'get'], { capabilityId: 'nf-walk', version: '3.0' }), 'GET_30')
    if (JSON.stringify(v3.manifest).includes('第二版修改')) throw new Error('SWITCH_DID_NOT_USE_OLD_CONTENT')
    check('切换为 1.0 → 以旧内容发布 3.0（历史保留，CLI 复核）')

    // ── 6b. 取消即退出：有未保存修改也不弹二次确认 ──
    await cardAction('角色到分镜', '编辑节点')
    await page.waitForSelector('.composite-canvas-overlay', { timeout: 15000 })
    await sleep(700)
    await typeIntoCard(
      page.locator('.composite-canvas-stage .node-card-wrap:has([data-node-type="text"])').first(),
      '临时修改（应被取消丢弃）'
    )
    await page.locator('.nf-action-bar').getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForSelector('.composite-canvas-overlay', { state: 'detached', timeout: 5000 })
    if (await page.locator('.confirm-overlay').isVisible().catch(() => false))
      throw new Error('CANCEL_SHOWED_CONFIRM')
    check('取消立即退出，无二次确认')

    // ── 7. 编辑基础信息：创建同款弹窗，仅 取消/保存；改名不产生新版本 ──
    await cardAction('角色到分镜', '编辑')
    const info = page.locator('.workflow-save-dialog[aria-label="编辑节点流"]')
    await info.waitFor({ timeout: 10000 })
    await info.locator('input').first().waitFor({ timeout: 10000 })
    const infoButtons = await info.locator('.library-form-footer button').allInnerTexts()
    if (JSON.stringify(infoButtons.map((s) => s.trim())) !== JSON.stringify(['取消', '保存']))
      throw new Error(`INFO_FOOTER_WRONG:${JSON.stringify(infoButtons)}`)
    await shot('11-info-dialog')
    await info.locator('input').first().fill('角色到分镜·改')
    await info.locator('input').nth(1).fill('用户走查：基础信息编辑')
    await info.locator('.library-form-footer').getByRole('button', { name: '保存', exact: true }).click()
    await info.waitFor({ state: 'detached', timeout: 15000 })
    await libCard('角色到分镜·改').waitFor({ timeout: 10000 })
    const versionsAfterRename = ok(await cli(dir, ['composite', 'version', 'list'], { capabilityId: 'nf-walk' }), 'VERSIONS_AFTER_RENAME')
    if (versionsAfterRename.length !== 3) throw new Error(`RENAME_CREATED_VERSION:${versionsAfterRename.length}`)
    await shot('12-info-saved')
    check('编辑基础信息仅取消/保存；改名即时生效且不产生新版本')

    // ── 8. 卡片点击插入实例（固定最新版本 3.0）──
    await libCard('角色到分镜·改').locator('.asset-name').click()
    await sleep(1200)
    let graphNow = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH_AFTER_INSERT')
    let inst = graphNow.nodes.find((n) => n.type === 'composite' && n.title === '角色到分镜·改')
    if (!inst) {
      note(`插入未生效 toast=${await toastText()} composites=${JSON.stringify(graphNow.nodes.filter((n) => n.type === 'composite').map((n) => n.title))}`)
      await libCard('角色到分镜·改').click()
      await sleep(1200)
      graphNow = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH_AFTER_INSERT2')
      inst = graphNow.nodes.find((n) => n.type === 'composite' && n.title === '角色到分镜·改')
    }
    if (!inst) throw new Error('INSTANCE_NOT_INSERTED')
    const instDetail = ok(await cli(dir, ['node', 'get'], { projectId, nodeId: inst.nodeId }), 'NODE_GET')
    if (instDetail.node.config?.version !== '3.0') throw new Error(`INSTANCE_VERSION_WRONG:${JSON.stringify(instDetail.node.config)}`)
    await shot('13-instance-inserted')
    check('卡片点击插入实例，固定 v3.0')

    // ── 9. 删除引用保护：有实例 → 阻断 ──
    await cardAction('角色到分镜·改', '删除')
    await sleep(900)
    const blockedToast = await toastText()
    if (!blockedToast.includes('无法删除')) throw new Error(`DELETE_NOT_BLOCKED:${blockedToast}`)
    if (!(await libCard('角色到分镜·改').isVisible())) throw new Error('BLOCKED_DELETE_REMOVED_CARD')
    await shot('14-delete-blocked')
    check('删除被引用节点流 → 引用检查阻断并提示')

    // ── 10. 无引用条目：二次确认后删除 ──
    const text2 = await addNode('输入与素材', '文本')
    await text2.click({ button: 'right' })
    await page.waitForSelector('.node-context-menu', { timeout: 10000 })
    await page.click('.node-context-menu button:has-text("保存节点")')
    await saveDialog.waitFor({ timeout: 10000 })
    await saveDialog.locator('input').first().fill('临时待删')
    await saveDialog.locator('label:has-text("组合节点") input[type="radio"]').check()
    await saveDialog.locator('input[placeholder="character-design"]').fill('nf-delete-me')
    await saveDialog.locator('button:has-text("保存并发布组合")').click()
    await saveDialog.waitFor({ state: 'detached', timeout: 30000 })
    await cardAction('临时待删', '删除')
    await confirm.waitFor({ timeout: 10000 })
    await shot('15-delete-confirm')
    await confirm.locator('button:has-text("删除")').click()
    await sleep(900)
    if (await libCard('临时待删').isVisible().catch(() => false)) throw new Error('DELETE_NOT_APPLIED')
    check('无引用节点流：二次确认后删除成功')

    console.log(JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: true, ...receipt }, null, 2))
  } catch (error) {
    await shot('failure')
    const dump = { ok: false, error: String(error?.stack || error), ...receipt }
    console.log(JSON.stringify(dump, null, 2))
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify(dump, null, 2))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()