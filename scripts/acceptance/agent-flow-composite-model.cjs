/* eslint-disable */
// 第三类-d：composite 节点流真实模型运行验收（内部 ai-process 节点走真实模型）。
// 真实模型（计费，小额）：CANVAS_TEST_API_KEY；CANVAS_TEST_MODEL 默认 glm-5.3-flash。
// 前置：CANVAS_OWNER=1 构建。运行：node scripts/acceptance/agent-flow-composite-model.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-composite-model')
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

// 内部 ai-process 节点的组合能力：公开文本输入 → AI 整理 → 公开文本输出。
function compositeManifest() {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'model-polish',
    version: '1.0',
    name: '模型整理',
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
          config: JSON.stringify({ mode: 'text', system: '你是文字整理助手。把输入素材整理成一段连贯的短文，直接输出正文，不要解释。', temperature: 0.3, maxTokens: 512 }),
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
    executionPolicy: { timeoutMs: 300000, maxDepth: 5, maxExpandedNodes: 40, maxExpandedEdges: 120, waitForInput: true }
  }
}

;(async () => {
  if (!process.env.CANVAS_TEST_API_KEY) throw new Error('CANVAS_TEST_API_KEY_MISSING')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-composite-model-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { mode: 'real-model (paid, small)', model: MODEL_ID, checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setTitle('[TEST] composite 真实模型运行')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    // 模型配置 + text.process 功能绑定（ai-process 执行必需）。
    // 注意：gateway store 仅在项目打开时加载 providers——必须先配模型再建项目，
    // 否则组合内部执行拿到陈旧的空 provider 目录（解析失败被跳过）。
    ok(await cli(dir, ['model', 'connection', 'save'], {
      id: 'zhipu-official', name: '智谱官方', protocol: 'openai-compatible',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: process.env.CANVAS_TEST_API_KEY
    }), 'CONNECTION_SAVE')
    ok(await cli(dir, ['model', 'definition', 'save'], {
      id: 'glm-test-model', connectionId: 'zhipu-official', name: MODEL_ID,
      modelId: MODEL_ID, capabilities: [{ operation: 'text.generate', streaming: true }]
    }), 'DEFINITION_SAVE')
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
    check(`模型 ${MODEL_ID} text.generate 能力验证 + text.process 绑定`)

    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] composite 模型运行' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    const manifest = compositeManifest()
    const validation = await cli(dir, ['composite', 'validate'], { manifest })
    if (validation.response?.data?.ok !== true)
      throw new Error(`MANIFEST_INVALID:${JSON.stringify(validation.response?.data ?? validation.response).slice(0, 600)}`)
    ok(await cli(dir, ['composite', 'publish'], { manifest }), 'PUBLISH')
    check('发布组合能力 model-polish@1.0（内部 ai-process）')

    const batch1 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'src', nodeType: 'text', title: '素材', x: 100, y: 100,
        text: 'AI 协作素材：人负责判断与取舍，AI 负责生成候选；每一步人都可以编辑、替换或重试。' },
      { action: 'node.create', ref: 'inst', nodeType: 'composite', title: '模型整理', x: 540, y: 100,
        config: { capabilityId: 'model-polish', version: '1.0' } }
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

    // 运行实例（内部 ai-process 走真实模型；长调用可能 reconcile）。
    const g2 = ok(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH2')
    const exec = ok(await cli(dir, ['node', 'execute'], {
      projectId, expectedGraphVersion: g2.graphVersion, nodeIds: [r.inst], mode: 'single'
    }), 'EXECUTE')
    let waited = null
    for (let attempt = 0; attempt < 10; attempt++) {
      waited = ok(await cli(dir, ['run', 'wait'], { projectId, taskId: exec.taskId, timeoutMs: 60000 }), 'WAIT')
      if (waited.state === 'completed' || waited.state === 'failed') break
      await sleep(3000)
    }
    if (waited.state !== 'completed') {
      // 诊断：内部步骤台账（定位 ai-process 跳过/失败原因）。
      const runs = await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 5 })
      const runId = runs.response?.data?.[0]?.id
      const detail = runId ? await cli(dir, ['composite', 'run', 'get'], { runId }) : null
      const steps = detail?.response?.data?.steps ?? []
      throw new Error(`RUN_NOT_COMPLETED:${JSON.stringify(waited).slice(0, 200)} STEP_REASONS:${JSON.stringify(steps.map((s) => ({ step: s.stepKey, status: s.status, reason: s.reason })))}`)
    }
    // 输出轮询（meta 落盘晚于终态）。
    let text = null
    for (let i = 0; i < 20; i++) {
      const output = ok(await cli(dir, ['output', 'get'], { projectId, nodeId: r.inst }), 'OUTPUT')
      const hit = output.outputs.find((o) => o.portId === 'out-polished' && o.kind === 'text')
      if (hit?.text?.trim()) { text = hit.text; break }
      await sleep(1500)
    }
    if (!text) throw new Error('MODEL_OUTPUT_MISSING')
    receipt.outputs.modelText = text.slice(0, 300)
    check(`composite 真实模型运行 completed，公开输出为模型生成文本（${text.length} 字）`)

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