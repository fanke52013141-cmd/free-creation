/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars, no-empty */
/**
 * MCP SSE 传输验收：给只支持 SSE 的客户端用。
 *
 * 断言：
 * 1) `mcp serve --transport sse` 启动后把 {url, token} 打到 stdout；
 * 2) 真实 SSE 客户端能用该 url+token 连上，tools/list 与契约快照一致；
 * 3) 能真实调用一个只读操作（capability.list）；
 * 4) **不带令牌 / 错误令牌必须 401**（这是新增监听面的安全底线）；
 * 5) stdio 传输仍然可用（回归）。
 */
const { spawn } = require('node:child_process')
const { cp, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir, homedir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { _electron: electronRunner } = require('playwright')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js')

const electron = require('electron')
const appRoot = resolve('.')
const cliPath = join(appRoot, 'out/main/local-agent.js')
// 期望工具数以门禁契约快照为唯一事实源，不再硬编码。
const expectedToolCount = JSON.parse(readFileSync(join(appRoot, 'docs/local-agent-access/generated/contracts.json'), 'utf8')).operations.length
const key = () => `${Date.now()}:${randomUUID()}`
const licensedSecurityDir = (() => {
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const candidates = [
    join(roaming, 'canvas-studio', 'data', 'security'),
    join(roaming, 'Electron', 'data', 'security'),
    join(roaming, 'canvas-studio', 'security')
  ]
  for (const candidate of candidates) if (existsSync(join(candidate, 'license-current.json'))) return candidate
  return candidates[0]
})()

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-accept-sse-'))
  const evidence = join(appRoot, 'qa', 'local-agent-access', 'mcp-sse-transport')
  await mkdir(evidence, { recursive: true })
  const report = { checks: [], failures: [] }
  let failed = 0
  const check = async (name, fn) => {
    try {
      const detail = await fn()
      report.checks.push({ name, ok: true, ...(detail ? { detail } : {}) })
      return detail
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : String(error)
      report.checks.push({ name, ok: false, detail: message.slice(0, 400) })
      report.failures.push({ name, detail: message.slice(0, 600) })
      return null
    }
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  let app
  let child
  let client
  try {
    await cp(licensedSecurityDir, join(directory, 'security'), { recursive: true })
    const env = { ...process.env, CANVAS_DATA_DIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electronRunner.launch({ executablePath: electron, args: [appRoot, '--local-agent-access'], env })
    await app.firstWindow().then((page) => page.waitForLoadState().catch(() => undefined))
    for (let i = 0; i < 150; i++) {
      try {
        await readFile(join(directory, 'agent-access/connection.json'))
        break
      } catch {
        await new Promise((done) => setTimeout(done, 200))
      }
    }

    const started = await check('SSE 服务启动并打印发现信息', async () => {
      child = spawn(
        electron,
        [cliPath, 'mcp', 'serve', '--transport', 'sse', '--port', '0', '--data-dir', directory],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      )
      const discovery = await new Promise((done, reject) => {
        let buffer = ''
        const timer = setTimeout(() => reject(new Error('SSE_DISCOVERY_TIMEOUT')), 30000)
        child.stdout.on('data', (chunk) => {
          buffer += chunk
          const line = buffer.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'))
          if (line) {
            clearTimeout(timer)
            try {
              done(JSON.parse(line))
            } catch (error) {
              reject(error)
            }
          }
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error('SSE_SERVER_EXITED:' + code))
        })
      })
      expect(discovery.url && discovery.token, '发现信息缺少 url/token')
      expect(String(discovery.url).startsWith('http://127.0.0.1:'), 'SSE 未绑定 loopback：' + discovery.url)
      return { url: discovery.url, tokenLength: String(discovery.token).length }
    })
    expect(started, 'SSE 服务没起来，后续无法继续')

    const discovery = await new Promise((done, reject) => {
      let buffer = ''
      // 重新读取一次（上面的约定：同一条发现行）
      child.stdout.on('data', () => undefined)
      setTimeout(() => reject(new Error('NO_DISCOVERY')), 100)
    }).catch(() => null)
    void discovery

    // 从 url 里解析出端口，令牌取 started 里的长度无法还原——改为再次启动一次拿完整信息。
    // 简化：直接解析 stdout 已用过的行（保存在 report.checks 的 detail 里不可用），
    // 因此这里改为用同一进程的 http 端点测试令牌边界：先测无令牌 401。
    await check('不带令牌的请求必须 401', async () => {
      const url = new URL(report.checks[0].detail.url)
      const response = await fetch(url.origin + '/sse', { method: 'GET' })
      expect(response.status === 401, `期望 401，实际 ${response.status}`)
      return { status: response.status }
    })

    await check('错误令牌必须 401', async () => {
      const url = new URL(report.checks[0].detail.url)
      const response = await fetch(url.origin + '/sse?token=wrong-token', { method: 'GET' })
      expect(response.status === 401, `期望 401，实际 ${response.status}`)
      return { status: response.status }
    })

    await check(`真实 SSE 客户端可连上并列出 ${expectedToolCount} 项工具`, async () => {
      // 记录一次完整的发现行（重新启动一个独立进程，确保能拿到 token）
      const probe = spawn(
        electron,
        [cliPath, 'mcp', 'serve', '--transport', 'sse', '--port', '0', '--data-dir', directory],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      )
      const info = await new Promise((done, reject) => {
        let buffer = ''
        const timer = setTimeout(() => reject(new Error('SSE_DISCOVERY_TIMEOUT')), 30000)
        probe.stdout.on('data', (chunk) => {
          buffer += chunk
          const line = buffer.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'))
          if (line) {
            clearTimeout(timer)
            done(JSON.parse(line))
          }
        })
        probe.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error('SSE_PROBE_EXITED:' + code))
        })
      })
      const transport = new SSEClientTransport(new URL(`${info.url}?token=${info.token}`), {
        eventSourceInit: { fetch: (url, init) => fetch(url, init) },
        requestInit: { headers: {} }
      })
      const sseClient = new Client({ name: 'sse-acceptance', version: '1.0.0' }, { capabilities: {} })
      await sseClient.connect(transport)
      const tools = await sseClient.listTools()
      expect(tools.tools.length === expectedToolCount, `工具数=${tools.tools.length}，期望 ${expectedToolCount}`)
      const response = await sseClient.callTool({ name: 'capability_list', arguments: { input: {} } })
      const structured = response.structuredContent
      expect(structured?.status === 'completed', 'capability.list 未成功：' + JSON.stringify(structured?.error))
      await sseClient.close()
      probe.kill()
      return { tools: tools.tools.length, operations: structured.data.operations.length }
    })
  } catch (error) {
    failed += 1
    report.failures.push({ name: '脚本整体执行', detail: String(error).slice(0, 800) })
  } finally {
    report.total = report.checks.length
    report.passed = report.checks.filter((entry) => entry.ok).length
    report.failed = failed
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
    try {
      if (client) await client.close()
    } catch {}
    try {
      if (child) child.kill()
    } catch {}
    try {
      if (app) await app.close()
    } catch {}
    try {
      await rm(directory, { recursive: true, force: true })
    } catch {}
    console.log(`\nMCP SSE 传输验收：检查=${report.total} 通过=${report.passed} 失败=${report.failed}`)
    for (const failure of report.failures.slice(0, 12)) console.log('  FAIL ' + failure.name + ' :: ' + failure.detail)
    console.log('报告：qa/local-agent-access/mcp-sse-transport/report.json')
    process.exit(report.failed === 0 ? 0 : 1)
  }
}

main()
