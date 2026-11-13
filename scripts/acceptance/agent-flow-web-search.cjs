/* eslint-disable */
// C2 受控联网搜索端到端冒烟：specialist 启用 web.search@1，真实豆包搜索（免费额度）。
// 决策模型用智谱（CANVAS_TEST_API_KEY）；搜索 key 经 CANVAS_DOUBAO_SEARCH_KEY（不进仓库/日志）。
// 搜索连接 id=doubao-search（legacy provider，baseUrl=https://open.feedcoopapi.com）。
// 前置：CANVAS_OWNER=1 构建。运行：node scripts/acceptance/agent-flow-web-search.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-web-search')
const MODEL_ID = process.env.CANVAS_TEST_MODEL || 'glm-5.3-flash'
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
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 700)}`)
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
  if (!process.env.CANVAS_TEST_API_KEY) throw new Error('CANVAS_TEST_API_KEY_MISSING')
  if (!process.env.CANVAS_DOUBAO_SEARCH_KEY) throw new Error('CANVAS_DOUBAO_SEARCH_KEY_MISSING')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-web-search-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { mode: 'real-search (doubao free quota) + real decision model', model: MODEL_ID, checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const assert = (cond, label) => { if (!cond) throw new Error(`ASSERT_FAILED:${label}`); check(label) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] C2 受控联网搜索')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    // 搜索专用连接（legacy provider，无需模型验证）：真实豆包端点 + 独立搜索 key。
    ok(await cli(dir, ['provider', 'save'], {
      id: 'doubao-search', name: '豆包搜索', specId: 'openai-compatible',
      baseUrl: 'https://open.feedcoopapi.com', apiKey: process.env.CANVAS_DOUBAO_SEARCH_KEY, models: []
    }), 'SEARCH_PROVIDER_SAVE')
    check('配置豆包搜索连接 doubao-search（真实端点 open.feedcoopapi.com）')

    // 决策模型（智谱）：specialist 单步决策用。
    ok(await cli(dir, ['model', 'connection', 'save'], {
      id: 'zhipu-official', name: '智谱官方', protocol: 'openai-compatible',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: process.env.CANVAS_TEST_API_KEY
    }), 'CONNECTION_SAVE')
    ok(await cli(dir, ['model', 'definition', 'save'], {
      id: 'glm-test-model', connectionId: 'zhipu-official', name: MODEL_ID,
      modelId: MODEL_ID, capabilities: [{ operation: 'text.generate', streaming: true }]
    }), 'DEFINITION_SAVE')
    // specialist 单步决策需强制结构化工具调用能力验证（否则 AGENT_MODEL_TOOL_UNVERIFIED）。
    let toolVerify = null
    for (let attempt = 0; attempt < 4; attempt++) {
      toolVerify = await cli(dir, ['model', 'validateAgentToolCalling'], {
        connectionId: 'zhipu-official', modelDefinitionId: 'glm-test-model',
        confirmNetwork: true, confirmCost: true
      })
      if (toolVerify.response?.status === 'completed' && toolVerify.response?.data?.status === 'verified') break
      if (toolVerify.response?.error?.code === 'OUTCOME_UNKNOWN') { await sleep(6000); continue }
      throw new Error(`MODEL_TOOL_NOT_VERIFIED:${JSON.stringify(toolVerify.response).slice(0, 400)}`)
    }
    if (toolVerify.response?.data?.status !== 'verified') throw new Error('MODEL_TOOL_NOT_VERIFIED')
    let capOk = false
    for (let attempt = 0; attempt < 4 && !capOk; attempt++) {
      const cap = await cli(dir, ['model', 'validate'], {
        connectionId: 'zhipu-official', modelDefinitionId: 'glm-test-model',
        operation: 'text.generate', confirmNetwork: true, confirmCost: true
      })
      if (cap.response?.status === 'completed') capOk = true
      else if (cap.response?.error?.code === 'OUTCOME_UNKNOWN') await sleep(6000)
      else throw new Error(`CAPABILITY_VALIDATE_FAILED:${JSON.stringify(cap.response).slice(0, 300)}`)
    }
    if (!capOk) throw new Error('CAPABILITY_VALIDATE_UNKNOWN')
    ok(await cli(dir, ['model', 'binding', 'save'], {
      featureKey: 'text.process', connectionId: 'zhipu-official',
      modelDefinitionId: 'glm-test-model', operation: 'text.generate'
    }), 'BINDING_SAVE')
    check(`决策模型 ${MODEL_ID} 能力验证 + 绑定`)

    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] C2 联网搜索' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')

    // better-sqlite3 按 Electron ABI：用 Electron-as-Node 子进程查协调台账/资产。
    const queryScript = path.join(root, 'scripts', 'acceptance', 'helpers', 'query-flow-run.cjs')
    const queryDb = () => new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [queryScript, path.join(dir, 'app.db')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      })
      let out = '', err = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (err = (err + c).slice(-500)))
      child.once('error', reject)
      child.once('exit', () => { try { resolve(JSON.parse(out)) } catch { reject(new Error(`DB_QUERY_PARSE:${err || out.slice(0, 300)}`)) } })
    })

    // 状态机 + 主控（分派）+ 资料搜索专家（web.search@1）。搜索在 main 侧执行，专家无需画布目标。
    const batch1 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'sm', nodeType: 'state-machine', title: '流程状态', x: 0, y: 0, config: {
        schemaVersion: 1, initialState: 'draft',
        states: ['draft', 'working', 'waiting', 'completed'],
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
        text: '总体目标：完成一次联网资料搜索。分派资料搜索专家执行搜索任务，专家完成后结束流程。',
        config: { schemaVersion: 1, role: 'coordinator', interactionMode: 'autonomous',
          modelDefinitionId: 'glm-test-model', skills: [],
          tools: [{ id: 'agent.dispatch', version: '1' }],
          allowedNodeIds: [], maxSteps: 12, relations: [] } },
      { action: 'node.create', ref: 's1', nodeType: 'agent', title: '资料搜索专家', x: 880, y: 0,
        text: '第一步必须调用 web_search 工具搜索「人机协作 的定义与优势」。阅读返回的候选材料后，用 finish_task 提交该搜索结果资产引用（out-json）。不要调用 execute_node，不要捏造材料。',
        config: { schemaVersion: 1, role: 'specialist', interactionMode: 'autonomous',
          modelDefinitionId: 'glm-test-model', skills: [],
          tools: [{ id: 'node.execute', version: '1' }, { id: 'web.search', version: '1' }],
          allowedNodeIds: [], maxSteps: 6, relations: [] } },
      { action: 'node.create', ref: 't1', nodeType: 'text', title: '备用整理', x: 1320, y: 0,
        text: '（搜索专家以 web_search 候选材料为准，此节点仅作可分派目标占位。）' }
    ], 'BATCH1')
    const byRef = Object.fromEntries(batch1.created.map((c) => [c.ref, c.nodeId]))
    await patchWithRetry(dir, projectId, [
      { action: 'node.update', nodeId: byRef.coord, config: {
        allowedNodeIds: [byRef.s1],
        relations: [{ relationId: 'obs-1', kind: 'observes', sourceNodeId: byRef.coord, targetNodeId: byRef.sm }]
      } },
      { action: 'node.update', nodeId: byRef.s1, config: { allowedNodeIds: [byRef.t1] } }
    ], 'BATCH2')
    check('建 flow：状态机 + 主控 + 资料搜索专家（启用 web.search@1）')

    await cli(dir, ['flowAgent', 'run'], { projectId, nodeId: byRef.coord, action: 'start' })
    let dbOut = null
    let specialist = null
    for (let i = 0; i < 60; i++) {
      await sleep(2000)
      specialist = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: byRef.s1 })).response?.data?.task
      if (specialist?.state === 'waiting' && specialist?.waitKind === 'reconcile') {
        await cli(dir, ['flowAgent', 'run'], {
          projectId, nodeId: byRef.s1, action: 'reconcile', eventId: randomUUID(),
          expectedTaskId: specialist.taskId, expectedWaitRevision: specialist.waitRevision
        })
        const dbNow = await queryDb().catch(() => null)
        for (const cmd of dbNow?.commands ?? []) {
          if (cmd.state === 'pending' || cmd.state === 'unknown')
            await cli(dir, ['flow', 'command', 'reconcile'], { projectId, commandId: cmd.command_id })
        }
      }
      dbOut = await queryDb().catch(() => null)
      const state = dbOut?.run?.state
      if (state && ['completed', 'failed', 'cancelled'].includes(state)) break
    }
    receipt.outputs.specialist = specialist
    receipt.outputs.coordState = dbOut?.run?.state
    receipt.outputs.coordRun = dbOut?.run
    assert(specialist && specialist.state === 'completed', `搜索专家 completed（实际 ${specialist?.state} / ${specialist?.code}；主控 ${dbOut?.run?.state} / ${dbOut?.run?.code}）`)
    check(`搜索专家 completed（decisions=${specialist.decisions}, tools=${specialist.tools}）`)
    assert(dbOut?.run?.state === 'completed', `主控协调台账 completed（实际 ${dbOut?.run?.state}）`)

    // 搜索候选资产：专家 out-json 固定资产，含真实搜索结果 items。
    const assetRows = dbOut?.assets ?? []
    receipt.outputs.assets = assetRows.map((a) => ({ node_id: a.node_id, port_id: a.port_id }))
    const searchAsset = assetRows.find((a) => a.node_id === byRef.s1 && a.port_id === 'out-json')
    assert(searchAsset, '搜索结果已结算为专家 out-json 固定候选资产')
    const output = ok(await cli(dir, ['output', 'get'], { projectId, nodeId: byRef.s1 }), 'OUTPUT')
    receipt.outputs.rawOutputs = (output.outputs || []).map((o) => ({ portId: o.portId, kind: o.kind, keys: Object.keys(o) }))
    const jsonOut = (output.outputs || []).find((o) => o.portId === 'out-json' && o.kind === 'json')
    const jsonData = jsonOut?.data ?? jsonOut?.value ?? jsonOut?.json
    receipt.outputs.searchResultPreview = JSON.stringify(jsonData ?? null).slice(0, 400)
    assert(jsonData && Array.isArray(jsonData.items), '搜索候选资产含结构化 items（真实搜索结果）')
    assert(jsonData.items.length >= 1, `搜索返回 ${jsonData.items.length} 条真实结果`)
    check(`受控联网搜索端到端通过：${jsonData.items.length} 条真实候选材料（非静默采用，固定引用交付）`)

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