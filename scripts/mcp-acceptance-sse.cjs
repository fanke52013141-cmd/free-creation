/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars, no-empty */
/**
 * MCP SSE 传输验收：给只支持 SSE 的客户端用。
 *
 * 断言：
 * 1) `mcp serve --transport sse` 启动后把 {url, token} 打到 stdout；
 * 2) 真实 SSE 客户端能用该 url 与 Authorization 请求头连上，tools/list 与契约快照一致；
 * 3) 能真实调用一个只读操作（capability.list）；
 * 4) **缺失/错误 Authorization 请求头必须 401，带 query token 不再足够**；
 * 5) Host/Origin 校验仍然可用（回归）。
 * 6) stdio 传输仍然可用（回归）。
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
  let discovery
  let probe
  let discoveryTokenLength = 0
  const startSseProbe = () => {
    const processHandle = spawn(
      electron,
      [cliPath, 'mcp', 'serve', '--profile', 'full', '--transport', 'sse', '--port', '0', '--data-dir', directory],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    processHandle.stderr.resume()
    return new Promise((done, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('SSE_DISCOVERY_TIMEOUT')), 30000)
      processHandle.stdout.on('data', (chunk) => {
        buffer += chunk
        const line = buffer.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'))
        if (!line) return
        clearTimeout(timer)
        try {
          const parsed = JSON.parse(line)
          if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string' || !parsed.token)
            throw new Error('SSE_DISCOVERY_INVALID')
          discoveryTokenLength = parsed.token.length
          done(parsed)
        } catch (error) {
          reject(error)
        }
      })
      processHandle.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error('SSE_SERVER_EXITED:' + code))
      })
    })
  }
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
      discovery = await startSseProbe()
      const parsed = new URL(discovery.url)
      expect(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1', 'SSE 未绑定 loopback')
      expect(parsed.pathname === '/sse' && !parsed.search, 'SSE 发现 URL 不应携带 query')
      return { url: discovery.url, tokenLength: discoveryTokenLength }
    })
    expect(started, 'SSE 服务没起来，后续无法继续')

    await check('缺失 Authorization 请求头必须 401', async () => {
      const url = new URL(discovery.url)
      const response = await fetch(url.origin + '/sse', { method: 'GET' })
      expect(response.status === 401, `期望 401，实际 ${response.status}`)
      expect(response.headers.get('www-authenticate')?.startsWith('Bearer'), '缺少 Bearer challenge')
      await response.body?.cancel()
      return { status: response.status }
    })

    await check('错误 Authorization 请求头必须 401', async () => {
      const url = new URL(discovery.url)
      const response = await fetch(url.origin + '/sse', {
        method: 'GET',
        headers: { Authorization: 'Bearer wrong-token' }
      })
      expect(response.status === 401, `期望 401，实际 ${response.status}`)
      await response.body?.cancel()
      return { status: response.status }
    })

    await check('带 query token 的请求必须 401', async () => {
      const url = new URL(discovery.url)
      url.searchParams.set('token', discovery.token)
      const response = await fetch(url, { method: 'GET' })
      expect(response.status === 401, `期望 401，实际 ${response.status}`)
      await response.body?.cancel()
      return { status: response.status }
    })

    await check('Host 与 Origin 校验保持生效', async () => {
      const url = new URL(discovery.url)
      const { request: httpRequest } = require('node:http')
      const badHostStatus = await new Promise((done, reject) => {
        const req = httpRequest(
          url,
          { method: 'GET', headers: { Authorization: `Bearer ${discovery.token}`, Host: 'evil.invalid' } },
          (res) => {
            res.resume()
            res.once('end', () => done(res.statusCode))
          }
        )
        req.once('error', reject)
        req.end()
      })
      expect(badHostStatus === 403, `Host 期望 403，实际 ${badHostStatus}`)
      const badHost = { status: badHostStatus }
      const badOrigin = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${discovery.token}`, Origin: 'https://evil.invalid' }
      })
      expect(badOrigin.status === 403, `Origin 期望 403，实际 ${badOrigin.status}`)
      await badOrigin.body?.cancel()
      return { host: badHost.status, origin: badOrigin.status }
    })

    await check(`真实 SSE 客户端可连上并列出 ${expectedToolCount} 项工具`, async () => {
      probe = spawn(
        electron,
        [cliPath, 'mcp', 'serve', '--profile', 'full', '--transport', 'sse', '--port', '0', '--data-dir', directory],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      )
      probe.stderr.resume()
      const info = await new Promise((done, reject) => {
        let buffer = ''
        const timer = setTimeout(() => reject(new Error('SSE_DISCOVERY_TIMEOUT')), 30000)
        probe.stdout.on('data', (chunk) => {
          buffer += chunk
          const line = buffer.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'))
          if (!line) return
          clearTimeout(timer)
          try {
            const parsed = JSON.parse(line)
            if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string' || !parsed.token)
              throw new Error('SSE_DISCOVERY_INVALID')
            discoveryTokenLength = parsed.token.length
            done(parsed)
          } catch (error) {
            reject(error)
          }
        })
        probe.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error('SSE_PROBE_EXITED:' + code))
        })
      })
      const transport = new SSEClientTransport(new URL(info.url), {
        eventSourceInit: { fetch: (url, init) => fetch(url, init) },
        requestInit: { headers: { Authorization: `Bearer ${info.token}` } }
      })
      const sseClient = new Client({ name: 'sse-acceptance', version: '1.0.0' }, { capabilities: {} })
      try {
        await sseClient.connect(transport)
        const tools = await sseClient.listTools()
        expect(tools.tools.length === expectedToolCount, `工具数=${tools.tools.length}，期望 ${expectedToolCount}`)
        const response = await sseClient.callTool({ name: 'capability_list', arguments: { input: {} } })
        const structured = response.structuredContent
        expect(structured?.status === 'completed', 'capability.list 未成功：' + JSON.stringify(structured?.error))
        const serializedReport = JSON.stringify(report)
        expect(!serializedReport.includes(info.token), '验收报告包含 token')
        return { tools: tools.tools.length, operations: structured.data.operations.length }
      } finally {
        await sseClient.close().catch(() => undefined)
        probe.kill()
      }
    })

    await check('stdio 传输仍然可用', async () => {
      const transport = new StdioClientTransport({
        command: electron,
        args: [cliPath, 'mcp', 'serve', '--profile', 'full', '--transport', 'stdio', '--data-dir', directory],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stderr: 'pipe'
      })
      const stdioClient = new Client({ name: 'stdio-acceptance', version: '1.0.0' }, { capabilities: {} })
      try {
        await stdioClient.connect(transport)
        const response = await stdioClient.callTool({ name: 'capability_list', arguments: { input: {} } })
        const structured = response.structuredContent
        expect(structured?.status === 'completed', 'stdio capability.list 未成功')
        return { operations: structured.data.operations.length }
      } finally {
        await stdioClient.close().catch(() => undefined)
      }
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
      if (probe) probe.kill()
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
