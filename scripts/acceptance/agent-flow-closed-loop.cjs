/* eslint-disable */
// Agent Flow 真实闭环验收（R3）：主控→专家→固定资产→finish→flow.completed。
// 真实模型调用（计费）：前置 CANVAS_TEST_API_KEY 环境变量（智谱密钥，不进仓库/日志）；
// CANVAS_TEST_MODEL 可选（默认 glm-5.3-flash）。构建：$env:CANVAS_OWNER='1'; npx electron-vite build。
// 运行：$env:CANVAS_TEST_API_KEY='<key>'; node scripts/acceptance/agent-flow-closed-loop.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-closed-loop')
const MODEL_ID = process.env.CANVAS_TEST_MODEL || 'glm-5.3-flash'
// 二-1/二-2 验证变体：专家无上游输入（dispatch 空 inputs）+ processor 不带显式配置
// （走新建默认 pass）。缺省变体仍为带输入 + 显式 pass。
const NO_INPUT = process.env.CANVAS_TEST_NO_INPUT === '1'
// C1 验证变体：专家目标节点类型 processor（缺省）/ text（确定性）/ ai-process（真实模型）。
const TARGET = process.env.CANVAS_TEST_TARGET || 'processor'
const TARGET_OUT_PORT = TARGET === 'processor' ? 'out-value' : 'out-text'
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
  if (!process.env.CANVAS_TEST_API_KEY) throw new Error('CANVAS_TEST_API_KEY_MISSING')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-flow-closed-loop-'))
  let app
  let projectId = null
  const receipt = { mode: 'real-model (paid, small)', model: MODEL_ID, target: TARGET, variant: NO_INPUT ? 'no-input-specialist+default-processor' : 'with-input+explicit-config', checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    delete launchEnv.CANVAS_FLOW_DEBUG
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [root, '--local-agent-access'],
      env: launchEnv
    })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] Agent Flow 闭环验收')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    // ── 模型配置（密钥走设备密钥库；validate 为小额计费探针）──
    ok(await cli(dir, ['model', 'connection', 'save'], {
      id: 'zhipu-official', name: '智谱官方', protocol: 'openai-compatible',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: process.env.CANVAS_TEST_API_KEY
    }), 'CONNECTION_SAVE')
    ok(await cli(dir, ['model', 'definition', 'save'], {
      id: 'glm-test-model', connectionId: 'zhipu-official', name: MODEL_ID,
      modelId: MODEL_ID, capabilities: [{ operation: 'text.generate', streaming: true }]
    }), 'DEFINITION_SAVE')
    // 验证探针可能 OUTCOME_UNKNOWN（connect 超时，宿主仍在执行）：等待后重试，最多 4 次。
    let validate = null
    for (let attempt = 0; attempt < 4; attempt++) {
      validate = await cli(dir, ['model', 'validateAgentToolCalling'], {
        connectionId: 'zhipu-official', modelDefinitionId: 'glm-test-model',
        confirmNetwork: true, confirmCost: true
      })
      if (validate.response?.status === 'completed' && validate.response?.data?.status === 'verified') break
      if (validate.response?.error?.code === 'OUTCOME_UNKNOWN') { await sleep(6000); continue }
      throw new Error(`MODEL_NOT_VERIFIED:${JSON.stringify(validate.response).slice(0, 400)}`)
    }
    if (validate.response?.data?.status !== 'verified') throw new Error(`MODEL_NOT_VERIFIED:${JSON.stringify(validate.response).slice(0, 400)}`)
    // C1：ai-process 目标需要 text.process 功能绑定已验证模型。
    if (TARGET === 'ai-process') {
      ok(await cli(dir, ['model', 'validate'], {
        connectionId: 'zhipu-official', modelDefinitionId: 'glm-test-model',
        operation: 'text.generate', confirmNetwork: true, confirmCost: true
      }), 'CAPABILITY_VALIDATE')
      ok(await cli(dir, ['model', 'binding', 'save'], {
        featureKey: 'text.process', connectionId: 'zhipu-official',
        modelDefinitionId: 'glm-test-model', operation: 'text.generate'
      }), 'BINDING_SAVE')
    }
    check(`模型 ${MODEL_ID} 工具调用验证通过（真实探针${TARGET === 'ai-process' ? ' + text.process 绑定' : ''}）`)

    // ── 建 flow：状态机 + 主控 + 专家 + processor（pass）+ 素材源 ──
    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] Agent Flow 闭环' }), 'CREATE')
    projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
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
        text: '总体目标：产出一篇关于 AI 协作的短文。分派写作专家完成初稿，全部完成后结束流程。',
        config: { schemaVersion: 1, role: 'coordinator', interactionMode: 'autonomous',
          modelDefinitionId: 'glm-test-model', skills: [],
          tools: [{ id: 'agent.dispatch', version: '1' }],
          allowedNodeIds: [], maxSteps: 12, relations: [] } },
      { action: 'node.create', ref: 's1', nodeType: 'agent', title: '写作专家', x: 880, y: 0,
        text: '执行初稿节点并交付其固定成果',
        config: { schemaVersion: 1, role: 'specialist', interactionMode: 'autonomous',
          modelDefinitionId: 'glm-test-model', skills: [],
          tools: [{ id: 'node.execute', version: '1' }],
          allowedNodeIds: [], maxSteps: 12, relations: [] } },
      { action: 'node.create', ref: 'p1', nodeType: TARGET, title: '初稿', x: 1320, y: 0,
        ...(TARGET === 'processor'
          ? (NO_INPUT ? {} : { config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } })
          : TARGET === 'text'
            ? { text: '初稿正文：AI 协作让人深度参与创作。' }
            : { config: { mode: 'text', system: '你是写作助手。把素材整理成一段连贯的短文正文，直接输出正文。', temperature: 0.3, maxTokens: 1024 } }) },
      { action: 'node.create', ref: 'src', nodeType: 'text', title: '素材源', x: 440, y: 420,
        text: 'AI 协作素材：人负责判断与取舍，AI 负责生成候选；每一步人都可以编辑、替换或重试。' }
    ], 'BATCH1')
    const byRef = Object.fromEntries(batch1.created.map((c) => [c.ref, c.nodeId]))
    await patchWithRetry(dir, projectId, [
      { action: 'node.update', nodeId: byRef.coord, config: {
        allowedNodeIds: [byRef.s1],
        relations: [{ relationId: 'obs-1', kind: 'observes', sourceNodeId: byRef.coord, targetNodeId: byRef.sm }]
      } },
      { action: 'node.update', nodeId: byRef.s1, config: { allowedNodeIds: [byRef.p1] } },
      // 二-1 变体：不给专家接上游输入（directInputs 为空），dispatch 必须允许空 inputs。
      ...(NO_INPUT ? [] : [{ action: 'edge.create', from: { nodeId: byRef.src, portId: 'out-text' }, to: { nodeId: byRef.s1, portId: 'in-text' } }]),
      { action: 'edge.create', from: { nodeId: byRef.src, portId: 'out-text' }, to: { nodeId: byRef.p1, portId: TARGET === 'processor' ? 'in-value' : 'in-text' } }
    ], 'BATCH2')
    check(`CLI 建 flow（目标=${TARGET}；变体=${NO_INPUT ? '无输入专家+默认processor' : '带输入+显式配置'}）`)

    // ── 素材源先运行，产出固定资产 ──
    const srcGraph = ok(await cli(dir, ['graph', 'get'], { projectId }), 'SRC_GRAPH')
    const srcExec = ok(await cli(dir, ['node', 'execute'], {
      projectId, expectedGraphVersion: srcGraph.graphVersion, nodeIds: [byRef.src], mode: 'single'
    }), 'SRC_EXECUTE')
    const srcWait = ok(await cli(dir, ['run', 'wait'], { projectId, taskId: srcExec.taskId, timeoutMs: 30000 }), 'SRC_WAIT')
    if (srcWait.state !== 'completed') throw new Error(`SRC_NOT_COMPLETED:${JSON.stringify(srcWait)}`)
    check('素材源运行 completed（固定输入资产就绪）')

    // ── 启动主控，轮询协调台账终态（专家 completed 后主控还要做 finish_flow 决策）──
    await cli(dir, ['flowAgent', 'run'], { projectId, nodeId: byRef.coord, action: 'start' })
    // better-sqlite3 按 Electron ABI 编译，用 Electron-as-Node 子进程查库
    // （系统 Node 直接 require 会 NODE_MODULE_VERSION 不匹配）。
    const queryScript = path.join(root, 'scripts', 'acceptance', 'helpers', 'query-flow-run.cjs')
    const queryDb = () => new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [queryScript, path.join(dir, 'app.db')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      let out = '', err = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (err = (err + c).slice(-500)))
      child.once('error', reject)
      child.once('exit', () => {
        try { resolve(JSON.parse(out)) } catch { reject(new Error(`DB_QUERY_PARSE:${err || out.slice(0, 300)}`)) }
      })
    })
    let dbOut = null
    let specialist = null
    for (let i = 0; i < 60; i++) {
      await sleep(2000)
      specialist = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: byRef.s1 })).response?.data?.task
      // 长模型调用可能 OUTCOME_UNKNOWN → reconcile 等待：触发核对后续跑，不盲目重试。
      // reconcile 必须携带观察到的 taskId/waitRevision + 本次事件 eventId（执行层 superRefine）。
      if (specialist?.state === 'waiting' && specialist?.waitKind === 'reconcile') {
        const rec = await cli(dir, ['flowAgent', 'run'], {
          projectId, nodeId: byRef.s1, action: 'reconcile', eventId: randomUUID(),
          expectedTaskId: specialist.taskId, expectedWaitRevision: specialist.waitRevision
        })
        console.log('[reconcile]', JSON.stringify(rec.response).slice(0, 300))
        // 命令级对账：暴露台账稳定原因（宿主 reconcile 静默吞掉 commit 错误）。
        const dbNow = await queryDb().catch(() => null)
        for (const cmd of dbNow?.commands ?? []) {
          if (cmd.state === 'pending' || cmd.state === 'unknown') {
            const cr = await cli(dir, ['flow', 'command', 'reconcile'], { projectId, commandId: cmd.command_id })
            console.log('[cmd.reconcile]', JSON.stringify(cr.response).slice(0, 600))
          }
        }
      }
      dbOut = await queryDb().catch(() => null)
      const state = dbOut?.run?.state
      if (state && ['completed', 'failed', 'cancelled'].includes(state)) break
    }
    receipt.outputs.specialist = specialist
    if (!specialist || specialist.state !== 'completed')
      throw new Error(`SPECIALIST_NOT_COMPLETED:${JSON.stringify(specialist)}`)
    check(`专家 completed（decisions=${specialist.decisions}, tools=${specialist.tools}）`)
    const coordRun = dbOut?.run
    const assetRows = dbOut?.assets ?? []
    if (!coordRun || coordRun.state !== 'completed')
      throw new Error(`COORD_NOT_COMPLETED:${coordRun?.state}:${coordRun?.code ?? ''}`)
    check(`主控协调台账 completed（decisions=${coordRun.decisions}）`)
    if (assetRows.length < 2) throw new Error(`ASSETS_MISSING:${JSON.stringify(assetRows)}`)
    if (!assetRows.some((a) => a.node_id === byRef.p1 && a.port_id === TARGET_OUT_PORT))
      throw new Error(`TARGET_ASSET_MISSING:${JSON.stringify(assetRows)}`)
    receipt.outputs.assets = assetRows
    check(`固定资产提交 ${assetRows.length} 个（含 ${TARGET} ${TARGET_OUT_PORT} 成果）`)

    console.log(JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: true, ...receipt }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    // 失败留档：项目文件与数据库，供离线比对语义修订。
    try {
      if (projectId) {
        const projDir = path.join(dir, 'projects', projectId)
        if (fs.existsSync(projDir)) fs.cpSync(projDir, path.join(evidenceDir, 'project'), { recursive: true })
        for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) {
          if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(evidenceDir, f))
        }
      }
    } catch { /* 留档失败不影响退出码 */ }
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()