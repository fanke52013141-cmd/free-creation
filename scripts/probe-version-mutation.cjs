/**
 * 对照实验：连续调用 graph.get（latest）是否会推进图版本？
 * 读操作不应该改变版本；若每次读都 +1，说明读路径上有保存副作用（真实缺陷）。
 */
const { _electron } = require('playwright')
const { cp, mkdtemp, readFile, rm } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir, homedir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const electron = require('electron')
const appRoot = resolve('.')
const cliPath = join(appRoot, 'out/main/local-agent.js')
const key = () => `${Date.now()}:${randomUUID()}`
const licensedSecurityDir = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'canvas-studio',
  'data',
  'security'
)

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-version-probe-'))
  let app
  let client
  try {
    await cp(licensedSecurityDir, join(directory, 'security'), { recursive: true })
    const env = { ...process.env, CANVAS_DATA_DIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: electron, args: [appRoot, '--local-agent-access'], env })
    await app.firstWindow().then((page) => page.waitForLoadState().catch(() => undefined))
    for (let i = 0; i < 150; i++) {
      try {
        await readFile(join(directory, 'agent-access/connection.json'))
        break
      } catch {
        await new Promise((done) => setTimeout(done, 200))
      }
    }
    const transport = new StdioClientTransport({
      command: electron,
      args: [cliPath, 'mcp', 'serve', '--stdio', '--data-dir', directory],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe'
    })
    client = new Client({ name: 'version-probe', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    const call = async (operationId, input) => {
      const result = await client.callTool({
        name: operationId.replaceAll('.', '_'),
        arguments: { input, idempotencyKey: key() }
      })
      return result.structuredContent ?? JSON.parse(String(result.content?.[0]?.text ?? '{}'))
    }

    const created = await call('project.create', { name: '版本探针' })
    const projectId = created.data.meta.id
    await call('project.open', { projectId })
    await new Promise((done) => setTimeout(done, 1500))

    console.log('连续 8 次 graph.get(latest) 的版本：')
    const versions = []
    for (let i = 0; i < 8; i += 1) {
      const response = await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 1 })
      if (response.status !== 'completed') {
        console.log(`  第 ${i + 1} 次失败：${JSON.stringify(response.error)}`)
        break
      }
      versions.push(response.data.graphVersion)
      await new Promise((done) => setTimeout(done, 300))
    }
    console.log('  ' + JSON.stringify(versions))
    const increasing = versions.length > 1 && versions.some((v, i) => i > 0 && v !== versions[0])
    console.log(increasing ? '结论：读操作会推进版本（缺陷）' : '结论：读操作不改版本')

    // 再试 persisted 视图，看两者是否一致
    const persisted = await call('graph.get', { projectId, view: 'persisted', offset: 0, limit: 1 })
    console.log('persisted 版本：', persisted?.data?.graphVersion, '| latest 版本：', versions.at(-1))
  } finally {
    try {
      if (client) await client.close()
    } catch {}
    try {
      if (app) await app.close()
    } catch {}
    await rm(directory, { recursive: true, force: true })
  }
}

main()
