/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars, no-empty */
// 探针：group.create 的回执到底返回了什么（确认 groups 是否真被回传）
const { _electron } = require('playwright')
const { cp, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const electron = require('electron')
const appRoot = resolve('.')
const cliPath = join(appRoot, 'out/main/local-agent.js')
const key = () => `${Date.now()}:${randomUUID()}`

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-group-probe-'))
  let app, client
  try {
    await cp(join(process.env.APPDATA, 'Electron', 'data', 'security'), join(directory, 'security'), { recursive: true })
    const env = { ...process.env, CANVAS_DATA_DIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: electron, args: [appRoot, '--local-agent-access'], env })
    await app.firstWindow().then((p) => p.waitForLoadState().catch(() => undefined))
    for (let i = 0; i < 150; i++) {
      try { await readFile(join(directory, 'agent-access/connection.json')); break } catch { await new Promise((d) => setTimeout(d, 200)) }
    }
    const transport = new StdioClientTransport({ command: electron, args: [cliPath, 'mcp', 'serve', '--stdio', '--data-dir', directory], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' })
    client = new Client({ name: 'group-probe', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    const call = async (operationId, input) => {
      const result = await client.callTool({ name: operationId.replaceAll('.', '_'), arguments: { input, idempotencyKey: key() } })
      return result.structuredContent ?? JSON.parse(String(result.content?.[0]?.text ?? '{}'))
    }
    const ok = (r, n) => { if (r?.status !== 'completed') throw new Error(n + ' :: ' + JSON.stringify(r?.error)); return r.data }
    const created = ok(await call('project.create', { name: '分组探针' }), 'create')
    const projectId = created.meta.id
    ok(await call('project.open', { projectId }), 'open')
    await new Promise((d) => setTimeout(d, 1500))
    const patch = await call('graph.patch', {
      projectId,
      expectedGraphVersion: (await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 1 })).data.graphVersion,
      ops: [
        { action: 'node.create', ref: 'a', nodeType: 'text', x: 0, y: 0, title: 'A' },
        { action: 'node.create', ref: 'b', nodeType: 'text', x: 400, y: 0, title: 'B' }
      ]
    })
    console.log('建节点:', patch.status)
    const nodeIds = (ok(patch, 'patch').created ?? []).map((entry) => entry.nodeId)
    await new Promise((d) => setTimeout(d, 1200))
    const version = (await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 1 })).data.graphVersion
    const grouped = await call('graph.patch', { projectId, expectedGraphVersion: version, ops: [{ action: 'group.create', nodeIds, ref: 'g1' }] })
    console.log('group.create 原始回执:', JSON.stringify(grouped).slice(0, 600))
    const graph = ok(await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 5 }), 'get')
    console.log('graph.get groups:', JSON.stringify(graph.groups ?? []).slice(0, 300))
  } finally {
    try { if (client) await client.close() } catch {}
    try { if (app) await app.close() } catch {}
    await rm(directory, { recursive: true, force: true })
  }
}
main()
