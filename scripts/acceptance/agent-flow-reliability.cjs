/* eslint-disable */
// 第三类可靠性验收：多专家+审核真实闭环 / 重启恢复不重复执行 / 人工等待继续。
// 真实模型（计费，小额）：CANVAS_TEST_API_KEY 环境变量；CANVAS_TEST_MODEL 默认 glm-5.3-flash。
// 前置：CANVAS_OWNER=1 构建。运行：node scripts/acceptance/agent-flow-reliability.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-reliability')
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
const queryScript = path.join(root, 'scripts', 'acceptance', 'helpers', 'query-flow-run.cjs')
function queryDb(dir) {
  return new Promise((resolve, reject) => {
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
}
async function launchApp(dir) {
  const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
  delete launchEnv.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
  const page = await app.firstWindow()
  await page.waitForLoadState()
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] Agent Flow 可靠性验收')
  })
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
    await sleep(200)
  }
  if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')
  return app
}
async function setupModel(dir) {
  ok(await cli(dir, ['model', 'connection', 'save'], {
    id: 'zhipu-official', name: '智谱官方', protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: process.env.CANVAS_TEST_API_KEY
  }), 'CONNECTION_SAVE')
  ok(await cli(dir, ['model', 'definition', 'save'], {
    id: 'glm-test-model', connectionId: 'zhipu-official', name: MODEL_ID,
    modelId: MODEL_ID, capabilities: [{ operation: 'text.generate', streaming: true }]
  }), 'DEFINITION_SAVE')
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
  if (validate.response?.data?.status !== 'verified') throw new Error('MODEL_NOT_VERIFIED')
  // 审核/ai-process 走 text.generate 能力验证（与工具调用验证不同）。
  const cap = await cli(dir, ['model', 'validate'], {
    connectionId: 'zhipu-official', modelDefinitionId: 'glm-test-model',
    operation: 'text.generate', confirmNetwork: true, confirmCost: true
  })
  if (cap.response?.error && cap.response?.error?.code !== 'OUTCOME_UNKNOWN')
    throw new Error(`CAPABILITY_VALIDATE_FAILED:${JSON.stringify(cap.response).slice(0, 300)}`)
}
const agent = (role, mode = 'autonomous') => ({
  schemaVersion: 1, role, interactionMode: mode, modelDefinitionId: 'glm-test-model',
  skills: [], tools: [{ id: role === 'coordinator' ? 'agent.dispatch' : 'node.execute', version: '1' }],
  allowedNodeIds: [], maxSteps: 12, relations: []
})
const SM_CONFIG = {
  schemaVersion: 1, initialState: 'draft',
  states: ['draft', 'working', 'waiting', 'completed'],
  transitions: [
    { from: 'draft', event: 'flow.started', to: 'working' },
    // 完整固定事件词汇（含审核/返工系列，与内置构建器一致）。
    ...[
      'agent.dispatched', 'agent.completed',
      'review.started', 'review.passed', 'review.completed', 'review.rejected',
      'rework.created', 'rework.started', 'rework.completed',
      'human.wait', 'flow.paused', 'flow.completed'
    ].map((event) => ({
      from: 'working', event,
      to: event === 'flow.completed' ? 'completed' : ['human.wait', 'flow.paused'].includes(event) ? 'waiting' : 'working'
    })),
    { from: 'waiting', event: 'human.continue', to: 'working' }
  ], relations: []
}
// 轮询协调台账终态；reconcile 等待时触发核对（带 eventId）。
async function pollCoordination(dir, projectId, coordNodeId, specialistIds, timeoutMs = 240000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    await sleep(2500)
    for (const sid of specialistIds) {
      const task = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: sid })).response?.data?.task
      if (task?.state === 'waiting' && task?.waitKind === 'reconcile') {
        await cli(dir, ['flowAgent', 'run'], {
          projectId, nodeId: sid, action: 'reconcile', eventId: randomUUID(),
          expectedTaskId: task.taskId, expectedWaitRevision: task.waitRevision
        })
      }
    }
    const coordTask = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: coordNodeId })).response?.data?.task
    if (coordTask?.state === 'waiting' && coordTask?.waitKind === 'reconcile') {
      await cli(dir, ['flowAgent', 'run'], {
        projectId, nodeId: coordNodeId, action: 'reconcile', eventId: randomUUID(),
        expectedTaskId: coordTask.taskId, expectedWaitRevision: coordTask.waitRevision
      })
    }
    last = await queryDb(dir).catch(() => null)
    const state = last?.run?.state
    if (state && ['completed', 'failed', 'cancelled'].includes(state)) return last
  }
  const children = (last?.run?.children ?? []).map((c) => ({ nodeId: c.nodeId, state: c.state }))
  const reviews = (last?.reviews ?? []).map((rv) => ({ state: rv.state, round: rv.round }))
  throw new Error(`COORDINATION_TIMEOUT:${JSON.stringify({ state: last?.run?.state, code: last?.run?.code, decisions: last?.run?.decisions, children, reviews }).slice(0, 800)}`)
}

;(async () => {
  if (!process.env.CANVAS_TEST_API_KEY) throw new Error('CANVAS_TEST_API_KEY_MISSING')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-reliability-'))
  let app
  const receipt = { mode: 'real-model (paid, small)', model: MODEL_ID, checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  try {
    app = await launchApp(dir)
    await setupModel(dir)
    check(`模型 ${MODEL_ID} 工具调用验证通过`)

    // ══ 阶段 1：多专家 + 审核真实闭环 ══
    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] 可靠性-多专家审核' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    const batch1 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'sm', nodeType: 'state-machine', title: '流程状态', x: 0, y: 0, config: SM_CONFIG },
      { action: 'node.create', ref: 'coord', nodeType: 'agent', title: '主控', x: 440, y: 0,
        text: '总体目标：整理素材产出两段短文。先分派整理专家A，再分派整理专家B，然后对专家B的成果执行审核，审核通过后结束流程。',
        config: { ...agent('coordinator'), tools: [{ id: 'agent.dispatch', version: '1' }, { id: 'review.execute', version: '1' }] } },
      { action: 'node.create', ref: 's1', nodeType: 'agent', title: '整理专家A', x: 880, y: 0, text: '执行成果A节点并交付其固定成果', config: agent('specialist') },
      { action: 'node.create', ref: 's2', nodeType: 'agent', title: '整理专家B', x: 1320, y: 0, text: '执行成果B节点并交付其固定成果', config: agent('specialist') },
      { action: 'node.create', ref: 'p1', nodeType: 'processor', title: '成果A', x: 880, y: 420, config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } },
      { action: 'node.create', ref: 'p2', nodeType: 'processor', title: '成果B', x: 1320, y: 420, config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } },
      { action: 'node.create', ref: 'rev', nodeType: 'ai-review', title: '审核', x: 1760, y: 420,
        text: '审核标准：成果必须忠实整理素材，语句连贯，不得捏造内容。',
        config: { schemaVersion: 1, rulesVersion: 'reliability-v1', reviewMode: 'text-json',
          modelDefinitionId: 'glm-test-model', rejectPolicy: 'rework', maxReworks: 2,
          responsibleNodeId: '', subjectSources: [], gatedNodeIds: [], relations: [] } },
      { action: 'node.create', ref: 'src', nodeType: 'text', title: '素材源', x: 0, y: 420,
        text: 'AI 协作素材：人负责判断与取舍，AI 负责生成候选；每一步人都可以编辑、替换或重试。' }
    ], 'BATCH1')
    const r = Object.fromEntries(batch1.created.map((c) => [c.ref, c.nodeId]))
    await patchWithRetry(dir, projectId, [
      { action: 'node.update', nodeId: r.coord, config: {
        allowedNodeIds: [r.s1, r.s2, r.rev],
        relations: [{ relationId: 'obs-1', kind: 'observes', sourceNodeId: r.coord, targetNodeId: r.sm }]
      } },
      { action: 'node.update', nodeId: r.s1, config: { allowedNodeIds: [r.p1] } },
      { action: 'node.update', nodeId: r.s2, config: { allowedNodeIds: [r.p2] } },
      { action: 'node.update', nodeId: r.rev, config: {
        responsibleNodeId: r.s2,
        subjectSources: [{ nodeId: r.s2, portId: 'out-text' }],
        gatedNodeIds: []
      } },
      { action: 'edge.create', from: { nodeId: r.src, portId: 'out-text' }, to: { nodeId: r.s1, portId: 'in-text' } },
      { action: 'edge.create', from: { nodeId: r.src, portId: 'out-text' }, to: { nodeId: r.s2, portId: 'in-text' } },
      { action: 'edge.create', from: { nodeId: r.src, portId: 'out-text' }, to: { nodeId: r.p1, portId: 'in-value' } },
      { action: 'edge.create', from: { nodeId: r.src, portId: 'out-text' }, to: { nodeId: r.p2, portId: 'in-value' } },
      // 审核主体连线：专家B 的 out-text → 审核 in-text（reviewBinding 要求真实边）。
      { action: 'edge.create', from: { nodeId: r.s2, portId: 'out-text' }, to: { nodeId: r.rev, portId: 'in-text' } }
    ], 'BATCH2')
    const srcGraph = ok(await cli(dir, ['graph', 'get'], { projectId }), 'SRC_GRAPH')
    const srcExec = ok(await cli(dir, ['node', 'execute'], {
      projectId, expectedGraphVersion: srcGraph.graphVersion, nodeIds: [r.src], mode: 'single'
    }), 'SRC_EXECUTE')
    ok(await cli(dir, ['run', 'wait'], { projectId, taskId: srcExec.taskId, timeoutMs: 30000 }), 'SRC_WAIT')
    check('建 2 专家 + 审核 flow，素材源运行 completed')

    await cli(dir, ['flowAgent', 'run'], { projectId, nodeId: r.coord, action: 'start' })
    const final = await pollCoordination(dir, projectId, r.coord, [r.s1, r.s2])
    if (final.run.state !== 'completed')
      throw new Error(`REVIEW_FLOW_NOT_COMPLETED:${JSON.stringify(final.run).slice(0, 500)}`)
    const s1Task = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: r.s1 })).response?.data?.task
    const s2Task = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: r.s2 })).response?.data?.task
    if (s1Task?.state !== 'completed' || s2Task?.state !== 'completed')
      throw new Error(`SPECIALISTS_NOT_COMPLETED:${JSON.stringify({ s1Task, s2Task })}`)
    if (final.assets.length < 3) throw new Error(`ASSETS_MISSING:${JSON.stringify(final.assets)}`)
    receipt.outputs.reviewFlow = { coord: final.run.state, assets: final.assets.length, s1: s1Task.state, s2: s2Task.state }
    check(`多专家+审核真实闭环 completed（2 专家 completed，资产 ${final.assets.length} 个）`)

    // ══ 阶段 2：重启恢复——关闭应用重开，台账/资产持久化，restore 不重复执行 ══
    const assetsBefore = final.assets.length
    const decisionsBefore = final.run.decisions
    await app.close()
    app = await launchApp(dir)
    ok(await cli(dir, ['project', 'open'], { projectId }), 'REOPEN')
    const coordAfterRestart = (await cli(dir, ['flowAgent', 'inspect'], { projectId, nodeId: r.coord })).response?.data
    const dbAfterRestart = await queryDb(dir)
    if (dbAfterRestart.run?.state !== 'completed' || dbAfterRestart.assets.length !== assetsBefore)
      throw new Error(`RESTART_PERSISTENCE_LOST:${JSON.stringify({ run: dbAfterRestart.run?.state, assets: dbAfterRestart.assets.length })}`)
    const restore = await cli(dir, ['flowAgent', 'run'], {
      projectId, nodeId: r.coord, action: 'restore', eventId: randomUUID(),
      expectedTaskId: final.run.taskId, expectedWaitRevision: coordAfterRestart?.task?.waitRevision ?? 0
    })
    const dbAfterRestore = await queryDb(dir)
    if (dbAfterRestore.assets.length !== assetsBefore || dbAfterRestore.run?.decisions !== decisionsBefore)
      throw new Error(`RESTORE_REEXECUTED:${JSON.stringify({ assets: dbAfterRestore.assets.length, decisions: dbAfterRestore.run?.decisions })}`)
    receipt.outputs.restart = { assetsBefore, assetsAfter: dbAfterRestore.assets.length, decisionsBefore, decisionsAfter: dbAfterRestore.run?.decisions, restoreStatus: restore.response?.status }
    check(`重启恢复：台账/资产持久化，restore 不重复执行（资产 ${assetsBefore}→${dbAfterRestore.assets.length}，决策 ${decisionsBefore}→${dbAfterRestore.run?.decisions}）`)

    // ══ 阶段 3：人工等待/继续（协作模式专家）══
    const created2 = ok(await cli(dir, ['project', 'create'], { name: '[TEST] 可靠性-人工协作' }), 'CREATE2')
    const pid2 = created2.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId: pid2 }), 'OPEN2')
    const b1 = await patchWithRetry(dir, pid2, [
      { action: 'node.create', ref: 'cs', nodeType: 'agent', title: '协作专家', x: 100, y: 100,
        text: '执行成果节点，完成后等待人工确认再交付。', config: agent('specialist', 'collaborative') },
      { action: 'node.create', ref: 'cp', nodeType: 'processor', title: '协作成果', x: 540, y: 100,
        config: { operation: 'pass', valueType: 'any', fallback: '', path: '', template: '' } },
      { action: 'node.create', ref: 'csrc', nodeType: 'text', title: '协作素材', x: 100, y: 520,
        text: '人工协作素材：AI 出候选，人终审。' }
    ], 'COLLAB_BATCH1')
    const cr = Object.fromEntries(b1.created.map((c) => [c.ref, c.nodeId]))
    await patchWithRetry(dir, pid2, [
      { action: 'node.update', nodeId: cr.cs, config: { allowedNodeIds: [cr.cp] } },
      { action: 'edge.create', from: { nodeId: cr.csrc, portId: 'out-text' }, to: { nodeId: cr.cs, portId: 'in-text' } },
      { action: 'edge.create', from: { nodeId: cr.csrc, portId: 'out-text' }, to: { nodeId: cr.cp, portId: 'in-value' } }
    ], 'COLLAB_BATCH2')
    const cg = ok(await cli(dir, ['graph', 'get'], { projectId: pid2 }), 'COLLAB_GRAPH')
    const cexec = ok(await cli(dir, ['node', 'execute'], {
      projectId: pid2, expectedGraphVersion: cg.graphVersion, nodeIds: [cr.csrc], mode: 'single'
    }), 'COLLAB_SRC_EXECUTE')
    ok(await cli(dir, ['run', 'wait'], { projectId: pid2, taskId: cexec.taskId, timeoutMs: 30000 }), 'COLLAB_SRC_WAIT')
    await cli(dir, ['flowAgent', 'run'], { projectId: pid2, nodeId: cr.cs, action: 'start' })
    let humanTask = null
    for (let i = 0; i < 40; i++) {
      await sleep(2500)
      humanTask = (await cli(dir, ['flowAgent', 'inspect'], { projectId: pid2, nodeId: cr.cs })).response?.data?.task
      if (humanTask?.state === 'waiting' && humanTask?.waitKind === 'reconcile') {
        await cli(dir, ['flowAgent', 'run'], {
          projectId: pid2, nodeId: cr.cs, action: 'reconcile', eventId: randomUUID(),
          expectedTaskId: humanTask.taskId, expectedWaitRevision: humanTask.waitRevision
        })
      }
      if (humanTask?.state === 'waiting' && humanTask?.waitKind === 'human') break
      if (humanTask?.state === 'completed' || humanTask?.state === 'blocked') break
    }
    if (humanTask?.state !== 'waiting' || humanTask?.waitKind !== 'human')
      throw new Error(`HUMAN_WAIT_NOT_REACHED:${JSON.stringify(humanTask)}`)
    check('协作专家执行后进入人工等待（waitKind=human）')
    const cont = await cli(dir, ['flowAgent', 'run'], {
      projectId: pid2, nodeId: cr.cs, action: 'continue', eventId: randomUUID(),
      expectedTaskId: humanTask.taskId, expectedWaitRevision: humanTask.waitRevision
    })
    if (cont.response?.error) throw new Error(`CONTINUE_FAILED:${JSON.stringify(cont.response).slice(0, 400)}`)
    let completedTask = null
    for (let i = 0; i < 30; i++) {
      await sleep(2500)
      completedTask = (await cli(dir, ['flowAgent', 'inspect'], { projectId: pid2, nodeId: cr.cs })).response?.data?.task
      if (completedTask?.state === 'waiting' && completedTask?.waitKind === 'reconcile') {
        await cli(dir, ['flowAgent', 'run'], {
          projectId: pid2, nodeId: cr.cs, action: 'reconcile', eventId: randomUUID(),
          expectedTaskId: completedTask.taskId, expectedWaitRevision: completedTask.waitRevision
        })
      }
      if (completedTask?.state === 'completed' || completedTask?.state === 'blocked') break
    }
    if (completedTask?.state !== 'completed')
      throw new Error(`HUMAN_CONTINUE_NOT_COMPLETED:${JSON.stringify(completedTask)}`)
    check('人工 continue 后专家 completed（人工纠偏通道可用）')

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