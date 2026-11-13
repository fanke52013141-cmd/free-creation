/* eslint-disable */
// W4 失败定位验收：composite 内部节点确定性失败（无需真实模型/计费）。
// 不配置模型绑定 → 内部 ai-process 跳过 → 必需公开输出缺失 → 运行失败。
// 断言：composite.run.get 返回结构化 failureNodeId/failurePortId/failurePhase，
//       内部步骤如实记 skipped+reason；composite.execute.wait 失败填充 nodeId/portId。
// 前置：CANVAS_OWNER=1 构建。运行：node scripts/acceptance/agent-flow-composite-failure.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-composite-failure')
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

// 内部 ai-process 的组合：公开文本输入 → AI 整理 → 公开文本输出。
// 不绑定模型时 ai-process 跳过，必需输出 polished 缺失 → 可定位失败。
function compositeManifest() {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'failure-polish',
    version: '1.0',
    name: '失败定位整理',
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-composite-failure-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { mode: 'deterministic-failure (no model, no billing)', checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const assert = (cond, label) => { if (!cond) throw new Error(`ASSERT_FAILED:${label}`); check(label) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] composite 失败定位')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    // 故意不配置模型绑定：内部 ai-process 必然跳过（确定性，无网络）。
    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] composite 失败定位' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    const manifest = compositeManifest()
    const validation = await cli(dir, ['composite', 'validate'], { manifest })
    if (validation.response?.data?.ok !== true)
      throw new Error(`MANIFEST_INVALID:${JSON.stringify(validation.response?.data ?? validation.response).slice(0, 600)}`)
    ok(await cli(dir, ['composite', 'publish'], { manifest }), 'PUBLISH')
    check('发布组合 failure-polish@1.0（内部 ai-process，无模型绑定）')

    const batch1 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'src', nodeType: 'text', title: '素材', x: 100, y: 100, text: '失败定位验收素材。' },
      { action: 'node.create', ref: 'inst', nodeType: 'composite', title: '失败定位整理', x: 540, y: 100,
        config: { capabilityId: 'failure-polish', version: '1.0' } }
    ], 'BATCH1')
    const r = Object.fromEntries(batch1.created.map((c) => [c.ref, c.nodeId]))
    const graph = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH')
    const instNode = graph.nodes.find((n) => n.nodeId === r.inst)
    const inPort = instNode.ports.find((p) => p.dir === 'in' && p.type === 'text')
    if (!inPort) throw new Error(`INSTANCE_INPUT_PORT_MISSING:${JSON.stringify(instNode.ports)}`)
    await patchWithRetry(dir, projectId, [
      { action: 'edge.create', from: { nodeId: r.src, portId: 'out-text' }, to: { nodeId: r.inst, portId: inPort.id } }
    ], 'BATCH2')
    check('插入引用形态实例并连接素材 → 公开输入')

    const g2 = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH2')
    const exec = ok(await cli(dir, ['node', 'execute'], {
      projectId, expectedGraphVersion: g2.graphVersion, nodeIds: [r.inst], mode: 'single'
    }), 'EXECUTE')
    let waited = null
    for (let attempt = 0; attempt < 10; attempt++) {
      waited = ok(await cli(dir, ['run', 'wait'], { projectId, taskId: exec.taskId, timeoutMs: 60000 }), 'WAIT')
      if (waited.state === 'completed' || waited.state === 'failed') break
      await sleep(2000)
    }
    assert(waited.state === 'failed', `运行如实失败（state=${waited.state}），不伪造成功`)

    // 结构化失败定位：composite.run.get 返回 failureNodeId/failurePortId/failurePhase + skipped 步骤。
    const runs = ok(await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 5 }), 'RUN_LIST')
    const runId = runs[0]?.id
    if (!runId) throw new Error('RUN_LEDGER_MISSING')
    const detail = ok(await cli(dir, ['composite', 'run', 'get'], { runId }), 'RUN_GET')
    receipt.outputs.run = {
      status: detail.run.status,
      failurePhase: detail.run.failurePhase,
      failureNodeId: detail.run.failureNodeId,
      failurePortId: detail.run.failurePortId,
      errorCode: detail.run.errorCode
    }
    receipt.outputs.steps = detail.steps.map((s) => ({ step: s.stepKey, status: s.status, reason: s.reason }))
    assert(detail.run.status === 'failed', '台账运行状态 failed')
    assert(detail.run.failurePhase === 'output', `失败阶段定位 output（实际 ${detail.run.failurePhase}）`)
    assert(detail.run.failureNodeId === 'n1', `失败节点定位 n1（实际 ${detail.run.failureNodeId}）`)
    assert(detail.run.failurePortId === 'out-text', `失败端口定位 out-text（实际 ${detail.run.failurePortId}）`)
    const n1 = detail.steps.find((s) => s.stepKey === 'n1')
    assert(n1 && n1.status === 'skipped', `内部步骤如实记 skipped（实际 ${n1?.status}），不再误记 completed`)
    assert(n1 && /text\.process|跳过|输入/.test(n1.reason || ''), `跳过原因可查（${n1?.reason}）`)

    // 顶层节点 meta.nodeRun.error 携带失败定位（执行器边界透传）。
    const output = ok(await cli(dir, ['output', 'get'], { projectId, nodeId: r.inst }), 'OUTPUT')
    receipt.outputs.instanceOutputPorts = (output.outputs || []).map((o) => o.portId)

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