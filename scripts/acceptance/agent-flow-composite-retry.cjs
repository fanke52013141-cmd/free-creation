/* eslint-disable */
// W4 受控重试 + 人工补交验收：headless 组合确定性失败（无模型绑定、无计费）。
// 断言：原输入落盘可重试、重试链根计数与上限 3、补交全量端口校验、
//       completed 但 manualSubmission=true 如实标记、终态守卫（不可重复补交/重试）。
// 前置：CANVAS_OWNER=1 构建。运行：node scripts/acceptance/agent-flow-composite-retry.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-composite-retry')
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
const errCode = (res) => res.response?.error?.code ?? null

function compositeManifest() {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'retry-polish',
    version: '1.0',
    name: '受控重试整理',
    inputs: [
      { id: 'raw', label: '原文', type: 'text', required: true, cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }] }
    ],
    outputs: [
      { id: 'polished', label: '整理结果', type: 'text', required: true, cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-text' } }
    ],
    graph: {
      nodes: [
        { id: 'n1', nodeType: 'ai-process', contractVersion: 1, title: 'AI 整理',
          dx: 0, dy: 0, w: 340, h: 300,
          config: JSON.stringify({ mode: 'text', system: '整理输入。', temperature: 0.3, maxTokens: 256 }),
          ports: [
            { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
            { id: 'in-json', name: 'JSON 上下文', dir: 'in', type: 'json', required: false, cardinality: 'one', schemaRef: { id: 'json.any', version: 1 } },
            { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: false, cardinality: 'one' },
            { id: 'out-markdown', name: 'Markdown', dir: 'out', type: 'markdown', required: false, cardinality: 'one' },
            { id: 'out-json', name: 'JSON', dir: 'out', type: 'json', required: false, cardinality: 'one', schemaRef: { id: 'json.any', version: 1 } }
          ] }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'ai-process', contractVersion: 1 }],
    executionPolicy: { timeoutMs: 120000, maxDepth: 5, maxExpandedNodes: 40, maxExpandedEdges: 120, waitForInput: true }
  }
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-composite-retry-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  await fsp.mkdir(evidenceDir, { recursive: true })
  let app
  const receipt = { mode: 'deterministic-failure retry/resubmit (no model, no billing)', checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const assert = (cond, label) => { if (!cond) throw new Error(`ASSERT_FAILED:${label}`); check(label) }
  const waitTerminal = async (runId) => {
    let waited = null
    for (let attempt = 0; attempt < 12; attempt++) {
      waited = ok(await cli(dir, ['composite', 'execute', 'wait'], { runId, timeoutMs: 15000 }), 'WAIT')
      if (['completed', 'failed', 'cancelled'].includes(waited.status)) break
      await sleep(1000)
    }
    return waited
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

    // 故意不配置模型绑定：内部 ai-process 必然跳过（确定性，无网络）。
    const manifest = compositeManifest()
    const validation = await cli(dir, ['composite', 'validate'], { manifest })
    if (validation.response?.data?.ok !== true)
      throw new Error(`MANIFEST_INVALID:${JSON.stringify(validation.response?.data ?? validation.response).slice(0, 600)}`)
    ok(await cli(dir, ['composite', 'publish'], { manifest }), 'PUBLISH')
    check('发布组合 retry-polish@1.0（内部 ai-process，无模型绑定）')

    // ── 首次 headless 执行 → 确定性失败，公开输入落盘 ──
    const INPUT_TEXT = '受控重试验收原文：人机协同。'
    const exec = ok(await cli(dir, ['composite', 'execute'], {
      capabilityId: 'retry-polish', version: '1.0',
      inputs: [{ portId: 'raw', value: { kind: 'text', text: INPUT_TEXT } }]
    }), 'EXECUTE')
    const rootRunId = exec.runId
    const firstWait = await waitTerminal(rootRunId)
    assert(firstWait.status === 'failed', `首次运行如实失败（${firstWait.status}）`)
    const rootDetail = ok(await cli(dir, ['composite', 'run', 'get'], { runId: rootRunId }), 'ROOT_GET')
    assert(rootDetail.run.inputValues?.raw?.text === INPUT_TEXT, '公开输入值落盘（供原输入复跑）')
    receipt.outputs.rootFailure = { phase: rootDetail.run.failurePhase, nodeId: rootDetail.run.failureNodeId }

    // ── 受控重试：按原版本原输入复跑，重试链根计数 ──
    const retry1 = ok(await cli(dir, ['composite', 'run', 'retry'], { runId: rootRunId }), 'RETRY1')
    assert(retry1.retryOf === rootRunId && retry1.retriesUsed === 1, '重试 1：retryOf=根运行，retriesUsed=1')
    const retry1Wait = await waitTerminal(retry1.runId)
    assert(retry1Wait.status === 'failed' && retry1Wait.retryOf === rootRunId, '重试 1 仍确定性失败且携带重试链标记')
    const retry2 = ok(await cli(dir, ['composite', 'run', 'retry'], { runId: retry1.runId }), 'RETRY2')
    assert(retry2.retryOf === rootRunId && retry2.retriesUsed === 2, '重试 2：链式重试仍按根计数')
    await waitTerminal(retry2.runId)
    const retry3 = ok(await cli(dir, ['composite', 'run', 'retry'], { runId: rootRunId }), 'RETRY3')
    assert(retry3.retriesUsed === 3, '重试 3：达到上限')
    await waitTerminal(retry3.runId)
    const retry4 = await cli(dir, ['composite', 'run', 'retry'], { runId: rootRunId })
    assert(errCode(retry4) === 'RETRY_LIMIT_EXCEEDED', '第 4 次重试拒绝 RETRY_LIMIT_EXCEEDED（受控上限）')

    // ── 人工补交：全量公开端口 + 类型校验 + manualSubmission 如实标记 ──
    const badPorts = await cli(dir, ['composite', 'run', 'resubmit'], {
      runId: rootRunId, outputs: [{ portId: 'wrong-port', value: { kind: 'text', text: 'x' } }]
    })
    assert(errCode(badPorts) === 'OUTPUT_PORTS_MISMATCH', '补交端口不匹配拒绝 OUTPUT_PORTS_MISMATCH')
    const MANUAL_TEXT = '人工补交结论：内容核实无误，同意交付。'
    const resubmit = ok(await cli(dir, ['composite', 'run', 'resubmit'], {
      runId: rootRunId, outputs: [{ portId: 'polished', value: { kind: 'text', text: MANUAL_TEXT } }]
    }), 'RESUBMIT')
    assert(resubmit.status === 'completed' && resubmit.manualSubmission === true, '补交后 completed 且 manualSubmission=true')
    const afterWait = await waitTerminal(rootRunId)
    assert(afterWait.status === 'completed' && afterWait.manualSubmission === true, 'execute.wait 如实暴露人工补交标记')
    assert(afterWait.outputs?.polished?.text === MANUAL_TEXT, '补交输出可经 execute.wait 读取')
    const again = await cli(dir, ['composite', 'run', 'resubmit'], {
      runId: rootRunId, outputs: [{ portId: 'polished', value: { kind: 'text', text: '再次补交' } }]
    })
    assert(errCode(again) === 'RUN_NOT_RESUBMITTABLE', '已完成运行不可重复补交 RUN_NOT_RESUBMITTABLE')
    const retryCompleted = await cli(dir, ['composite', 'run', 'retry'], { runId: rootRunId })
    assert(errCode(retryCompleted) === 'RUN_NOT_RETRYABLE', '已完成运行不可重试 RUN_NOT_RETRYABLE')
    receipt.outputs.deliveredText = MANUAL_TEXT
    receipt.ok = true
  } catch (error) {
    receipt.ok = false
    receipt.error = String(error?.stack || error).slice(0, 1500)
  } finally {
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    if (app) await app.close().catch(() => {})
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  console.log(receipt.ok ? 'ACCEPTANCE OK' : 'ACCEPTANCE FAILED')
  process.exit(receipt.ok ? 0 : 1)
})()