/* eslint-disable */
// headless 节点流执行 E2E：不打开任何项目，composite.execute 直接运行已发布节点流。
// 隔离数据目录 + 真实 Electron + CLI；验证发布→无项目执行→台账输出全链路。
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const root = path.resolve(__dirname, '..', '..')
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
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
function ok(res, label) {
  if (res.code !== 0 || !res.response || res.response.status === 'failed' || res.response.error)
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 800)}`)
  return res.response.data
}

const manifest = {
  schemaVersion: 1,
  runtimeVersion: 2,
  capabilityId: 'headless-copy',
  version: '1.0',
  name: 'headless文案整理',
  inputs: [{ id: 'copy', label: '文案', type: 'text', required: true, cardinality: 'one', targets: [{ nodeId: 'n1', portId: 'in-text' }] }],
  outputs: [{ id: 'polished', label: '整理结果', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } }],
  graph: {
    nodes: [{
      id: 'n1', nodeType: 'text', contractVersion: 3, title: '文案', dx: 0, dy: 0, w: 340, h: 300, text: '内部说明',
      ports: [
        { id: 'in-text', name: 'in-text', dir: 'in', type: 'text', required: true, cardinality: 'many' },
        { id: 'out-text', name: 'out-text', dir: 'out', type: 'text', required: true, cardinality: 'one' }
      ]
    }],
    edges: []
  },
  dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-headless-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const checks = []
  const check = (label) => { checks.push(label); console.log(`[check] ${label}`) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] 节点流输入预检')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')
    check('应用就绪（未打开任何项目）')

    // 1. 发布节点流（无需项目）
    const pub = ok(await cli(dir, ['composite', 'publish'], { manifest }), 'PUBLISH')
    if (pub.version !== '1.0') throw new Error('PUBLISH_VERSION')
    check('composite.publish 发布节点流（无项目）')

    // 2. 确认当前无活动项目
    const status = ok(await cli(dir, ['app', 'status'], {}), 'STATUS')
    check('app.status 就绪')

    // 3. headless 执行（无项目，按公开输入端口喂值；计费确认门 2026-11-20）
    const execNoGate = await cli(dir, ['composite', 'execute'], {
      capabilityId: 'headless-copy',
      inputs: [{ portId: 'in-copy', value: { kind: 'text', text: '外部输入文本' } }]
    })
    if (execNoGate.response?.error?.code !== 'COST_CONFIRM_REQUIRED')
      throw new Error(`COST_GATE_MISSING:${JSON.stringify(execNoGate.response)}`)
    check('未带 confirmCost → COST_CONFIRM_REQUIRED 拒绝（计费确认门）')
    const exec = ok(await cli(dir, ['composite', 'execute'], {
      capabilityId: 'headless-copy',
      inputs: [{ portId: 'in-copy', value: { kind: 'text', text: '外部输入文本' } }],
      confirmCost: true
    }), 'EXECUTE')
    if (!exec.runId || exec.status !== 'running') throw new Error(`EXECUTE_BAD:${JSON.stringify(exec)}`)
    check(`composite.execute 受理 runId=${exec.runId.slice(0, 8)}（无项目）`)

    // 4. 等待终态 + 读取输出
    const waited = ok(await cli(dir, ['composite', 'execute', 'wait'], { runId: exec.runId, timeoutMs: 60000 }), 'WAIT')
    if (waited.status !== 'completed') throw new Error(`WAIT_NOT_COMPLETED:${JSON.stringify(waited)}`)
    const outText = waited.outputs?.['out-polished']?.text
    if (typeof outText !== 'string' || !outText.includes('外部输入文本'))
      throw new Error(`OUTPUT_WRONG:${JSON.stringify(waited.outputs)}`)
    check(`composite.execute.wait 终态 completed，输出含外部输入（${outText.slice(0, 30)}…）`)

    // 5. composite.run.get 全局读取（无项目参数）
    const runGet = ok(await cli(dir, ['composite', 'run', 'get'], { runId: exec.runId }), 'RUN_GET')
    if (runGet.run.status !== 'completed') throw new Error('RUN_GET_STATUS')
    check('composite.run.get 按 runId 全局读取终态（无项目）')

    // 6. 缺必填输入 → 应失败（INPUT_REQUIRED）
    const execNoInput = ok(await cli(dir, ['composite', 'execute'], { capabilityId: 'headless-copy', confirmCost: true }), 'EXEC_NOINPUT')
    const waitedNoInput = ok(await cli(dir, ['composite', 'execute', 'wait'], { runId: execNoInput.runId, timeoutMs: 30000 }), 'WAIT_NOINPUT')
    if (waitedNoInput.status !== 'failed') throw new Error(`NOINPUT_SHOULD_FAIL:${JSON.stringify(waitedNoInput)}`)
    const missing = ok(await cli(dir, ['composite', 'run', 'get'], {
      runId: execNoInput.runId
    }), 'GET_NOINPUT')
    if (missing.run.errorCode !== 'INPUT_REQUIRED' ||
        missing.run.failurePhase !== 'input' || missing.steps.length !== 0) {
      throw new Error(`CLI_REQUIRED_INPUT_PREFLIGHT:${JSON.stringify(missing)}`)
    }
    check('CLI 缺必填输入返回 INPUT_REQUIRED，内部步骤未启动')

    const retried = ok(await cli(dir, ['composite', 'run', 'retry'], {
      runId: execNoInput.runId
    }), 'RETRY_BEFORE_EXECUTION')
    if (retried.retryOf !== execNoInput.runId || retried.runId === execNoInput.runId)
      throw new Error(`RETRY_CHAIN_INVALID:${JSON.stringify(retried)}`)
    await ok(await cli(dir, ['composite', 'execute', 'wait'], {
      runId: retried.runId, timeoutMs: 30000
    }), 'WAIT_RETRY')
    const retryRun = ok(await cli(dir, ['composite', 'run', 'get'], {
      runId: retried.runId
    }), 'GET_RETRY')
    if (retryRun.run.errorCode !== 'INPUT_REQUIRED' || retryRun.steps.length !== 0)
      throw new Error(`RETRY_PREFLIGHT_BYPASSED:${JSON.stringify(retryRun)}`)
    check('执行前失败可重试并关联原运行，重试仍须通过必填输入预检')

    const transport = new StdioClientTransport({
      command: require('electron'),
      args: [path.join(root, 'out/main/local-agent.js'), 'mcp', 'serve', '--profile', 'full', '--stdio', '--data-dir', dir],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe'
    })
    const mcp = new Client({ name: 'composite-input-preflight', version: '1.0.0' })
    try {
      await mcp.connect(transport)
      const invoke = async (name, input) => {
        const reply = await mcp.callTool({ name, arguments: { input, idempotencyKey: key() } })
        if (!reply.structuredContent?.data || reply.structuredContent.error) {
          throw new Error(`${name}:${JSON.stringify(reply.structuredContent)}`)
        }
        return reply.structuredContent.data
      }
      const { runId } = await invoke('composite_execute', {
        capabilityId: manifest.capabilityId, confirmCost: true
      })
      await invoke('composite_execute_wait', { runId, timeoutMs: 30000 })
      const result = await invoke('composite_run_get', { runId })
      if (result.run.errorCode !== 'INPUT_REQUIRED' ||
          result.run.failurePhase !== 'input' || result.steps.length !== 0) {
        throw new Error(`MCP_REQUIRED_INPUT_PREFLIGHT:${JSON.stringify(result)}`)
      }
      check('MCP 缺必填输入返回相同错误和阶段，内部步骤未启动')
      const invalid = structuredClone(manifest)
      invalid.inputs[0].schema = { type: 'string' }
      const cliValidation = ok(await cli(dir, ['composite', 'validate'], {
        manifest: invalid
      }), 'CLI_VALIDATE')
      const mcpValidation = await invoke('composite_validate', { manifest: invalid })
      if (!cliValidation.issues.some((issue) => issue.code === 'INLINE_SCHEMA_REMOVED') ||
          JSON.stringify(cliValidation) !== JSON.stringify(mcpValidation)) {
        throw new Error(`CLI_MCP_PUBLICATION_VALIDATION_DIFFERS:${JSON.stringify(mcpValidation)}`)
      }
      check('CLI 与 MCP 对内联 Schema 返回相同的发布预检结果')
    } finally {
      await mcp.close().catch(() => undefined)
    }

    console.log(JSON.stringify({ ok: true, checks, outputs: { runId: exec.runId, outputText: outText } }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.stack || error), checks }, null, 2))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()
