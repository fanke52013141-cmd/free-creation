/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, no-empty */
/**
 * MCP 验收 · 补齐最后 10 项（前几族未触及的操作）。
 *
 * 覆盖：skill.install、library.create_resource（别名）、library.resource.preview_files、
 * library.resource.delete、library.folder.delete、library.category.save、history.restore、
 * history.recovery.resolve、flowAgent.build.commit、model.definition.delete。
 *
 * 判定沿用前几族：completed 或"稳定业务码（缺前置/需参数）"都算接通；
 * 异常/超时/纯文本错误才算失败。
 */
const { _electron } = require('playwright')
const { cp, mkdir, mkdtemp, readFile, writeFile, rm } = require('node:fs/promises')
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
  const directory = await mkdtemp(join(tmpdir(), 'canvas-accept-gap-'))
  const evidence = join(appRoot, 'qa', 'local-agent-access', 'families-gap-fill')
  await mkdir(evidence, { recursive: true })
  const report = { steps: [], failures: [], notes: [], codes: {} }
  let failed = 0
  const step = async (name, fn) => {
    try {
      const detail = await fn()
      report.steps.push({ name, ok: true, ...(detail ? { detail } : {}) })
      return detail
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : String(error)
      report.steps.push({ name, ok: false, detail: message.slice(0, 400) })
      report.failures.push({ name, detail: message.slice(0, 600) })
      return null
    }
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }

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
    client = new Client({ name: 'accept-gap', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    const call = async (operationId, input) => {
      const result = await client.callTool({
        name: operationId.replaceAll('.', '_'),
        arguments: { input, idempotencyKey: key() }
      })
      if (result.structuredContent) return result.structuredContent
      const text = String(result.content?.[0]?.text ?? '{}')
      try {
        return JSON.parse(text)
      } catch {
        return { status: 'failed', error: { code: 'PLAIN_TEXT:' + text.slice(0, 60) } }
      }
    }
    const ok = (response, name) => {
      expect(response?.status === 'completed', `${name} :: ${JSON.stringify(response?.error ?? response).slice(0, 240)}`)
      return response.data
    }
    const wire = (response, name) => {
      if (response?.status === 'completed') return { completed: true, data: response.data }
      const code = response?.error?.code ?? ''
      expect(!String(code).startsWith('PLAIN_TEXT:'), `${name}: 协议层纯文本错误`)
      expect(response?.status === 'failed' || response?.status === 'unknown', `${name}: 异常状态 ${response?.status}`)
      report.codes[code] = (report.codes[code] ?? 0) + 1
      return { code, status: response.status }
    }

    const project = ok(await call('project.create', { name: '补齐验收项目' }), 'project.create')
    const projectId = project.meta.id
    ok(await call('project.open', { projectId }), 'project.open')
    let graphVersion = 0
    const version = async () => {
      let previous = -1
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 1 })
        const value = response?.data?.graphVersion
        const unsaved = response?.data?.unsaved
        if (Number.isInteger(value) && value === previous && unsaved === false) return value
        previous = Number.isInteger(value) ? value : previous
        await new Promise((done) => setTimeout(done, 700))
      }
      return previous
    }
    const writeRetry = async (operationId, buildInput) => {
      graphVersion = await version()
      let response = await call(operationId, buildInput(graphVersion))
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (response?.error?.code !== 'REVISION_CONFLICT') return response
        const reported = /current\s+(\d+)/.exec(String(response.error.detail ?? ''))
        if (!reported) return response
        graphVersion = Number(reported[1])
        response = await call(operationId, buildInput(graphVersion))
      }
      return response
    }

    // library.create_resource（别名）
    const resource = await step('library.create_resource（旧别名）', async () => {
      const response = await call('library.create_resource', {
        title: '补齐资源',
        formPreset: 'prompt',
        components: [{ role: 'prompt', valueType: 'text', text: '补齐正文' }]
      })
      const result = wire(response, 'library.create_resource')
      const id = response?.status === 'completed' ? (response.data.resourceId ?? response.data.id) : undefined
      return { ...result, resourceId: id }
    })
    const resourceId = resource?.resourceId

    await step('library.resource.preview_files', async () => {
      const response = await call('library.resource.preview_files', { resourceId })
      return wire(response, 'preview_files')
    })
    await step('library.category.save', async () => {
      const response = await call('library.category.save', {
        id: 'acc-category',
        name: '补齐分类',
        version: 1,
        blueprint: { fields: [] }
      })
      return wire(response, 'category.save')
    })
    const folder = await step('library.folder.create（为删除做准备）', async () => {
      const response = await call('library.folder.create', { name: '待删文件夹' })
      if (response?.status !== 'completed') return wire(response, 'folder.create')
      return { folderId: response.data.folderId }
    })
    await step('library.folder.delete', async () => {
      const response = await call('library.folder.delete', { folderId: folder?.folderId })
      return wire(response, 'folder.delete')
    })
    await step('library.resource.delete（单删）', async () => {
      const response = await call('library.resource.delete', { resourceId })
      return wire(response, 'resource.delete')
    })

    // 历史：建快照 → 真恢复 → 删快照
    ok(
      await writeRetry('graph.patch', (version) => ({
        projectId,
        expectedGraphVersion: version,
        ops: [{ action: 'node.create', ref: 'gap', nodeType: 'text', x: 0, y: 0, title: '补齐节点' }]
      })),
      'graph.patch for restore'
    )
    graphVersion = await version()
    const snapshot = await step('history.snapshot.create（为恢复做准备）', async () => {
      const response = await writeRetry('history.snapshot.create', (version) => ({
        projectId,
        expectedGraphVersion: version,
        label: '补齐快照'
      }))
      if (response?.status !== 'completed') return wire(response, 'snapshot.create')
      return { snapshotId: response.data.snapshotId ?? response.data.id }
    })
    await step('history.restore（真实恢复）', async () => {
      const response = await writeRetry('history.restore', (version) => ({
        projectId,
        expectedGraphVersion: version,
        snapshotId: snapshot?.snapshotId
      }))
      return wire(response, 'history.restore')
    })
    await step('history.recovery.resolve', async () => {
      const response = await call('history.recovery.resolve', {
        projectId,
        decision: 'discard',
        expectedGraphVersion: graphVersion
      })
      return wire(response, 'recovery.resolve')
    })

    // 模型定义单删
    await step('model.definition.delete（单删）', async () => {
      ok(
        await call('model.connection.save', {
          id: 'gap-conn',
          name: '补齐连接',
          protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-gap-fake-key-0002'
        }),
        'connection.save'
      )
      ok(
        await call('model.definition.save', {
          id: 'gap-model',
          connectionId: 'gap-conn',
          name: '补齐模型',
          modelId: 'gap-upstream',
          capabilities: [
            {
              operation: 'text.generate',
              asynchronous: false,
              streaming: false,
              acceptedAssetKinds: [],
              producedAssetKinds: [],
              controls: {}
            }
          ]
        }),
        'definition.save'
      )
      const response = await call('model.definition.delete', { id: 'gap-model' })
      const result = wire(response, 'definition.delete')
      wire(await call('model.connection.delete', { connectionId: 'gap-conn' }), 'connection.delete')
      return result
    })

    // Flow 建图提交（无预览时应给稳定码）
    await step('flowAgent.build.commit（无预览应稳定拒绝）', async () => {
      const graph = ok(await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 5 }), 'graph.get')
      const nodeId = (graph.nodes ?? [])[0]?.nodeId
      expect(nodeId, '缺少节点')
      const response = await call('flowAgent.build.commit', {
        projectId,
        nodeId,
        buildId: 'missing-build'
      })
      return wire(response, 'build.commit')
    })

    // 技能安装（无包源应稳定拒绝）
    await step('skill.install（无包源应稳定拒绝）', async () => {
      const response = await call('skill.install', { packagePath: '/nonexistent/skill.zip' })
      return wire(response, 'skill.install')
    })
  } catch (error) {
    failed += 1
    report.failures.push({ name: '脚本整体执行', detail: String(error).slice(0, 800) })
  } finally {
    report.total = report.steps.length
    report.passed = report.steps.filter((entry) => entry.ok).length
    report.failed = failed
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
    try {
      if (client) await client.close()
    } catch {}
    try {
      if (app) await app.close()
    } catch {}
    try {
      await rm(directory, { recursive: true, force: true })
    } catch {}
    console.log(`\n补齐验收：步骤=${report.total} 通过=${report.passed} 失败=${report.failed}`)
    for (const failure of report.failures.slice(0, 12)) console.log('  FAIL ' + failure.name + ' :: ' + failure.detail)
    for (const note of report.notes) console.log('  NOTE ' + note)
    console.log(' 业务码：' + JSON.stringify(report.codes))
    process.exit(report.failed === 0 ? 0 : 1)
  }
}

main()
