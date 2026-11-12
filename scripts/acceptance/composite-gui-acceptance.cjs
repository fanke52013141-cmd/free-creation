/* eslint-disable */
// W2-A 真实桌面 GUI 验收（自动化驱动，非人工点击）：
// 隔离数据目录 + [TEST] 窗口标题，Playwright 驱动真实 Electron 渲染层完成
// 封装 → 草稿 → 另存为新版本 2.0 → 旧实例固定 1.0 → 外层嵌套 → 不兼容升级预检阻断 → 实例升级。
// 适配第三轮 UI 裁决：节点流面板（图标动作）、编辑器「保存/另存为新版本/取消」（取消即退出，无二次确认）、
// 版本号自动递增（无手动输入）、保存反馈为 toast（以 CLI 草稿落盘复核）。
// 截图留证 qa/w2-gui-acceptance/，退出后关闭应用并删除临时目录。
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'w2-gui-acceptance')
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-w2-gui-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { mode: 'playwright-driven-real-electron (NOT human clicks)', checks: [], outputs: {}, screenshots: [] }
  let shotIndex = 0
  let page
  const shot = async (name) => {
    if (!page) return
    const file = path.join(evidenceDir, `${String(++shotIndex).padStart(2, '0')}-${name}.png`)
    await page.screenshot({ path: file }).catch(() => undefined)
    receipt.screenshots.push(path.basename(file))
  }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }

  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [root, '--local-agent-access'],
      env: launchEnv
    })
    page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] W2 节点流 GUI 验收')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] W2 GUI 验收' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    await page.waitForSelector('.node-palette', { timeout: 30000 })
    await shot('canvas-ready')
    check('GUI 画布就绪（CLI 创建并打开 [TEST] 项目）')

    // ── 1. 添加文本节点并输入正文 ──
    const latestNodes = async () =>
      ok(await cli(dir, ['graph', 'get'], { projectId, view: 'latest', limit: 200 }), 'GRAPH_LATEST').nodes
    const nodePosition = async (nodeId) => {
      const node = (await latestNodes()).find((n) => n.nodeId === nodeId)
      return node ? { x: node.x, y: node.y } : null
    }
    const addTextNode = async () => {
      const before = new Set((await latestNodes()).map((n) => n.nodeId))
      // 浮层在指针离开时自动收起：先悬停分类，再进入浮层列表保持展开，失败重试。
      for (let attempt = 0; ; attempt++) {
        try {
          await page.hover('button[aria-label="展开输入与素材节点"]')
          const item = page.locator('button[aria-label="添加文本节点"]')
          await item.waitFor({ timeout: 5000 })
          await page.hover('.palette-node-flyout-list')
          await item.click({ timeout: 5000 })
          break
        } catch (error) {
          if (attempt >= 3) throw error
          await sleep(600)
        }
      }
      let newNode = null
      for (let i = 0; i < 40; i++) {
        newNode = (await latestNodes()).find((n) => n.type === 'text' && !before.has(n.nodeId))
        if (newNode) break
        await sleep(300)
      }
      if (!newNode) throw new Error('TEXT_NODE_NOT_CREATED')
      const card = page.locator(`.node-card-wrap[data-node-id="${newNode.nodeId}"]`)
      await card.click()
      await sleep(200)
      return card
    }
    const moveCard = async (card, dx, dy) => {
      const nodeId = await card.getAttribute('data-node-id')
      const before = await nodePosition(nodeId)
      const box = await card.boundingBox()
      // 从卡片左侧实体区域起拖：标题行/按钮会拦截指针，端口在卡片外侧。
      const startX = box.x + 12
      const startY = box.y + box.height / 2
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      await page.mouse.move(startX + dx, startY + dy, { steps: 16 })
      await page.mouse.up()
      await sleep(500)
      const after = await nodePosition(nodeId)
      if (!before || !after || Math.abs(after.x - before.x) < Math.abs(dx) / 2) {
        throw new Error(`MOVE_FAILED:${nodeId}:${JSON.stringify({ before, after, dx, dy })}`)
      }
    }
    const textCards = () => page.locator('.node-card-wrap:has([data-node-type="text"])')
    const compositeCards = () => page.locator('.node-card-wrap:has([data-node-type="composite"])')
    const innerInstance = () => page.locator('.node-card-wrap:has([data-node-type="composite"])', { hasText: '文案整理' }).first()
    const typeIntoCard = async (card, text) => {
      // 用「编辑文本/输入文本」按钮进入编辑（不触发选中→设置面板抢焦点），
      // 用「保存文本」按钮提交（Escape 语义是放弃修改，不能用）。
      await card.hover()
      await card.locator('button[data-original-action="text-empty-action"]').click()
      const area = card.locator('textarea.node-textarea')
      await area.waitFor({ timeout: 10000 })
      await area.fill(text)
      await card.locator('button:has-text("保存文本")').click()
      await sleep(300)
    }
    const readCardText = async (card) => {
      await card.hover()
      await card.locator('button[data-original-action="text-empty-action"]').click()
      const area = card.locator('textarea.node-textarea')
      await area.waitFor({ timeout: 10000 })
      const value = await area.inputValue()
      await card.locator('button:has-text("保存文本")').click()
      await sleep(200)
      return value
    }
    const text1 = await addTextNode()
    if ((await textCards().count()) < 1) throw new Error('TEXT_NODE_NOT_CREATED')
    await typeIntoCard(text1, '内部说明')
    await moveCard(text1, -420, 0)
    await page.keyboard.press('Escape')
    await shot('text-node-typed')
    check('GUI  palette 添加文本节点并双击输入正文')

    // ── 2. 右键「保存节点」→ 组合节点 → 保存并发布 1.0 ──
    const saveSelectionAsComposite = async (name, capabilityId, anchorCard) => {
      await anchorCard.click({ button: 'right' })
      await page.waitForSelector('.node-context-menu', { timeout: 10000 })
      await page.click('.node-context-menu button:has-text("保存节点")')
      const dialog = page.locator('.workflow-save-dialog')
      await dialog.waitFor({ timeout: 10000 })
      await dialog.locator('input').first().fill(name)
      await dialog.locator('label:has-text("组合节点") input[type="radio"]').check()
      await dialog.locator('input[placeholder="character-design"]').fill(capabilityId)
      await sleep(400)
      await shot(`save-dialog-${capabilityId}`)
      await dialog.locator('button:has-text("保存并发布组合")').click()
      await dialog.waitFor({ state: 'detached', timeout: 30000 })
    }
    await saveSelectionAsComposite('文案整理', 'gui-copy-polish', text1)
    await page.waitForSelector('.workflow-panel', { timeout: 10000 })
    await shot('published-1.0-library')
    const inner10 = ok(await cli(dir, ['composite', 'get'], { capabilityId: 'gui-copy-polish', version: '1.0' }), 'GET_10')
    if (inner10.manifest.runtimeVersion !== 2) throw new Error('RUNTIME_VERSION_NOT_2')
    check('GUI 右键保存节点→组合节点→发布「文案整理」1.0（runtimeVersion=2）')

    // ── 3. GUI 运行 1.0 实例 ──
    const runCard = async (card) => {
      await card.hover()
      await card.locator('.node-run-btn').click({ timeout: 10000 })
    }
    const waitForRun = async (capabilityId, version, minCount, timeoutMs = 60000) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const runs = ok(await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 50 }), 'RUN_LIST')
        const matched = runs.filter((r) => r.capabilityId === capabilityId && r.capabilityVersion === version)
        const terminal = matched.filter((r) => r.status === 'completed' || r.status === 'failed')
        if (terminal.length >= minCount) return terminal
        await sleep(700)
      }
      throw new Error(`RUN_TIMEOUT:${capabilityId}@${version}`)
    }
    // 运行终态含 failed：失败时带运行台账详情抛出，避免后续 output 读取掩盖真实失败。
    const assertRunsCompleted = async (runs, label) => {
      const failed = runs.filter((r) => r.status === 'failed')
      if (failed.length === 0) return
      const detail = ok(await cli(dir, ['composite', 'run', 'get'], { runId: failed[0].id }), `${label}_RUN_GET`)
      throw new Error(`${label}_RUN_FAILED:${JSON.stringify({ run: failed[0], steps: detail?.steps }).slice(0, 1200)}`)
    }
    const readOutputText = async (nodeId, manifest) => {
      const start = Date.now()
      let lastRaw = null
      while (Date.now() - start < 30000) {
        await page.keyboard.press('Control+s')
        await sleep(800)
        const res = await cli(dir, ['output', 'get'], { projectId, nodeId })
        lastRaw = res.response
        const outputs = res.response?.data?.outputs
        if (Array.isArray(outputs)) {
          for (const out of manifest.outputs) {
            const hit = outputs.find((o) => o.portId === `out-${out.id}`)
            if (hit && typeof hit.text === 'string') return hit.text
          }
        }
        await sleep(700)
      }
      throw new Error(`OUTPUT_TIMEOUT:${nodeId}:${JSON.stringify(lastRaw).slice(0, 800)}`)
    }
    const instance10 = innerInstance()
    await runCard(instance10)
    await assertRunsCompleted(await waitForRun('gui-copy-polish', '1.0', 1), 'INNER10')
    await shot('run-1.0-instance')
    check('GUI 点击运行 1.0 实例（composite.run.list 记录 completed）')

    // ── 4. 节点流「编辑节点」→ 改正文 → 保存草稿 → 关闭 ──
    const libraryCard = (name) => page.locator('.workflow-panel .asset-card', { has: page.locator(`.asset-name:text-is("${name}")`) })
    const editButton = async (name) => {
      await page.click('button[aria-label="打开节点流"]')
      await sleep(500)
      const card = libraryCard(name)
      await card.waitFor({ timeout: 10000 })
      await card.hover()
      await card.locator(`button[aria-label="编辑节点 ${name}"]`).click()
      await page.waitForSelector('.composite-canvas-overlay', { timeout: 15000 })
      await sleep(800)
    }
    await editButton('文案整理')
    const innerCard = () => page.locator('.composite-canvas-stage .node-card-wrap:has([data-node-type="text"])').first()
    await typeIntoCard(innerCard(), '内部说明（草稿修改）')
    await page.click('.nf-action-bar button[title^="暂存当前内容"]')
    await shot('draft-saved')
    // 保存反馈为 toast（无状态元素）：以 CLI 草稿落盘为准轮询复核。
    let draftAfterSave = null
    for (let i = 0; i < 20; i++) {
      draftAfterSave = ok(await cli(dir, ['composite', 'draft', 'get'], { capabilityId: 'gui-copy-polish' }), 'DRAFT_GET')
      if (JSON.stringify(draftAfterSave.manifest).includes('草稿修改')) break
      await sleep(400)
    }
    if (!JSON.stringify(draftAfterSave.manifest).includes('草稿修改')) throw new Error('DRAFT_CONTENT_MISSING')
    await page.click('.nf-action-bar button[title="退出编辑，返回画布"]')
    await page.waitForSelector('.composite-canvas-overlay', { state: 'detached', timeout: 10000 })
    check('GUI 编辑→修改正文→保存草稿→取消关闭（CLI 复核草稿内容）')

    // ── 5. 重新「编辑节点」→ 恢复草稿 → 另存为新版本（自动 2.0）→ 发布预览 → 确认 ──
    await editButton('文案整理')
    const restoredText = await readCardText(innerCard())
    if (!restoredText.includes('草稿修改')) throw new Error(`DRAFT_TEXT_NOT_RESTORED:${restoredText}`)
    const draftRestored = ok(await cli(dir, ['composite', 'draft', 'get'], { capabilityId: 'gui-copy-polish' }), 'DRAFT_RESTORED')
    if (!(draftRestored.revision >= 1)) throw new Error(`DRAFT_REVISION_NOT_RESTORED:${draftRestored.revision}`)
    await shot('draft-restored')
    check('GUI 重新编辑自动恢复草稿（正文与修订号 CLI 复核）')
    // 另存为新版本：版本号自动递增（无手动输入），发布预览后确认。
    await page.click('.nf-action-bar button[title^="以当前内容发布"]')
    const previewDialog = page.locator('.composite-publish-preview')
    await previewDialog.waitFor({ timeout: 20000 })
    const previewText = await previewDialog.innerText()
    if (!previewText.includes('基准 v1.0') || !previewText.includes('目标 v2.0'))
      throw new Error(`PREVIEW_VERSIONS_MISSING:${previewText.slice(0, 200)}`)
    if (!previewText.includes('接口差异') || !previewText.includes('引用版本'))
      throw new Error(`PREVIEW_SECTIONS_MISSING:${previewText.slice(0, 200)}`)
    await shot('publish-preview-2.0')
    await previewDialog.locator('button:has-text("确认发布")').click()
    await page.waitForSelector('.composite-canvas-overlay', { state: 'detached', timeout: 30000 })
    const inner20 = ok(await cli(dir, ['composite', 'get'], { capabilityId: 'gui-copy-polish', version: '2.0' }), 'GET_20')
    if (!JSON.stringify(inner20.manifest).includes('草稿修改')) throw new Error('PUBLISHED_20_CONTENT_MISSING')
    await shot('published-2.0')
    check('GUI 发布预览（基准/目标版本+接口差异+引用版本）→ 确认发布 2.0')

    // ── 6. 旧实例仍固定 1.0：再运行，输出不含草稿修改 ──
    const graphNow = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH_GET')
    const instanceNode = graphNow.nodes.find((n) => n.type === 'composite' && n.title === '文案整理')
    if (!instanceNode) throw new Error('INSTANCE_NOT_FOUND')
    receipt.outputs.instanceNodeId = instanceNode.nodeId
    const instanceDetail = ok(await cli(dir, ['node', 'get'], { projectId, nodeId: instanceNode.nodeId }), 'NODE_GET')
    const instanceConfig = instanceDetail.node.config
    // W3 引用形态：config 只存 {capabilityId, version, contentHash}，manifest 快照在 meta。
    // 固定版本双重验证 = 版本号 + 内容摘要与已发布 1.0 记录一致。
    if (instanceConfig?.version !== '1.0' || instanceConfig?.contentHash !== inner10.contentHash)
      throw new Error(`INSTANCE_NOT_FIXED_10:${JSON.stringify(instanceConfig)}`)
    await runCard(innerInstance())
    await assertRunsCompleted(await waitForRun('gui-copy-polish', '1.0', 2), 'INNER10_FIXED')
    const text10 = await readOutputText(instanceNode.nodeId, inner10.manifest)
    receipt.outputs.instanceRunText = text10
    if (text10.includes('草稿修改') || !text10.includes('内部说明')) throw new Error(`FIXED_VERSION_DRIFT:${text10}`)
    await shot('old-instance-still-1.0')
    check('GUI 内层发布 2.0 后，旧实例仍按 1.0 运行（config 引用与输出双重验证）')

    // ── 7. 外层「标题整理」引用内层 1.0：新文本节点 + 拖线 + 多选封装 ──
    await moveCard(innerInstance(), -420, 340)
    const text2 = await addTextNode()
    await moveCard(text2, 480, 0)
    await typeIntoCard(text2, '标题正文')
    const outPort = text2.locator('.port-dot.out[data-port-id="out-text"]')
    const inPort = innerInstance().locator('.port-dot.in').first()
    const from = await outPort.boundingBox()
    const to = await inPort.boundingBox()
    if (!from || !to) throw new Error('PORT_NOT_VISIBLE')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 18 })
    await page.mouse.up()
    await sleep(600)
    await shot('outer-edge-dragged')
    await text2.click()
    await innerInstance().click({ modifiers: ['Shift'] })
    await saveSelectionAsComposite('标题整理', 'gui-title-polish', innerInstance())
    const outer10 = ok(await cli(dir, ['composite', 'get'], { capabilityId: 'gui-title-polish', version: '1.0' }), 'GET_OUTER')
    const nestedDep = (outer10.manifest.dependencies || []).find((d) => d.kind === 'capability' && d.id === 'gui-copy-polish')
    if (!nestedDep || nestedDep.version !== '1.0') throw new Error(`NESTED_DEP_NOT_FIXED:${JSON.stringify(nestedDep)}`)
    check('GUI 拖线连接文本→内层 1.0 实例，多选封装「标题整理」1.0（依赖固定 gui-copy-polish@1.0）')

    // ── 8. GUI 运行外层实例 ──
    const outerInstance = page.locator('.node-card-wrap:has([data-node-type="composite"])', { hasText: '标题整理' }).first()
    await runCard(outerInstance)
    await assertRunsCompleted(await waitForRun('gui-title-polish', '1.0', 1), 'OUTER')
    // 外层实例刚封装，画布异步防抖落盘：用 latest 视图并轮询取节点。
    let outerNode = null
    for (let i = 0; i < 20; i++) {
      const graphOuter = ok(await cli(dir, ['graph', 'get'], { projectId, view: 'latest', limit: 200 }), 'GRAPH_OUTER')
      outerNode = graphOuter.nodes.find((n) => n.type === 'composite' && n.title === '标题整理')
      if (outerNode) break
      await page.keyboard.press('Control+s')
      await sleep(500)
    }
    if (!outerNode) throw new Error('OUTER_INSTANCE_NOT_FOUND')
    const outerText = await readOutputText(outerNode.nodeId, outer10.manifest)
    receipt.outputs.outerRunText = outerText
    if (!outerText.includes('标题正文') || !outerText.includes('内部说明')) throw new Error(`OUTER_TEXT_MISMATCH:${outerText}`)
    if (outerText.includes('草稿修改')) throw new Error(`OUTER_USED_20:${outerText}`)
    await shot('outer-run-output')
    check('GUI 运行外层实例：输出合并文本且仍来自内层 1.0')

    // ── 9. 不兼容 3.0：新增必填输入 → 升级预检阻断 → 原实例仍可运行 ──
    const base = inner10.manifest
    const extraNode = {
      ...base.graph.nodes[0],
      id: 'n-extra',
      title: '额外输入',
      dx: 480,
      dy: 0,
      text: ''
    }
    const breaking30 = {
      ...base,
      version: '3.0',
      graph: { ...base.graph, nodes: [...base.graph.nodes, extraNode] },
      inputs: [...base.inputs, { id: 'extra-required', label: '额外必填', type: 'text', required: true, cardinality: 'one', targets: [{ nodeId: 'n-extra', portId: 'in-text' }] }]
    }
    ok(await cli(dir, ['composite', 'publish'], { manifest: breaking30 }), 'PUBLISH_30')
    const preview = ok(await cli(dir, ['composite', 'upgrade', 'preview'], { projectId, nodeId: instanceNode.nodeId, nextManifest: breaking30 }), 'UPGRADE_PREVIEW')
    receipt.outputs.upgradePreview = { ok: preview.ok, addedRequiredInputs: preview.impact?.addedRequiredInputs, breaking: preview.impact?.breaking }
    if (preview.ok !== false) throw new Error(`UPGRADE_NOT_BLOCKED:${JSON.stringify(preview)}`)
    await shot('upgrade-preview-blocked-cli')
    await runCard(innerInstance())
    await assertRunsCompleted(await waitForRun('gui-copy-polish', '1.0', 3), 'INNER10_AFTER_BLOCK')
    check('不兼容 3.0 升级预检阻断（新增必填输入），原 1.0 实例仍可 GUI 运行')

    // ── 9b. W3 GUI 实例升级：右键「升级节点流」→ 预检 → 确认升级 ──
    await innerInstance().click({ button: 'right' })
    await page.waitForSelector('.node-context-menu', { timeout: 10000 })
    await page.click('.node-context-menu button:has-text("升级节点流")')
    const upgradeDialog = page.locator('.composite-modal[aria-label="升级节点流实例"]')
    await upgradeDialog.waitFor({ timeout: 15000 })
    await upgradeDialog.locator('select[aria-label="目标版本"]').selectOption('2.0')
    await page.waitForSelector('.composite-modal[aria-label="升级节点流实例"] .composite-modal-pass', { timeout: 20000 })
    await shot('upgrade-dialog-preview')
    await upgradeDialog.locator('button:has-text("确认升级")').click()
    await upgradeDialog.waitFor({ state: 'detached', timeout: 15000 })
    // 画布保存是异步防抖：显式 Ctrl+S 并轮询落盘后的 config，避免与保存竞态。
    let upgradedDetail = null
    for (let attempt = 0; attempt < 12; attempt++) {
      await page.keyboard.press('Control+s')
      await sleep(600)
      upgradedDetail = ok(await cli(dir, ['node', 'get'], { projectId, nodeId: instanceNode.nodeId }), 'NODE_UPGRADED')
      if (upgradedDetail.node.config?.version === '2.0') break
    }
    if (upgradedDetail.node.config?.version !== '2.0') throw new Error(`GUI_UPGRADE_NOT_APPLIED:${JSON.stringify(upgradedDetail.node.config)}`)
    await runCard(innerInstance())
    await assertRunsCompleted(await waitForRun('gui-copy-polish', '2.0', 1), 'INNER20_UPGRADED')
    const upgradedText = await readOutputText(instanceNode.nodeId, inner20.manifest)
    if (!upgradedText.includes('草稿修改')) throw new Error(`UPGRADED_OUTPUT_WRONG:${upgradedText}`)
    await shot('upgraded-instance-run')
    check('GUI 右键升级节点流：预检通过→确认升级→实例按 2.0 运行（引用形态）')

    // ── 10. 保存/取消语义（第三轮裁决：取消即退出，无二次确认）──
    // 保存草稿 → 取消关闭 → 草稿持久化。
    await editButton('文案整理')
    await typeIntoCard(innerCard(), '内部说明（临时保存）')
    await page.click('.nf-action-bar button[title^="暂存当前内容"]')
    let draftSavedClose = null
    for (let i = 0; i < 20; i++) {
      draftSavedClose = ok(await cli(dir, ['composite', 'draft', 'get'], { capabilityId: 'gui-copy-polish' }), 'DRAFT_SAVE_CLOSE')
      if (JSON.stringify(draftSavedClose.manifest).includes('临时保存')) break
      await sleep(400)
    }
    if (!JSON.stringify(draftSavedClose.manifest).includes('临时保存')) throw new Error('SAVE_NOT_PERSISTED')
    await page.click('.nf-action-bar button[title="退出编辑，返回画布"]')
    await page.waitForSelector('.composite-canvas-overlay', { state: 'detached', timeout: 10000 })
    // 修改但不保存 → 取消即退出（无确认）→ 草稿不含未保存修改。
    await editButton('文案整理')
    await typeIntoCard(innerCard(), '内部说明（将被放弃）')
    await page.click('.nf-action-bar button[title="退出编辑，返回画布"]')
    await page.waitForSelector('.composite-canvas-overlay', { state: 'detached', timeout: 10000 })
    await shot('cancel-close-no-confirm')
    const draftDiscard = ok(await cli(dir, ['composite', 'draft', 'get'], { capabilityId: 'gui-copy-polish' }), 'DRAFT_DISCARD')
    const draftJson = JSON.stringify(draftDiscard.manifest)
    if (draftJson.includes('将被放弃') || !draftJson.includes('临时保存')) throw new Error('CANCEL_CHANGED_DRAFT')
    check('GUI 保存持久化草稿、取消即退出且不保存未存修改（无二次确认，CLI 复核）')

    receipt.outputs.innerVersions = ok(await cli(dir, ['composite', 'version', 'list'], { capabilityId: 'gui-copy-polish' }), 'VERSION_LIST').map((v) => v.version)
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