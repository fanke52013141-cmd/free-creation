/* eslint-disable */
// Agent Flow 连线治理走查（L3）：四色控制线 / rework 下弧 / 反向数据边外弧 /
// 角色徽标 / 选中聚焦淡化。真实 Electron + Playwright 合成事件（非人工点击）。
// 前置：npx electron-vite build；本机已激活授权。不依赖模型/密钥/计费。
// 运行：node scripts/acceptance/agent-flow-edges-walkthrough.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-edges')
const key = () => `${Date.now()}:${randomUUID()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input) fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }))
  return await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [
      path.join(root, 'out/main/local-agent.js'),
      ...args, '--data-dir', dir,
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
const ok = (res, label) => {
  if (res.code !== 0 || !res.response || res.response.error)
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 600)}`)
  return res.response.data
}
async function patchWithRetry(dir, projectId, ops, label) {
  let last = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const graph = ok(await cli(dir, ['graph', 'get'], { projectId }), `${label}_GRAPH`)
    const res = await cli(dir, ['graph', 'patch'], { projectId, expectedGraphVersion: graph.graphVersion, ops })
    if (res.code === 0 && !res.response?.error) return res.response.data
    last = res
    if (res.response?.error?.code !== 'REVISION_CONFLICT') break
    await sleep(400)
  }
  throw new Error(`${label}:${JSON.stringify(last?.response || last).slice(0, 600)}`)
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-flow-edges-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { mode: 'playwright-driven-real-electron (NOT human clicks)', checks: [], outputs: {}, screenshots: [] }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const shot = async (page, name) => {
    fs.mkdirSync(evidenceDir, { recursive: true })
    const file = path.join(evidenceDir, `${String(receipt.screenshots.length + 1).padStart(2, '0')}-${name}.png`)
    await page.screenshot({ path: file })
    receipt.screenshots.push(path.basename(file))
  }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] Agent Flow 连线治理走查')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] Agent Flow 连线走查' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    await page.waitForSelector('.node-palette', { timeout: 30000 })

    const agent = (role) => ({ schemaVersion: 1, role, interactionMode: 'autonomous', skills: [], tools: [], allowedNodeIds: [], maxSteps: 12, relations: [] })
    const batch1 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'sm', nodeType: 'state-machine', title: '流程状态', x: 0, y: 0, config: { schemaVersion: 1, initialState: 'draft', states: ['draft', 'working', 'completed'], transitions: [{ from: 'draft', event: 'flow.started', to: 'working' }], relations: [] } },
      { action: 'node.create', ref: 'coord', nodeType: 'agent', title: '主控', x: 0, y: 0, config: agent('coordinator') },
      { action: 'node.create', ref: 's1', nodeType: 'agent', title: '选题专家', x: 0, y: 0, config: agent('specialist') },
      { action: 'node.create', ref: 's2', nodeType: 'agent', title: '资料专家', x: 0, y: 0, config: agent('specialist') },
      { action: 'node.create', ref: 's3', nodeType: 'agent', title: '框架专家', x: 0, y: 0, config: agent('specialist') },
      { action: 'node.create', ref: 's4', nodeType: 'agent', title: '写作专家', x: 0, y: 0, config: agent('specialist') },
      { action: 'node.create', ref: 'p0', nodeType: 'processor', title: '素材源', x: 0, y: 0, config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } },
      { action: 'node.create', ref: 'p1', nodeType: 'processor', title: '选题', x: 0, y: 0, config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } },
      { action: 'node.create', ref: 'p2', nodeType: 'processor', title: '资料', x: 0, y: 0, config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } },
      { action: 'node.create', ref: 'p3', nodeType: 'processor', title: '框架', x: 0, y: 0, config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } },
      { action: 'node.create', ref: 'p4', nodeType: 'processor', title: '文章', x: 0, y: 0, config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } },
      { action: 'node.create', ref: 'rev', nodeType: 'ai-review', title: '审核', x: 0, y: 0, config: { schemaVersion: 1, rulesVersion: 'edges-walkthrough', reviewMode: 'text-json', rejectPolicy: 'rework', maxReworks: 2, subjectSources: [], gatedNodeIds: [], relations: [] } }
    ], 'BATCH1')
    const r = Object.fromEntries(batch1.created.map((c) => [c.ref, c.nodeId]))
    await patchWithRetry(dir, projectId, [
      { action: 'node.update', nodeId: r.coord, config: { allowedNodeIds: [r.s1, r.s2, r.s3, r.s4], relations: [{ relationId: 'obs-1', kind: 'observes', sourceNodeId: r.coord, targetNodeId: r.sm }] } },
      { action: 'node.update', nodeId: r.s1, config: { allowedNodeIds: [r.p1] } },
      { action: 'node.update', nodeId: r.s2, config: { allowedNodeIds: [r.p2] } },
      { action: 'node.update', nodeId: r.s3, config: { allowedNodeIds: [r.p3] } },
      { action: 'node.update', nodeId: r.s4, config: { allowedNodeIds: [r.p4] } },
      { action: 'node.update', nodeId: r.rev, config: { responsibleNodeId: r.s4, subjectSources: [{ nodeId: r.p4, portId: 'out-value' }], gatedNodeIds: [r.p4], relations: [{ relationId: 'gate-1', kind: 'review-gate', sourceNodeId: r.rev, targetNodeId: r.p4 }, { relationId: 'rework-1', kind: 'rework', sourceNodeId: r.rev, targetNodeId: r.s4 }] } },
      { action: 'edge.create', from: { nodeId: r.p0, portId: 'out-value' }, to: { nodeId: r.p1, portId: 'in-value' } },
      { action: 'edge.create', from: { nodeId: r.p1, portId: 'out-value' }, to: { nodeId: r.p2, portId: 'in-value' } },
      { action: 'edge.create', from: { nodeId: r.p2, portId: 'out-value' }, to: { nodeId: r.p3, portId: 'in-value' } },
      { action: 'edge.create', from: { nodeId: r.p3, portId: 'out-value' }, to: { nodeId: r.p4, portId: 'in-value' } },
      // 反向数据边（审核反馈回素材源）：验证上方外弧路由。
      { action: 'edge.create', from: { nodeId: r.rev, portId: 'out-feedback' }, to: { nodeId: r.p0, portId: 'in-value' } }
    ], 'BATCH2')
    // 智能整理成泳道（版本冲突重试：自动保存会推高 graphVersion）
    let layoutDone = false
    for (let attempt = 0; attempt < 6 && !layoutDone; attempt++) {
      const graph = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH')
      const res = await cli(dir, ['graph', 'layout'], { projectId, expectedGraphVersion: graph.graphVersion, mode: 'lanes' })
      if (res.code === 0 && !res.response?.error) layoutDone = true
      else if (res.response?.error?.code !== 'REVISION_CONFLICT')
        throw new Error(`LAYOUT:${JSON.stringify(res.response).slice(0, 400)}`)
      else await sleep(400)
    }
    if (!layoutDone) throw new Error('LAYOUT_RETRY_EXHAUSTED')
    await sleep(1800)
    await shot(page, 'lanes-overview')
    check('CLI 建 12 节点 flow + 四类控制关系 + 反向数据边，lanes 整理就绪')

    // ── 断言 1：控制线四色（computed stroke）──
    const colors = await page.evaluate(() => {
      const get = (kind) => {
        const el = document.querySelector(`.agent-flow-control-path[data-control-kind="${kind}"]`)
        return el ? getComputedStyle(el).stroke : null
      }
      return { controls: get('controls'), observes: get('observes'), 'review-gate': get('review-gate'), rework: get('rework') }
    })
    receipt.outputs.controlColors = colors
    if (!colors.controls || !colors.observes || !colors['review-gate'] || !colors.rework)
      throw new Error(`CONTROL_KIND_MISSING:${JSON.stringify(colors)}`)
    const distinct = new Set(Object.values(colors))
    if (distinct.size !== 4) throw new Error(`CONTROL_COLORS_NOT_DISTINCT:${JSON.stringify(colors)}`)
    check(`控制线四色区分：${JSON.stringify(colors)}`)

    // ── 断言 2：rework 返工线不穿卡（垂直布局走同侧绕弧，水平布局偏好底边下弧）──
    const reworkCheck = await page.evaluate(() => {
      const layer = document.querySelector('.agent-flow-relation-layer')
      const el = layer.querySelector('.agent-flow-control-path[data-control-kind="rework"]')
      const origin = layer.getBoundingClientRect()
      const nums = (el.getAttribute('d').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
      const [x0, y0, x1, y1, x2, y2, x3, y3] = nums
      const cards = [...document.querySelectorAll('.node-card-wrap')].map((c) => {
        const b = c.getBoundingClientRect()
        return { x: b.left - origin.left, y: b.top - origin.top, w: b.width, h: b.height }
      })
      let hits = 0
      for (let i = 1; i < 40; i++) {
        const t = i / 40
        const mt = 1 - t
        const px = mt ** 3 * x0 + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3
        const py = mt ** 3 * y0 + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3
        if (cards.some((c) => px > c.x + 2 && px < c.x + c.w - 2 && py > c.y + 2 && py < c.y + c.h - 2)) hits++
      }
      return {
        anchors: { source: el.getAttribute('data-anchor-source'), target: el.getAttribute('data-anchor-target') },
        hits
      }
    })
    receipt.outputs.rework = reworkCheck
    if (reworkCheck.hits > 0) throw new Error(`REWORK_CROSSES_CARDS:${JSON.stringify(reworkCheck)}`)
    check(`rework 返工线不穿卡（锚点 ${reworkCheck.anchors.source}→${reworkCheck.anchors.target}）`)

    // ── 断言 3：反向数据边外弧（控制点在端点上方）──
    const backwardCheck = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('g[data-edge-id]')]
      for (const g of groups) {
        const visible = g.querySelector('.data-edge-visible')
        if (!visible) continue
        const nums = (visible.getAttribute('d').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
        if (nums.length !== 8) continue
        const [x0, y0, c1x, c1y, c2x, c2y, x3, y3] = nums
        // 反向边：源 x > 目标 x，且控制柄垂直（c1x==x0, c2x==x3）在上方。
        if (x0 > x3 && c1x === x0 && c2x === x3 && c1y < Math.min(y0, y3) && c2y < Math.min(y0, y3))
          return { ok: true, lift: Math.min(y0, y3) - c1y }
      }
      return { ok: false }
    })
    receipt.outputs.backwardEdge = backwardCheck
    if (!backwardCheck.ok) throw new Error('BACKWARD_ARC_NOT_FOUND')
    check(`反向数据边走上方外弧（lift=${backwardCheck.lift.toFixed(0)}px）`)

    // ── 断言 4：角色徽标 ──
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll('.agent-flow-role-chip')].map((el) => el.textContent)
    )
    receipt.outputs.roleChips = chips
    if (!chips.includes('主控') || chips.filter((c) => c === '专业').length !== 4)
      throw new Error(`ROLE_CHIPS_WRONG:${JSON.stringify(chips)}`)
    check('角色徽标：主控×1 + 专业×4')

    // ── 断言 5：选中聚焦淡化（processor 有数据边；专家有控制关系）──
    const focusStats = () => page.evaluate(() => ({
      dimmedEdges: document.querySelectorAll('.data-edge.is-dimmed, [data-edge-id].is-dimmed').length,
      dimmedRelations: document.querySelectorAll('.agent-flow-control-path.is-dimmed').length,
      totalEdges: document.querySelectorAll('g[data-edge-id]').length,
      totalRelations: document.querySelectorAll('.agent-flow-control-path').length
    }))
    // 5a：选中「选题」processor（p0→p1→p2 两条数据边相连）→ 相连边保持，其余淡化。
    // 点击卡片头部（左上角）：中心是正文输入区，点中心会聚焦文本而非选中节点。
    const processorCard = page.locator('.node-card-wrap:has([data-node-type="processor"])', { hasText: '选题' }).first()
    await processorCard.click({ position: { x: 20, y: 12 } })
    await sleep(800)
    if (!(await processorCard.evaluate((el) => el.classList.contains('is-selected'))))
      throw new Error('PROCESSOR_NOT_SELECTED')
    const focusProcessor = await focusStats()
    receipt.outputs.focusProcessor = focusProcessor
    if (focusProcessor.dimmedEdges === 0 || focusProcessor.dimmedEdges >= focusProcessor.totalEdges)
      throw new Error(`FOCUS_PROCESSOR_WRONG:${JSON.stringify(focusProcessor)}`)
    await shot(page, 'focus-processor')
    check(`选中 processor：无关数据边淡化 ${focusProcessor.dimmedEdges}/${focusProcessor.totalEdges}，相连边保持`)
    await page.keyboard.press('Escape')
    await sleep(500)
    // 5b：选中「选题专家」（无数据边、有 controls 关系）→ 其控制关系保持，其余淡化。
    const specialistCard = page.locator('.node-card-wrap:has([data-node-type="agent"])', { hasText: '选题专家' }).first()
    await specialistCard.click({ position: { x: 20, y: 12 } })
    await sleep(800)
    if (!(await specialistCard.evaluate((el) => el.classList.contains('is-selected'))))
      throw new Error('SPECIALIST_NOT_SELECTED')
    const focusSpecialist = await focusStats()
    receipt.outputs.focusSpecialist = focusSpecialist
    if (focusSpecialist.dimmedRelations === 0 || focusSpecialist.dimmedRelations >= focusSpecialist.totalRelations)
      throw new Error(`FOCUS_SPECIALIST_WRONG:${JSON.stringify(focusSpecialist)}`)
    await shot(page, 'focus-selected')
    check(`选中专家：无关关系淡化 ${focusSpecialist.dimmedRelations}/${focusSpecialist.totalRelations}，自身 controls 保持`)

    // 取消选中恢复
    await page.keyboard.press('Escape')
    await sleep(600)
    const restored = await page.evaluate(() => document.querySelectorAll('.is-dimmed').length)
    if (restored !== 0) throw new Error(`FOCUS_NOT_RESTORED:${restored}`)
    check('取消选中后全部连线恢复可见')

    console.log(JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: true, ...receipt }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()