/* eslint-disable */
// C4 纯人工任务节点桌面级验收（无需真实模型/计费）：
// 停等语义 + 外部 humanTask.submit/get（与 GUI 同一 pending 写入）+ 修订防过期 + composite fail-closed。
// 前置：CANVAS_OWNER=1 构建。运行：node scripts/acceptance/agent-flow-human-task.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-human-task')
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
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
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
async function runNode(dir, projectId, nodeId) {
  const g = ok(await cli(dir, ['graph', 'get'], { projectId }), 'RUN_GRAPH')
  const exec = ok(await cli(dir, ['node', 'execute'], {
    projectId, expectedGraphVersion: g.graphVersion, nodeIds: [nodeId], mode: 'single'
  }), 'EXECUTE')
  let waited = null
  for (let i = 0; i < 10; i++) {
    waited = ok(await cli(dir, ['run', 'wait'], { projectId, taskId: exec.taskId, timeoutMs: 30000 }), 'WAIT')
    if (waited.state === 'completed' || waited.state === 'failed') break
    await sleep(1500)
  }
  return waited
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-human-task-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { mode: 'deterministic (no model, no billing)', checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const assert = (cond, label) => { if (!cond) throw new Error(`ASSERT_FAILED:${label}`); check(label) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] C4 人工任务节点')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] C4 人工任务' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    const batch = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'h1', nodeType: 'human-task', title: '人工审核', x: 200, y: 100,
        config: { schemaVersion: 1, outputType: 'text', instructions: '请人工填写审核结论。' } }
    ], 'BATCH')
    const h1 = Object.fromEntries(batch.created.map((c) => [c.ref, c.nodeId])).h1
    check('创建 human-task 一等节点（text 输出）')

    // 停等：未提交先运行 → 节点跳过，不伪造完成。
    await runNode(dir, projectId, h1)
    let view = ok(await cli(dir, ['humanTask', 'get'], { projectId, nodeId: h1 }), 'GET1')
    receipt.outputs.beforeSubmit = view
    assert(view.status === 'pending' && view.revision === 1, `未提交停等（status=${view.status}, revision=${view.revision}）`)
    const out0 = ok(await cli(dir, ['output', 'get'], { projectId, nodeId: h1 }), 'OUT0')
    assert(!(out0.outputs || []).some((o) => o.portId === 'out-text'), '未提交不产生公开输出（不伪造成功）')

    // 外部提交（与 GUI 同一 pending 写入）→ 运行 → 正式交付。
    // BL-01：外部提交会先弹人工确认，必须由人在窗口里点「允许提交」；这里扮演人。
    // 客户端按交互式操作等待（shared/agent-access/interactive），不会 15s 就报 OUTCOME_UNKNOWN。
    const submitPending = cli(dir, ['humanTask', 'submit'], {
      projectId, nodeId: h1, expectedRevision: 1, value: { kind: 'text', text: '人工审核结论：通过。' }
    })
    await page.getByRole('button', { name: '允许提交' }).click({ timeout: 60000 })
    const sub = ok(await submitPending, 'SUBMIT')
    assert(sub.pending === true, '外部提交写入待处理（pending=true）')
    await runNode(dir, projectId, h1)
    view = ok(await cli(dir, ['humanTask', 'get'], { projectId, nodeId: h1 }), 'GET2')
    receipt.outputs.afterSubmit = view
    assert(view.status === 'completed' && view.revision === 2, `提交后运行完成（status=${view.status}, revision=${view.revision}）`)
    const out1 = ok(await cli(dir, ['output', 'get'], { projectId, nodeId: h1 }), 'OUT1')
    const textOut = (out1.outputs || []).find((o) => o.portId === 'out-text' && o.kind === 'text')
    receipt.outputs.deliveredText = textOut?.text
    assert(textOut && textOut.text === '人工审核结论：通过。', '公开 out-text 投影人工交付结果')

    // 修订防过期：基于旧修订 1 的提交被拒绝。
    // 人工决定先于修订判定，所以这里也要人点一次「允许提交」；拒绝后不产生任何写入。
    const stalePending = cli(dir, ['humanTask', 'submit'], {
      projectId, nodeId: h1, expectedRevision: 1, value: { kind: 'text', text: '过期提交' }
    })
    await page.getByRole('button', { name: '允许提交' }).click({ timeout: 60000 })
    const stale = await stalePending
    assert(stale.response?.error?.code === 'HUMAN_TASK_REVISION_CONFLICT', `过期修订提交拒绝（${stale.response?.error?.code}）`)

    // composite fail-closed：内部 human-task 显式拒绝（隔离执行无人工通道）。
    const manifest = {
      schemaVersion: 1, runtimeVersion: 2, capabilityId: 'human-flow', version: '1.0', name: '含人工节点流',
      inputs: [], outputs: [{ id: 'res', label: '结果', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'hn1', portId: 'out-text' } }],
      graph: { nodes: [{ id: 'hn1', nodeType: 'human-task', contractVersion: 1, title: '人工', dx: 0, dy: 0, w: 340, h: 300,
        config: JSON.stringify({ schemaVersion: 1, outputType: 'text' }),
        ports: [
          { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
          { id: 'in-json', name: 'JSON', dir: 'in', type: 'json', required: false, cardinality: 'one', schemaRef: { id: 'json.any', version: 1 } },
          { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: false, cardinality: 'one' },
          { id: 'out-json', name: 'JSON', dir: 'out', type: 'json', required: false, cardinality: 'one', schemaRef: { id: 'json.any', version: 1 } }
        ] }], edges: [] },
      dependencies: [{ kind: 'node', id: 'human-task', contractVersion: 1 }],
      executionPolicy: { timeoutMs: 60000, maxDepth: 5, maxExpandedNodes: 40, maxExpandedEdges: 120, waitForInput: true }
    }
    const validation = await cli(dir, ['composite', 'validate'], { manifest })
    if (validation.response?.data?.ok !== true)
      throw new Error(`MANIFEST_INVALID:${JSON.stringify(validation.response?.data ?? validation.response).slice(0, 500)}`)
    ok(await cli(dir, ['composite', 'publish'], { manifest }), 'PUBLISH')
    const batch2 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'inst', nodeType: 'composite', title: '含人工节点流', x: 600, y: 100,
        config: { capabilityId: 'human-flow', version: '1.0' } }
    ], 'BATCH2')
    const inst = Object.fromEntries(batch2.created.map((c) => [c.ref, c.nodeId])).inst
    // AF-07（2026-11-13 起）：节点流内部的人工任务不再 fail-closed，而是停在人工等待；
    // 运行记录保持 waiting-input，由人工提交 + 续跑消费。
    // 注意：外部 node-run 状态枚举没有 waiting，节点执行按暂停记账并透出等待原因
    // （与纯 human-task 停等同一口径），真相以 composite.run.get 的 waiting-input 为准。
    const waited = await runNode(dir, projectId, inst)
    assert(waited.state === 'failed', `节点流停在人工等待（运行 ${waited.state}）`)
    assert(
      String(waited.error ?? '').includes('等待人工任务'),
      `等待原因可读（${waited.error}）`
    )
    const runs = ok(await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 5 }), 'RUN_LIST')
    const runId = runs[0].id
    let detail = ok(await cli(dir, ['composite', 'run', 'get'], { runId }), 'RUN_GET')
    assert(detail.run.status === 'waiting-input', `等待人工（status=${detail.run.status}）`)
    assert(detail.run.errorCode === null, `等待不是失败（code=${detail.run.errorCode}）`)
    const submittedHuman = ok(await cli(dir, ['composite', 'run', 'submitHuman'], {
      runId, nodeId: 'hn1', value: { kind: 'text', text: '人工审核结论：通过。' }
    }), 'SUBMIT_HUMAN')
    assert(submittedHuman.satisfied === true, '人工提交满足开放等待')
    ok(await cli(dir, ['composite', 'run', 'resume'], { runId }), 'RESUME')
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      detail = ok(await cli(dir, ['composite', 'run', 'get'], { runId }), 'RUN_GET_FINAL')
      if (detail.run.status === 'completed' || detail.run.status === 'failed') break
    }
    receipt.outputs.compositeResume = {
      status: detail.run.status,
      steps: detail.steps.map((step) => ({ key: step.stepKey, status: step.status })),
      output: detail.run.outputValues?.res ?? null
    }
    assert(detail.run.status === 'completed', `续跑完成（status=${detail.run.status}）`)
    const resumedText = detail.run.outputValues?.res
    assert(
      resumedText?.kind === 'text' && resumedText.text === '人工审核结论：通过。',
      '续跑把人工提交消费为正式公开输出'
    )
    assert(
      detail.steps.some((step) => step.stepKey === 'hn1' && step.status === 'completed'),
      '内部人工步骤记为完成'
    )

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