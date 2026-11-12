/* eslint-disable */
// Agent Flow 布局验收（L2）：隔离数据目录，真实 Electron + CLI + MCP + GUI，退出清理。
// 前置：npx electron-vite build；本机已激活授权（%APPDATA%\canvas-studio\data\security）。
// 不依赖模型/密钥/计费。运行：node scripts/acceptance/agent-flow-layout.cjs
const { _electron } = require('playwright')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-layout')
const key = () => `${Date.now()}:${randomUUID()}`

async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input) fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }))
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath.includes('electron') ? process.execPath : require('electron'), [
      path.join(root, 'out/main/local-agent.js'),
      ...args,
      '--data-dir',
      dir,
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

function ok2(res, label) {
  if (res.code !== 0 || !res.response || res.response.error)
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 600)}`)
  return res.response.data
}

async function withVersionRetry(dir, projectId, label, call) {
  let last = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const graph = ok2(await cli(dir, ['graph', 'get'], { projectId }), `${label}_GRAPH`)
    const res = await call(graph.graphVersion)
    if (res.code === 0 && res.response && !res.response.error) return res.response.data
    last = res
    const code = res.response?.error?.code
    if (code !== 'REVISION_CONFLICT' && code !== 'OUTCOME_UNKNOWN') break
    await new Promise((r) => setTimeout(r, code === 'OUTCOME_UNKNOWN' ? 2000 : 250))
  }
  throw new Error(`${label}:${JSON.stringify(last?.response || last).slice(0, 600)}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 验证 flow 夹具：状态机+主控+4 专家+5 processor（素材源→选题→资料→框架→文章）+审核 ──
// 坐标故意乱填（模拟外部 Agent 手拍），autoLayout 必须整理成可读泳道。
// 两批建图（外部 Agent 真实做法）：批 1 建节点拿真实 ID；批 2 用真实 ID 补
// allowedNodeIds/gatedNodeIds 配置与数据边，并 autoLayout（config 值不做 ref 解析）。
function createOps() {
  const messy = (i) => ({ x: ((i * 137) % 900) - 200, y: ((i * 211) % 700) - 100 })
  const agent = (role) => ({
    schemaVersion: 1, role, interactionMode: 'autonomous',
    skills: [], tools: [], allowedNodeIds: [], maxSteps: 12, relations: []
  })
  const ops = []
  const create = (ref, nodeType, title, i, config) =>
    ops.push({ action: 'node.create', ref, nodeType, title, ...messy(i), ...(config ? { config } : {}) })
  create('sm', 'state-machine', '流程状态', 0, {
    schemaVersion: 1, initialState: 'draft',
    states: ['draft', 'working', 'reviewing', 'completed', 'stopped'],
    transitions: [{ from: 'draft', event: 'flow.started', to: 'working' }],
    relations: []
  })
  create('coord', 'agent', '主控', 1, agent('coordinator'))
  create('s1', 'agent', '选题专家', 2, agent('specialist'))
  create('s2', 'agent', '资料专家', 3, agent('specialist'))
  create('s3', 'agent', '框架专家', 4, agent('specialist'))
  create('s4', 'agent', '写作专家', 5, agent('specialist'))
  create('p0', 'processor', '素材源', 6)
  create('p1', 'processor', '选题', 7)
  create('p2', 'processor', '资料', 8)
  create('p3', 'processor', '框架', 9)
  create('p4', 'processor', '文章', 10)
  create('rev', 'ai-review', '审核', 11, {
    schemaVersion: 1, rulesVersion: 'layout-accept', reviewMode: 'text-json',
    rejectPolicy: 'stop', maxReworks: 1,
    subjectSources: [], gatedNodeIds: [], relations: []
  })
  return ops
}

function wireOps(byRef) {
  const ops = []
  const update = (ref, config) => ops.push({ action: 'node.update', nodeId: byRef[ref], config })
  update('coord', { allowedNodeIds: [byRef.s1, byRef.s2, byRef.s3, byRef.s4] })
  update('s1', { allowedNodeIds: [byRef.p1] })
  update('s2', { allowedNodeIds: [byRef.p2] })
  update('s3', { allowedNodeIds: [byRef.p3] })
  update('s4', { allowedNodeIds: [byRef.p4] })
  update('rev', {
    responsibleNodeId: byRef.p4,
    subjectSources: [{ nodeId: byRef.p4, portId: 'out-value' }],
    gatedNodeIds: [byRef.p4]
  })
  for (const [from, to] of [['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3'], ['p3', 'p4']])
    ops.push({ action: 'edge.create', from: { nodeId: byRef[from], portId: 'out-value' }, to: { nodeId: byRef[to], portId: 'in-value' } })
  return ops
}

function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

// 平移无关的相对坐标（parity 断言用：GUI/CLI/MCP 的 origin 可能不同）。
function relative(nodes) {
  const minX = Math.min(...nodes.map((n) => n.x))
  const minY = Math.min(...nodes.map((n) => n.y))
  return Object.fromEntries(nodes.map((n) => [n.title, { x: n.x - minX, y: n.y - minY }]))
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-flow-layout-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { mode: 'playwright-driven-real-electron (NOT human clicks)', checks: [], outputs: {}, screenshots: [] }
  const consoleLog = []
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
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [root, '--local-agent-access'],
      env: launchEnv
    })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    page.on('console', (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (err) => consoleLog.push(`[pageerror] ${String(err?.stack || err)}`))
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] Agent Flow 布局验收')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json')))
      throw new Error('CONNECTION_NOT_READY')

    const created = await cli(dir, ['project', 'create'], { name: '[TEST] Agent Flow 布局验收' })
    if (created.code !== 0) throw new Error(`CREATE_FAILED:${JSON.stringify(created.response)}`)
    const projectId = created.response.data.meta.id
    ok2(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    await page.waitForSelector('.node-palette', { timeout: 30000 })
    check('CLI 创建并打开 [TEST] 项目，GUI 画布就绪')

    // ── 1. 两批建图 + autoLayout：乱坐标一次整理即整齐 ──
    const created1 = await withVersionRetry(dir, projectId, 'PATCH_NODES', (graphVersion) =>
      cli(dir, ['graph', 'patch'], { projectId, expectedGraphVersion: graphVersion, ops: createOps() })
    )
    const byRef = Object.fromEntries(created1.created.map((c) => [c.ref, c.nodeId]))
    const patched = await withVersionRetry(dir, projectId, 'PATCH_FLOW', (graphVersion) =>
      cli(dir, ['graph', 'patch'], { projectId, expectedGraphVersion: graphVersion, ops: wireOps(byRef), autoLayout: true })
    )
    if (patched.layout?.mode !== 'lanes') throw new Error(`AUTO_LAYOUT_NOT_LANES:${JSON.stringify(patched.layout)}`)
    if (patched.layout?.moved !== 12) throw new Error(`AUTO_LAYOUT_MOVED:${JSON.stringify(patched.layout)}`)
    receipt.outputs.autoLayout = patched.layout
    let graph = ok2(await cli(dir, ['graph', 'get'], { projectId, limit: 100 }), 'GRAPH')
    const nodesOf = (g) => g.nodes.map((n) => ({ ...n, title: n.title }))
    let nodes = nodesOf(graph)
    const nodeByTitle = (t) => nodes.find((n) => n.title === t)
    // 零重叠
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        if (overlap(nodes[i], nodes[j])) throw new Error(`OVERLAP:${nodes[i].title}×${nodes[j].title}`)
    // 成果链左→右
    const chain = ['素材源', '选题', '资料', '框架', '文章'].map(nodeByTitle)
    for (let i = 1; i < chain.length; i++)
      if (chain[i].x <= chain[i - 1].x) throw new Error(`CHAIN_NOT_FORWARD:${chain[i].title}`)
    // 专家对齐 target（±40px）
    for (const [s, t] of [['选题专家', '选题'], ['资料专家', '资料'], ['框架专家', '框架'], ['写作专家', '文章']]) {
      const sn = nodeByTitle(s), tn = nodeByTitle(t)
      if (Math.abs(sn.x + sn.w / 2 - (tn.x + tn.w / 2)) > 40) throw new Error(`SPECIALIST_NOT_ALIGNED:${s}`)
    }
    // 带序：control < execution < output < review
    const bandMax = (ts) => Math.max(...ts.map((t) => nodeByTitle(t).y + nodeByTitle(t).h))
    const bandMin = (ts) => Math.min(...ts.map((t) => nodeByTitle(t).y))
    if (bandMax(['流程状态', '主控']) >= bandMin(['选题专家', '资料专家', '框架专家', '写作专家'])) throw new Error('BAND_ORDER_CONTROL')
    if (bandMax(['选题专家', '资料专家', '框架专家', '写作专家']) >= bandMin(['素材源', '选题', '资料', '框架', '文章'])) throw new Error('BAND_ORDER_EXEC')
    if (bandMax(['素材源', '选题', '资料', '框架', '文章']) >= bandMin(['审核'])) throw new Error('BAND_ORDER_REVIEW')
    await shot(page, 'autolayout-lanes')
    check('graph.patch autoLayout：12 节点乱坐标→泳道（零重叠/成果链前向/专家对齐/带序）')

    // ── 2. CLI graph.layout 三模式 ──
    const flowResult = await withVersionRetry(dir, projectId, 'LAYOUT_FLOW', (graphVersion) =>
      cli(dir, ['graph', 'layout'], { projectId, expectedGraphVersion: graphVersion, mode: 'flow' })
    )
    if (flowResult.mode !== 'flow' || flowResult.moved !== 12) throw new Error(`FLOW_MODE:${JSON.stringify(flowResult)}`)
    graph = ok2(await cli(dir, ['graph', 'get'], { projectId, limit: 100 }), 'GRAPH_FLOW')
    nodes = nodesOf(graph)
    for (const [from, to] of [['素材源', '选题'], ['选题', '资料'], ['资料', '框架'], ['框架', '文章']])
      if (nodeByTitle(from).x >= nodeByTitle(to).x) throw new Error(`FLOW_EDGE_BACKWARD:${from}->${to}`)
    check('CLI graph.layout mode=flow：数据边全部前向')

    const gridResult = await withVersionRetry(dir, projectId, 'LAYOUT_GRID', (graphVersion) =>
      cli(dir, ['graph', 'layout'], { projectId, expectedGraphVersion: graphVersion, mode: 'grid' })
    )
    if (gridResult.mode !== 'grid') throw new Error(`GRID_MODE:${JSON.stringify(gridResult)}`)
    check('CLI graph.layout mode=grid：网格兜底')

    const lanesResult = await withVersionRetry(dir, projectId, 'LAYOUT_LANES', (graphVersion) =>
      cli(dir, ['graph', 'layout'], { projectId, expectedGraphVersion: graphVersion, mode: 'lanes' })
    )
    graph = ok2(await cli(dir, ['graph', 'get'], { projectId, limit: 100 }), 'GRAPH_LANES')
    const canonical = relative(nodesOf(graph))
    receipt.outputs.canonicalLanes = canonical
    check('CLI graph.layout mode=lanes：基准坐标记录')

    // ── 3. GUI 智能整理：打乱 → 点击按钮 → 与 CLI 基准 parity → 单步撤销 ──
    const scrambleOps = nodesOf(graph).map((n, i) => ({
      action: 'node.update', nodeId: n.nodeId, x: ((i * 313) % 1100) - 300, y: ((i * 197) % 800) - 150
    }))
    await withVersionRetry(dir, projectId, 'SCRAMBLE', (graphVersion) =>
      cli(dir, ['graph', 'patch'], { projectId, expectedGraphVersion: graphVersion, ops: scrambleOps })
    )
    await sleep(1500) // 等外部变更 reload 到画布
    await shot(page, 'gui-before-scrambled')
    await page.click('button[aria-label="智能整理画布"]')
    await sleep(1500)
    await shot(page, 'gui-after-smart-organize')
    graph = ok2(await cli(dir, ['graph', 'get'], { projectId, limit: 100 }), 'GRAPH_GUI')
    const guiRelative = relative(nodesOf(graph))
    for (const title of Object.keys(canonical)) {
      const a = canonical[title], b = guiRelative[title]
      if (!b || Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2)
        throw new Error(`GUI_PARITY_DRIFT:${title}:${JSON.stringify({ canonical: a, gui: b })}`)
    }
    check('GUI 智能整理按钮：与 CLI lanes 基准坐标一致（平移无关 parity）')
    // 单步撤销恢复打乱坐标
    await page.keyboard.press('Control+z')
    await sleep(800)
    await page.keyboard.press('Control+s')
    await sleep(1200)
    graph = ok2(await cli(dir, ['graph', 'get'], { projectId, limit: 100 }), 'GRAPH_UNDO')
    const undoNode = nodesOf(graph).find((n) => n.title === '素材源')
    const scrambledSource = scrambleOps.find((op) => op.nodeId === byRef.p0)
    if (undoNode.x !== scrambledSource.x || undoNode.y !== scrambledSource.y)
      throw new Error(`UNDO_NOT_SINGLE_STEP:${JSON.stringify({ undoNode, scrambledSource })}`)
    check('GUI 单步撤销恢复打乱坐标（布局为单撤销步）')

    // ── 4. MCP graph_layout 与 CLI 一致 ──
    const transport = new StdioClientTransport({
      command: require('electron'),
      args: [path.join(root, 'out/main/local-agent.js'), 'mcp', 'serve', '--stdio', '--data-dir', dir],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe'
    })
    const mcp = new Client({ name: 'flow-layout-acceptance', version: '1.0.0' }, { capabilities: {} })
    await mcp.connect(transport)
    try {
      const tools = await mcp.listTools()
      if (!tools.tools.some((tool) => tool.name === 'graph_layout')) throw new Error('MCP_GRAPH_LAYOUT_MISSING')
      const mcpGraph = ok2(await cli(dir, ['graph', 'get'], { projectId }), 'MCP_GRAPH')
      const res = await mcp.callTool({
        name: 'graph_layout',
        arguments: { input: { projectId, expectedGraphVersion: mcpGraph.graphVersion, mode: 'lanes' }, idempotencyKey: key() }
      })
      if (res.structuredContent?.status !== 'completed' || res.structuredContent?.data?.mode !== 'lanes')
        throw new Error(`MCP_LAYOUT_FAILED:${JSON.stringify(res.structuredContent)}`)
      const after = ok2(await cli(dir, ['graph', 'get'], { projectId, limit: 100 }), 'MCP_AFTER')
      const mcpRelative = relative(nodesOf(after))
      for (const title of Object.keys(canonical)) {
        const a = canonical[title], b = mcpRelative[title]
        if (!b || Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2)
          throw new Error(`MCP_PARITY_DRIFT:${title}`)
      }
      check('MCP graph_layout：工具存在且与 CLI/GUI 基准坐标一致')
    } finally {
      await mcp.close().catch(() => undefined)
    }

    console.log(JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.writeFileSync(path.join(evidenceDir, 'renderer-console.log'), consoleLog.join('\n'))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    fs.writeFileSync(path.join(evidenceDir, 'renderer-console.log'), consoleLog.join('\n'))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()