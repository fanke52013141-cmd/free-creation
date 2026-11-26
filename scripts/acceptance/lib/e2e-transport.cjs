/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Shared real Electron/CLI/MCP transport for deterministic acceptance fixtures.
// No business result is fabricated here: every operation crosses the production access service.
const { _electron } = require('playwright')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..', '..')
const cliEntry = path.join(root, 'out', 'main', 'local-agent.js')
const electronBinary = () => (process.execPath.includes('electron') ? process.execPath : require('electron'))
const key = () => `${Date.now()}:${randomUUID()}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OPERATION_TIMEOUT_MS = 360_000 // 人工决定 330s + 执行余量，两个入口一致。
const LICENSE_MODE = 'dev-bypass-not-authorization-acceptance'

function readConnection(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'agent-access', 'connection.json'), 'utf8'))
}

async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input !== undefined) {
    fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }), { mode: 0o600 })
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(electronBinary(), [
        cliEntry,
        ...args,
        '--data-dir', dir,
        ...(input !== undefined ? ['--input-file', file] : [])
      ], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      let out = '', err = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI_TIMEOUT:${args.join(' ')}`)) }, OPERATION_TIMEOUT_MS)
      child.stdout.on('data', (chunk) => { out += chunk })
      child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-2000) })
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timer)
        try { resolve({ code, response: JSON.parse(out), err }) }
        catch { resolve({ code, response: null, raw: out, err }) }
      })
    })
  } finally {
    if (input !== undefined) {
      try { fs.unlinkSync(file) } catch { /* already absent */ }
    }
  }
}

function ok(result, label) {
  if (result?.code !== 0 || !result.response || result.response.error) {
    throw new Error(`${label}:${JSON.stringify(result?.response ?? result).slice(0, 1000)}`)
  }
  return result.response.data
}

async function launchApp(dir, title = '[TEST] Agent remediation E2E', rendererUrl) {
  const connection = path.join(dir, 'agent-access', 'connection.json')
  const previous = fs.existsSync(connection) ? readConnection(dir) : null
  const env = {
    ...process.env,
    CANVAS_DATA_DIR: dir,
    // 仅未打包开发构建可用；绝不复制本机真实 license/security/私钥到测试目录。
    CANVAS_LICENSE_DEV_BYPASS: '1',
    ...(rendererUrl
      ? { NODE_ENV: 'development', ELECTRON_RENDERER_URL: rendererUrl, CANVAS_AGENT_RENDERER_URL: rendererUrl }
      : {})
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath: electronBinary(),
    args: [root, '--local-agent-access'],
    env
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState().catch(() => undefined)
    await app.evaluate(({ BrowserWindow }, windowTitle) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle(windowTitle)
    }, title)
    // Playwright 的 app.process().pid 可能是外层启动器；描述文件写的是 Electron 主进程 PID。
    const pid = await app.evaluate(() => process.pid)
    for (let attempt = 0; attempt < 150; attempt++) {
      if (fs.existsSync(connection)) {
        const current = readConnection(dir)
        if (
          current.instanceId !== previous?.instanceId &&
          typeof current.instanceId === 'string' &&
          current.pid === pid
        ) {
          return { app, page, instanceId: current.instanceId, pid: current.pid }
        }
      }
      await sleep(200)
    }
    throw new Error('AGENT_ACCESS_CONNECTION_TIMEOUT_OR_STALE')
  } catch (error) {
    await app.close().catch(() => undefined)
    throw error
  }
}

async function startMcp(dir, expected) {
  if (expected) {
    const current = readConnection(dir)
    if (current.instanceId !== expected.instanceId || current.pid !== expected.pid) {
      throw new Error('MCP_CONNECTION_INSTANCE_MISMATCH')
    }
  }
  const transport = new StdioClientTransport({
    command: electronBinary(),
    args: [cliEntry, 'mcp', 'serve', '--stdio', '--data-dir', dir],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'agent-remediation-e2e', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
  } catch (error) {
    await transport.close().catch(() => undefined)
    throw error
  }
  const call = async (operationId, input, idempotencyKey = key()) => {
    const result = await client.callTool({
      name: operationId.replaceAll('.', '_'),
      arguments: { input, ...(idempotencyKey ? { idempotencyKey } : {}) }
    }, undefined, { timeout: OPERATION_TIMEOUT_MS, maxTotalTimeout: OPERATION_TIMEOUT_MS })
    if (result.structuredContent) return result.structuredContent
    const text = String(result.content?.[0]?.text ?? '{}')
    try { return JSON.parse(text) }
    catch { return { status: 'failed', error: { code: 'MCP_PLAIN_TEXT_ERROR', phase: 'protocol', detail: text.slice(0, 500) } } }
  }
  const close = async () => {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
  return { client, call, close }
}

function mcpOk(response, label) {
  if (!response || response.status !== 'completed' || response.error) {
    throw new Error(`${label}:${JSON.stringify(response).slice(0, 1000)}`)
  }
  return Object.hasOwn(response, 'data') ? response.data : undefined
}

module.exports = { root, key, sleep, cli, ok, launchApp, startMcp, mcpOk, LICENSE_MODE }
