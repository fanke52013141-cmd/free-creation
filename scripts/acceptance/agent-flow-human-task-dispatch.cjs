/* eslint-disable */
// C4 人工任务调度目标端到端验收：主控分派专家 → 专家执行 human-task 停等（skipped 回执）
// → wait_for_human → 人工经 humanTask.submit 提交 → continue → 再执行消费 pending → committed 交付。
// 决策模型用智谱（CANVAS_TEST_API_KEY，小额计费已授权）。前置：CANVAS_OWNER=1 构建。
// 运行：node scripts/acceptance/agent-flow-human-task-dispatch.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-human-task-dispatch')
const MODEL_ID = process.env.CANVAS_TEST_MODEL || 'glm-5.3-flash'
const HUMAN_RESULT = '人工审核结论：稿件事实准确、表述清晰，同意发布。'
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-ht-dispatch-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  await fsp.mkdir(evidenceDir, { recursive: true })
  let app
  let projectId = null
  const receipt = { mode: 'real decision model + human-task dispatch target', model: MODEL_ID, checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const assert = (cond, label) => { if (!cond) throw new Error(`ASSERT_FAILED:${label}`); check(label) }
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
  // 长模型调用 OUTCOME_UNKNOWN → reconcile 等待：触发核对后续跑。
  const reconcileIfNeeded = async (nodeId, task) => {
    if (task?.state === 'waiting' && task?.waitKind === 'reconcile') {
      await cli(dir, ['flowAgent', 'run'], {
        projectId, nodeId, action: 'reconcile', eventId: randomUUID(),
        expectedTaskId: task.taskId, expectedWaitRevision: task.waitRevision
      })
    }
  }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    // ── 模型配置 + 工具调用验证 ──
    ok(await cli(dir, ['model', 'connection', 'save'], {
      id: 'zhipu-official', name: '智谱官方', protocol: 'openai-compatible',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: process.env.CANVAS_TEST_API_KEY
    }), 'CONNECTION_SAVE')
    ok(await cli(dir, ['model', 'definition', 'save'], {
      id: 'glm-test-model', connectionId: 'zhipu-official', name: MODEL_ID,
      modelId: MODEL_ID, capabilities: [{ operation: 'text.generate', streaming: true }]
    }), 'DEFINITION_SAVE')
    let toolVerify = null
    for (let attempt = 0; attempt < 4; attempt++) {
      toolVerify = await cli(dir, ['model', 'validateAgentToolCalling'], {
        connectionId: 'zhipu-official', modelDefinitionId: 'glm-test-model',
        confirmNetwork: true, confirmCost: true
      })
      if (toolVerify.response?.data?.status === 'verified') break
      await sleep(2000)
    }
    if (toolVerify.response?.data?.status !== 'verified')
      throw new Error(`TOOL_VERIFY_FAILED:${JSON.stringify(toolVerify.response).slice(0, 400)}`)
    check(`模型 ${MODEL_ID} 工具调用验证通过`)

    // ── 建 flow：状态机 + 主控 + 专家 + human-task 目标（无上游输入，二-1 空 inputs 分派）──
    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] C4 人工任务调度' }), 'CREATE')
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
          { from: 'waiting', event: 'human.continue', to: 'working' },
          { from: 'waiting', event: 'agent.completed', to: 'working' },
          { from: 'waiting', event: 'flow.completed', to: 'completed' }
        ], relations: []
      } },
      { action: 'node.create', ref: 'coord', nodeType: 'agent', title: '主控', x: 440, y: 0,
        text: '总体目标：让人工审核专家完成人工任务节点的审核交付。分派专家后等待其完成，全部完成后结束流程。',
        config: { schemaVersion: 1, role: 'coordinator', interactionMode: 'autonomous',
          modelDefinitionId: 'glm-test-model', skills: [],
          tools: [{ id: 'agent.dispatch', version: '1' }],
          allowedNodeIds: [], maxSteps: 12, relations: [] } },
      { action: 'node.create', ref: 's1', nodeType: 'agent', title: '人工审核专家', x: 880, y: 0,
        text: '你的目标是交付人工任务节点的审核结果。步骤：1) 用 execute_node 执行目标节点一次；2) 若回执为 skipped（等待人工提交），用 wait_for_human 等待人工；3) 人工继续后再次 execute_node 执行同一目标节点（此时人工结果已提交，会成功）；4) 用 finish_task 交付该次执行回执中的固定输出引用。不要重复执行未提交的目标节点。',
        config: { schemaVersion: 1, role: 'specialist', interactionMode: 'collaborative',
          modelDefinitionId: 'glm-test-model', skills: [],
          tools: [{ id: 'node.execute', version: '1' }],
          allowedNodeIds: [], maxSteps: 14, relations: [] } },
      { action: 'node.create', ref: 'ht', nodeType: 'human-task', title: '人工审核', x: 1320, y: 0,
        config: { schemaVersion: 1, outputType: 'text', instructions: '请审核稿件并填写审核结论后提交。' } }
    ], 'BATCH1')
    const byRef = Object.fromEntries(batch1.created.map((c) => [c.ref, c.nodeId]))
    await patchWithRetry(dir, projectId, [
      { action: 'node.update', nodeId: byRef.coord, config: {
        allowedNodeIds: [byRef.s1],
        relations: [{ relationId: 'obs-1', kind: 'observes', sourceNodeId: byRef.coord, targetNodeId: byRef.sm }]
      } },
      { action: 'node.update', nodeId: byRef.s1, config: { allowedNodeIds: [byRef.ht] } }
    ], 'BATCH2')
    check('CLI 建 flow（human-task 调度目标，无上游输入）')

    // ── 启动主控，轮询专家进入人工等待 ──
    await cli(dir, ['flowAgent', 'run'], { projectId, nodeId: byRef.coord, action: 'start' })
    let specialist = null
    for (let i = 0; i < 60; i++) {
      await sleep(2500)
      specialist = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: byRef.s1 })).response?.data?.task
      await reconcileIfNeeded(byRef.s1, specialist)
      const coordTask = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: byRef.coord })).response?.data?.task
      await reconcileIfNeeded(byRef.coord, coordTask)
      if (specialist?.state === 'waiting' && specialist?.waitKind === 'human') break
      if (specialist?.state === 'completed' || specialist?.state === 'blocked') break
    }
    receipt.outputs.specialistAtWait = specialist
    if (specialist?.state !== 'waiting' || specialist?.waitKind !== 'human')
      throw new Error(`HUMAN_WAIT_NOT_REACHED:${JSON.stringify(specialist)}`)
    check('专家执行 human-task 后进入人工等待（skipped 停等语义，未伪造成功）')

    // ── 人工提交（外部 op，与 GUI 同一 pending 写入）──
    const htState = ok(await cli(dir, ['humanTask', 'get'], { projectId, nodeId: byRef.ht }), 'HT_GET')
    const revision = htState.instance?.revision ?? htState.revision ?? 1
    ok(await cli(dir, ['humanTask', 'submit'], {
      projectId, nodeId: byRef.ht, expectedRevision: revision,
      value: { kind: 'text', text: HUMAN_RESULT }
    }), 'HT_SUBMIT')
    check(`人工经 humanTask.submit 提交结果（修订 ${revision}）`)

    // ── 继续专家：再执行消费 pending → committed → finish_task ──
    const cont = await cli(dir, ['flowAgent', 'run'], {
      projectId, nodeId: byRef.s1, action: 'continue', eventId: randomUUID(),
      expectedTaskId: specialist.taskId, expectedWaitRevision: specialist.waitRevision
    })
    if (cont.response?.error) throw new Error(`CONTINUE_FAILED:${JSON.stringify(cont.response).slice(0, 400)}`)
    let dbOut = null
    let lastCoordContinueRevision = -1
    for (let i = 0; i < 60; i++) {
      await sleep(2500)
      specialist = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: byRef.s1 })).response?.data?.task
      await reconcileIfNeeded(byRef.s1, specialist)
      const coordTask = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: byRef.coord })).response?.data?.task
      if (i % 5 === 0) console.log('[coord.inspect]', JSON.stringify(coordTask)?.slice(0, 250))
      await reconcileIfNeeded(byRef.coord, coordTask)
      // 主控 waiting（视图 waitKind=human）需 continue 唤醒：唤醒时核对子任务完成态再决策 finish_flow。
      if (
        coordTask?.state === 'waiting' &&
        coordTask?.waitKind !== 'reconcile' &&
        coordTask?.waitRevision !== lastCoordContinueRevision
      ) {
        lastCoordContinueRevision = coordTask.waitRevision
        const wake = await cli(dir, ['flowAgent', 'run'], {
          projectId, nodeId: byRef.coord, action: 'continue', eventId: randomUUID(),
          expectedTaskId: coordTask.taskId, expectedWaitRevision: coordTask.waitRevision
        })
        console.log('[coord.continue]', JSON.stringify(wake.response).slice(0, 200))
      }
      dbOut = await queryDb().catch(() => null)
      const state = dbOut?.run?.state
      if (state && ['completed', 'failed', 'cancelled'].includes(state)) break
    }
    receipt.outputs.specialist = specialist
    if (!specialist || specialist.state !== 'completed')
      throw new Error(`SPECIALIST_NOT_COMPLETED:${JSON.stringify(specialist)} db=${JSON.stringify(dbOut?.run ?? {}).slice(0, 300)}`)
    check(`专家 completed（decisions=${specialist.decisions}, tools=${specialist.tools}）`)

    // ── 断言：人工结果结算为 human-task out-text 固定资产 ──
    const htAssets = (dbOut?.assets ?? []).filter((a) => a.node_id === byRef.ht)
    assert(htAssets.length > 0, `human-task 产出固定资产（${htAssets.length} 项）`)
    const htAfter = ok(await cli(dir, ['humanTask', 'get'], { projectId, nodeId: byRef.ht }), 'HT_GET_AFTER')
    const delivered = htAfter.instance?.result?.text ?? htAfter.result?.text ?? ''
    assert(delivered === HUMAN_RESULT, '交付内容与人工提交一致（执行器权威消费 pending）')
    assert(dbOut?.run?.state === 'completed', '主控协调台账 completed（finish_flow）')
    receipt.outputs.assets = htAssets
    receipt.outputs.deliveredText = delivered
    fs.writeFileSync(path.join(evidenceDir, 'db-out.json'), JSON.stringify(dbOut, null, 2))
    receipt.ok = true
  } catch (error) {
    receipt.ok = false
    receipt.error = String(error?.stack || error).slice(0, 2000)
    if (projectId) {
      await fsp.cp(path.join(dir, 'app.db'), path.join(evidenceDir, 'app.db')).catch(() => {})
      for (const suffix of ['-wal', '-shm'])
        await fsp.cp(path.join(dir, 'app.db' + suffix), path.join(evidenceDir, 'app.db' + suffix)).catch(() => {})
    }
  } finally {
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    if (app) await app.close().catch(() => {})
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  console.log(receipt.ok ? 'ACCEPTANCE OK' : 'ACCEPTANCE FAILED')
  process.exit(receipt.ok ? 0 : 1)
})()