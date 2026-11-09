/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars, no-empty */
/**
 * 探针：失败的 canvas.history 请求是否推进图版本？
 * 若每次失败都 +1，说明"读→写"永远追不上（这是真实缺陷，不是测试问题）。
 */
const { _electron } = require('playwright')
const { cp, mkdtemp, readFile, rm } = require('node:fs/promises')
const { resolve, join } = require('node:path')
const { tmpdir, homedir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const electron = require('electron')
const appRoot = resolve('.')
const cliPath = join(appRoot, 'out/main/local-agent.js')
const key = () => `${Date.now()}:${randomUUID()}`

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-history-probe-'))
  let app
  let client
  try {
    await cp(
      join(process.env.APPDATA, 'canvas-studio', 'data', 'security'),
      join(directory, 'security'),
      { recursive: true }
    )
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
    client = new Client({ name: 'history-probe', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    const call = async (operationId, input) => {
      const result = await client.callTool({
        name: operationId.replaceAll('.', '_'),
        arguments: { input, idempotencyKey: key() }
      })
      return result.structuredContent ?? JSON.parse(String(result.content?.[0]?.text ?? '{}'))
    }
    const version = async () => {
      const response = await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 1 })
      return response?.data?.graphVersion
    }

    const created = await call('project.create', { name: '历史探针' })
    const projectId = created.data.meta.id
    await call('project.open', { projectId })
    await new Promise((done) => setTimeout(done, 1200))

    // 造一次编辑（产生可撤销的历史步）
    const patch = await call('graph.patch', {
      projectId,
      expectedGraphVersion: await version(),
      ops: [{ action: 'node.create', nodeType: 'text', x: 0, y: 0, title: '甲' }]
    })
    console.log('建节点：', patch.status)
    await new Promise((done) => setTimeout(done, 1500))

    console.log('\n用同一个版本连续请求 undo（故意让它冲突），观察版本是否被推进：')
    const stale = await version()
    console.log('起始版本：', stale)
    for (let i = 0; i < 5; i += 1) {
      const response = await call('canvas.history', {
        projectId,
        expectedGraphVersion: stale,
        direction: 'undo'
      })
      const after = await version()
      console.log(
        `  第 ${i + 1} 次：status=${response.status} code=${response.error?.code ?? '-'} detail=${response.error?.detail ?? '-'} | 请求后 latest 版本=${after}`
      )
      await new Promise((done) => setTimeout(done, 400))
    }
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
