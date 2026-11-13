/* eslint-disable */
// AF-01 阶段契约三入口定义一致性验收（确定性，无模型/无计费）。
// 证明：CLI graph.patch 可写固定顺序阶段配置 → CLI/MCP 读取一致 → GUI 设置面板渲染阶段编辑器并可保存回读。
// 运行语义（按声明顺序交接/缺字段缺人工决定不越过/零主控模型调用）由 test/flow-fixed-order.test.ts 真实宿主测试证明。
// 前置：$env:CANVAS_OWNER='1'; npx electron-vite build。运行：node scripts/acceptance/af01-stage-parity.cjs
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
const evidenceDir = path.join(root, 'qa', 'af01-stage-parity')
const key = () => `${Date.now()}:${randomUUID()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input) fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }))
  return await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [
      path.join(root, 'out/main/local-agent.js'), ...args, '--data-dir', dir,
      ...(input ? ['--input-file', file] : [])
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, 90000)
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
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 800)}`)
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-af01-parity-'))
  let app, projectId = null
  const consoleLog = []
  const receipt = { mode: 'deterministic (no model, no cost)', checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    page.on('console', (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (err) => consoleLog.push(`[pageerror] ${String(err?.stack || err)}`))
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] AF-01 阶段契约三入口')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] AF-01 阶段契约' }), 'CREATE')
    projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')

    // ── CLI 建固定顺序 flow：状态机 + 主控(fixed-order+stages) + 两专家 + 两 processor + 素材源 ──
    const batch1 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'sm', nodeType: 'state-machine', title: '流程状态', x: 0, y: 0, config: {
        schemaVersion: 1, initialState: 'draft', states: ['draft', 'working', 'waiting', 'completed'],
        transitions: [
          { from: 'draft', event: 'flow.started', to: 'working' },
          ...['agent.dispatched', 'agent.completed', 'human.wait', 'flow.paused', 'flow.completed'].map((event) => ({
            from: 'working', event,
            to: event === 'flow.completed' ? 'completed' : ['human.wait', 'flow.paused'].includes(event) ? 'waiting' : 'working'
          })),
          { from: 'waiting', event: 'human.continue', to: 'working' }
        ], relations: []
      } },
      { action: 'node.create', ref: 'coord', nodeType: 'agent', title: '主控', x: 440, y: 0,
        text: '固定任务：先整理再写作', config: { schemaVersion: 1, role: 'coordinator', interactionMode: 'autonomous',
          skills: [], tools: [{ id: 'agent.dispatch', version: '1' }], allowedNodeIds: [], maxSteps: 12, relations: [] } },
      { action: 'node.create', ref: 's1', nodeType: 'agent', title: '整理专家', x: 880, y: 0,
        text: '整理材料', config: { schemaVersion: 1, role: 'specialist', interactionMode: 'autonomous',
          modelDefinitionId: 'm', skills: [], tools: [{ id: 'node.execute', version: '1' }], allowedNodeIds: [], maxSteps: 12, relations: [] } },
      { action: 'node.create', ref: 's2', nodeType: 'agent', title: '写作专家', x: 1320, y: 0,
        text: '写作', config: { schemaVersion: 1, role: 'specialist', interactionMode: 'autonomous',
          modelDefinitionId: 'm', skills: [], tools: [{ id: 'node.execute', version: '1' }], allowedNodeIds: [], maxSteps: 12, relations: [] } },
      { action: 'node.create', ref: 'p1', nodeType: 'processor', title: '整理', x: 880, y: 420, config: { operation: 'pass' } },
      { action: 'node.create', ref: 'p2', nodeType: 'processor', title: '写作', x: 1320, y: 420, config: { operation: 'pass' } },
      { action: 'node.create', ref: 'src', nodeType: 'text', title: '素材源', x: 440, y: 420, text: '素材正文' }
    ], 'BATCH1')
    const byRef = Object.fromEntries(batch1.created.map((c) => [c.ref, c.nodeId]))
    const stages = [
      { stageKey: 'organize', nodeId: byRef.s1, goal: '整理材料', completion: '交付整理成果', entry: [] },
      { stageKey: 'write', nodeId: byRef.s2, goal: '基于整理成果写作', completion: '交付成稿',
        entry: [{ kind: 'output-count', stageKey: 'organize', op: 'gte', count: 1 }] }
    ]
    await patchWithRetry(dir, projectId, [
      { action: 'node.update', nodeId: byRef.coord, config: {
        executionMode: 'fixed-order', stages,
        allowedNodeIds: [byRef.s1, byRef.s2],
        relations: [{ relationId: 'obs-1', kind: 'observes', sourceNodeId: byRef.coord, targetNodeId: byRef.sm }]
      } },
      { action: 'node.update', nodeId: byRef.s1, config: { allowedNodeIds: [byRef.p1] } },
      { action: 'node.update', nodeId: byRef.s2, config: { allowedNodeIds: [byRef.p2] } },
      { action: 'edge.create', from: { nodeId: byRef.src, portId: 'out-text' }, to: { nodeId: byRef.s1, portId: 'in-text' } },
      { action: 'edge.create', from: { nodeId: byRef.src, portId: 'out-text' }, to: { nodeId: byRef.p1, portId: 'in-value' } },
      { action: 'edge.create', from: { nodeId: byRef.s1, portId: 'out-text' }, to: { nodeId: byRef.s2, portId: 'in-text' } },
      { action: 'edge.create', from: { nodeId: byRef.s1, portId: 'out-text' }, to: { nodeId: byRef.p2, portId: 'in-value' } }
    ], 'BATCH2')
    check('CLI graph.patch 写入固定顺序主控（executionMode=fixed-order + 2 阶段 + 进入条件）')

    // ── CLI 回读（config 走 node.get；graph.get 目录用 nodeId）──
    const graph = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH_READ')
    if (!graph.nodes.some((n) => n.nodeId === byRef.coord)) throw new Error('CLI_COORD_MISSING')
    const coordCfg = ok(await cli(dir, ['node', 'get'], { projectId, nodeId: byRef.coord }), 'NODE_GET').node.config
    if (coordCfg.executionMode !== 'fixed-order' || coordCfg.stages.length !== 2)
      throw new Error(`CLI_READ_WRONG:${JSON.stringify(coordCfg).slice(0, 400)}`)
    if (coordCfg.stages[1].entry[0].kind !== 'output-count')
      throw new Error(`CLI_ENTRY_WRONG:${JSON.stringify(coordCfg.stages[1])}`)
    receipt.outputs.cliStages = coordCfg.stages
    check('CLI node.get 回读：executionMode/stages/进入条件持久化一致')

    // ── MCP 回读一致 ──
    const transport = new StdioClientTransport({
      command: require('electron'),
      args: [path.join(root, 'out/main/local-agent.js'), 'mcp', 'serve', '--stdio', '--data-dir', dir],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe'
    })
    const mcp = new Client({ name: 'af01-parity', version: '1.0.0' }, { capabilities: {} })
    await mcp.connect(transport)
    try {
      const res = await mcp.callTool({ name: 'node_get', arguments: { input: { projectId, nodeId: byRef.coord } } })
      const mcpCfg = res.structuredContent?.data?.node?.config
      if (mcpCfg.executionMode !== 'fixed-order' || JSON.stringify(mcpCfg.stages) !== JSON.stringify(coordCfg.stages))
        throw new Error(`MCP_READ_WRONG:${JSON.stringify(mcpCfg).slice(0, 400)}`)
      check('MCP node_get 回读与 CLI 完全一致（同源配置）')
    } finally {
      await mcp.close().catch(() => undefined)
    }

    // ── AF-06：流程定义版本发布/列表/差异（与运行分离）──
    const def1 = ok(await cli(dir, ['flowDefinition', 'publish'], {
      projectId, definitionId: 'def-1', name: '固定写作流程', coordinatorNodeId: byRef.coord
    }), 'DEF_PUBLISH_1').definition
    if (def1.version !== 1 || def1.stages.length !== 2) throw new Error(`DEF_V1_WRONG:${JSON.stringify(def1).slice(0, 300)}`)
    // 修改第二阶段方法 → 发布 v2 → 差异预览
    await patchWithRetry(dir, projectId, [
      { action: 'node.update', nodeId: byRef.coord, config: {
        stages: [
          coordCfg.stages[0],
          { ...coordCfg.stages[1], method: { instructions: '先案例后分析' } }
        ]
      } }
    ], 'DEF_MODIFY')
    const def2 = ok(await cli(dir, ['flowDefinition', 'publish'], {
      projectId, definitionId: 'def-1', name: '固定写作流程', coordinatorNodeId: byRef.coord
    }), 'DEF_PUBLISH_2').definition
    if (def2.version !== 2) throw new Error(`DEF_V2_WRONG:${def2.version}`)
    const diff = ok(await cli(dir, ['flowDefinition', 'diff'], {
      projectId, definitionId: 'def-1', versionA: 1, versionB: 2
    }), 'DEF_DIFF').diff
    const writeDiff = diff.stages.find((s) => s.stageKey === 'write')
    if (!writeDiff || writeDiff.change !== 'changed' || !writeDiff.fields.includes('method'))
      throw new Error(`DEF_DIFF_WRONG:${JSON.stringify(diff)}`)
    const defList = ok(await cli(dir, ['flowDefinition', 'list'], { projectId }), 'DEF_LIST').definitions
    if (defList.length !== 1 || defList[0].version !== 2) throw new Error(`DEF_LIST_WRONG:${JSON.stringify(defList).slice(0, 200)}`)
    check('AF-06 CLI 定义发布 v1/v2 + 差异预览（method 变更）+ 列表最新版本')

    // ── AF-02：阶段输入编制预览（无运行 → null；声明存在）──
    const preview = ok(await cli(dir, ['flowStage', 'context', 'preview'], {
      projectId, nodeId: byRef.coord, stageKey: 'write'
    }), 'CTX_PREVIEW').preview
    // 无运行记录时预览返回 null（只读账本事实）
    if (preview !== null) throw new Error(`CTX_PREVIEW_EXPECT_NULL:${JSON.stringify(preview).slice(0, 200)}`)
    check('AF-02 CLI 阶段输入预览：无运行时如实返回 null（不伪造）')

    // ── GUI：打开主控设置面板，验证执行模式与阶段编辑器渲染 ──
    fs.mkdirSync(evidenceDir, { recursive: true })
    const coordCard = page.locator(`.node-card-wrap[data-node-id="${byRef.coord}"]`)
    await coordCard.scrollIntoViewIfNeeded()
    await coordCard.locator('button.node-info-btn[aria-label="打开节点说明"]').click()
    await page.waitForSelector('.agent-flow-settings', { timeout: 10000 })
    const modeText = await page.locator('.agent-flow-settings button[aria-label="执行模式"]').textContent()
    if (!modeText || !modeText.includes('固定顺序')) throw new Error(`GUI_MODE_WRONG:${modeText}`)
    const stageRows = await page.locator('.agent-flow-settings .agent-flow-stage').count()
    if (stageRows !== 2) throw new Error(`GUI_STAGE_ROWS_WRONG:${stageRows}`)
    const firstGoal = await page.locator('.agent-flow-settings textarea[aria-label="阶段 1 目标"]').inputValue()
    if (firstGoal !== '整理材料') throw new Error(`GUI_GOAL_WRONG:${firstGoal}`)
    const conditionRows = await page.locator('.agent-flow-settings .agent-flow-stage-condition').count()
    if (conditionRows !== 1) throw new Error(`GUI_CONDITION_ROWS_WRONG:${conditionRows}`)
    await page.screenshot({ path: path.join(evidenceDir, 'gui-stage-editor.png') }).catch(() => undefined)
    check('GUI 设置面板：执行模式=fixed-order，渲染 2 个阶段 + 1 条进入条件，目标逐字一致')

    // ── GUI 保存回读（GUI 写入口与 CLI 同源）──
    await page.locator('.agent-flow-settings button.website-settings-save').click()
    await sleep(800)
    const coordCfg2 = ok(await cli(dir, ['node', 'get'], { projectId, nodeId: byRef.coord }), 'NODE_GET2').node.config
    if (coordCfg2.executionMode !== 'fixed-order' || coordCfg2.stages.length !== 2)
      throw new Error(`GUI_SAVE_WRONG:${JSON.stringify(coordCfg2).slice(0, 400)}`)
    check('GUI 保存后 CLI 回读一致（GUI 写入口同源校验）')

    console.log(JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: true, ...receipt }, null, 2))
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