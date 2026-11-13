/* eslint-disable */
// C3 状态机外部事件验收：submitEvent/get + output.get out-state 投影 + 修订冲突。
// 确定性执行，不依赖模型/密钥/计费。前置：npx electron-vite build；本机已激活授权。
// 运行：node scripts/acceptance/agent-flow-state-machine.cjs
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
const evidenceDir = path.join(root, 'qa', 'agent-flow-state-machine')
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

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-statemachine-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
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
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] C3 状态机外部事件')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] C3 状态机' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    const graph0 = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH0')
    const patched = ok(await cli(dir, ['graph', 'patch'], {
      projectId, expectedGraphVersion: graph0.graphVersion,
      ops: [{
        action: 'node.create', ref: 'sm', nodeType: 'state-machine', title: '流程状态', x: 100, y: 100,
        config: {
          schemaVersion: 1, initialState: 'draft',
          states: ['draft', 'working', 'completed'],
          transitions: [
            { from: 'draft', event: 'flow.started', to: 'working' },
            { from: 'working', event: 'flow.completed', to: 'completed' }
          ], relations: []
        }
      }]
    }), 'PATCH')
    const sm = patched.created[0].nodeId
    check('CLI 建状态机节点（draft→working→completed）')

    // ── 1. 初始读取：draft / 修订 1 / 合法事件 flow.started ──
    const initial = ok(await cli(dir, ['flowStateMachine', 'get'], { projectId, nodeId: sm }), 'GET_INITIAL')
    if (initial.state !== 'draft' || initial.revision !== 1 || !initial.legalEvents.includes('flow.started'))
      throw new Error(`INITIAL_WRONG:${JSON.stringify(initial)}`)
    receipt.outputs.initial = initial
    check('flowStateMachine.get 初始：draft/修订1/合法事件 flow.started')

    // ── 2. 外部提交 flow.started（修订 1）→ 运行推进 ──
    const sub1 = ok(await cli(dir, ['flowStateMachine', 'submitEvent'], {
      projectId, nodeId: sm, event: 'flow.started', expectedRevision: 1
    }), 'SUBMIT_1')
    if (sub1.pending !== true || sub1.revision !== 1) throw new Error(`SUBMIT1_WRONG:${JSON.stringify(sub1)}`)
    const runNode = async () => {
      const g = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH_RUN')
      const exec = ok(await cli(dir, ['node', 'execute'], {
        projectId, expectedGraphVersion: g.graphVersion, nodeIds: [sm], mode: 'single'
      }), 'EXEC')
      const waited = ok(await cli(dir, ['run', 'wait'], { projectId, taskId: exec.taskId, timeoutMs: 30000 }), 'WAIT')
      if (waited.state !== 'completed') throw new Error(`RUN_NOT_COMPLETED:${JSON.stringify(waited)}`)
    }
    await runNode()
    const after1 = ok(await cli(dir, ['flowStateMachine', 'get'], { projectId, nodeId: sm }), 'GET_AFTER1')
    if (after1.state !== 'working' || after1.revision !== 2)
      throw new Error(`ADVANCE1_WRONG:${JSON.stringify(after1)}`)
    check('外部提交 flow.started → 运行推进 working/修订2')

    // ── 3. output.get 投影 out-state（不再 UNSUPPORTED_CONTRACT）──
    const output = ok(await cli(dir, ['output', 'get'], { projectId, nodeId: sm }), 'OUTPUT')
    const outState = output.outputs.find((o) => o.portId === 'out-state')
    if (!outState || outState.kind !== 'json' || outState.json?.state !== 'working' || outState.json?.revision !== 2)
      throw new Error(`OUT_STATE_WRONG:${JSON.stringify(output)}`)
    receipt.outputs.outState = outState
    check('output.get 投影 out-state（working/修订2，flow.state@1）')

    // ── 4. 过期修订拒绝 ──
    const stale = await cli(dir, ['flowStateMachine', 'submitEvent'], {
      projectId, nodeId: sm, event: 'flow.completed', expectedRevision: 1
    })
    if (stale.response?.error?.code !== 'STATE_MACHINE_REVISION_CONFLICT')
      throw new Error(`STALE_NOT_REJECTED:${JSON.stringify(stale.response)}`)
    check('过期修订提交被 STATE_MACHINE_REVISION_CONFLICT 拒绝')

    // ── 5. 非法事件：运行時执行器拒绝（外部不能直接改状态）──
    ok(await cli(dir, ['flowStateMachine', 'submitEvent'], {
      projectId, nodeId: sm, event: 'flow.completed', expectedRevision: 2
    }), 'SUBMIT_2')
    await runNode()
    const after2 = ok(await cli(dir, ['flowStateMachine', 'get'], { projectId, nodeId: sm }), 'GET_AFTER2')
    if (after2.state !== 'completed' || after2.revision !== 3)
      throw new Error(`ADVANCE2_WRONG:${JSON.stringify(after2)}`)
    check('提交 flow.completed → 运行推进 completed/修订3')

    // ── 6. MCP 工具目录与调用一致 ──
    const transport = new StdioClientTransport({
      command: require('electron'),
      args: [path.join(root, 'out/main/local-agent.js'), 'mcp', 'serve', '--stdio', '--data-dir', dir],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe'
    })
    const mcp = new Client({ name: 'c3-statemachine', version: '1.0.0' }, { capabilities: {} })
    await mcp.connect(transport)
    try {
      const tools = await mcp.listTools()
      for (const name of ['flowStateMachine_submitEvent', 'flowStateMachine_get']) {
        if (!tools.tools.some((t) => t.name === name)) throw new Error(`MCP_TOOL_MISSING:${name}`)
      }
      const res = await mcp.callTool({
        name: 'flowStateMachine_get',
        arguments: { input: { projectId, nodeId: sm } }
      })
      if (res.structuredContent?.status !== 'completed' || res.structuredContent?.data?.state !== 'completed')
        throw new Error(`MCP_GET_WRONG:${JSON.stringify(res.structuredContent)}`)
      check('MCP flowStateMachine_get/submitEvent 工具存在且读取一致')
    } finally {
      await mcp.close().catch(() => undefined)
    }

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