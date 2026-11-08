/**
 * 验证 ABC 三组优化是否真的生效（真实 MCP 协议栈）。
 *
 * 逐条对应优化项：
 * A1 结构化 currentGraphVersion：制造一次版本冲突，断言 error.currentGraphVersion 是数字
 * A2 组合可解组：group.create 回执给 groupId，随后 group.delete 能成功
 * A3 cooperate 稳定码：无任务节点返回 AGENT_TASK_MISSING（不再 unknown）
 * A4 契约 required 与实际一致：有默认值的字段不再出现在 required 里
 * B6 前置条件自描述：capability.list 的操作带 requires
 * B7 错误码目录：capability.list 带 errorCatalog
 * B8 INVALID_INPUT 带原因：detail 含字段路径 + 原因（不只是字段名）
 * C10 recovery.precheck 不传 decision 也能读事实
 * C11 media.list 带 id 别名与 hasRecipe
 * C9 结构包导出自动补保存屏障（不再需要先人工打开保存）
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
  const directory = await mkdtemp(join(tmpdir(), 'canvas-opt-verify-'))
  const evidence = join(appRoot, 'qa', 'local-agent-access', 'optimizations-abc')
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
    client = new Client({ name: 'opt-verify', version: '1.0.0' }, { capabilities: {} })
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
    const version = async (projectId) => {
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

    const created = ok(await call('project.create', { name: '优化验证项目' }), 'project.create')
    const projectId = created.meta.id
    ok(await call('project.open', { projectId }), 'project.open')
    const graphVersion = await version(projectId)

    // A4：契约 required 与实际一致
    await check('A4 有默认值的字段不再出现在 required', async () => {
      const contracts = JSON.parse(
        require('node:child_process').execFileSync(
          electron,
          [cliPath, 'contracts', '--data-dir', directory],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }
        )
      )
      const graphGet = contracts.operations.find((entry) => entry.operationId === 'graph.get')
      const required = graphGet.inputSchema.required ?? []
      const offenders = required.filter((field) => {
        const property = graphGet.inputSchema.properties?.[field]
        return property && 'default' in property
      })
      expect(offenders.length === 0, `仍有默认值字段被标必填：${offenders.join(',')}`)
      const anyDefaulted = Object.entries(graphGet.inputSchema.properties ?? {}).filter(
        ([, property]) => property && 'default' in property
      ).length
      return { required, defaultedFields: anyDefaulted }
    })

    // B6/B7：前置条件 + 错误码目录
    await check('B6/B7 capability.list 带 requires 与 errorCatalog', async () => {
      const data = ok(await call('capability.list', {}), 'capability.list')
      expect(Array.isArray(data.errorCatalog) && data.errorCatalog.length > 10, '缺少 errorCatalog')
      const withRequires = (data.operations ?? []).filter(
        (operation) => Array.isArray(operation.requires) && operation.requires.length > 0
      )
      expect(withRequires.length > 30, `带前置条件的操作过少：${withRequires.length}`)
      const sample = withRequires.find((operation) => operation.operationId === 'node.library.save')
      expect(sample?.requires?.includes('chatNode'), 'node.library.save 未标注 chatNode 前置')
      return {
        errorCodes: data.errorCatalog.length,
        operationsWithRequires: withRequires.length,
        nodeLibrarySave: sample.requires
      }
    })

    // A1：结构化 currentGraphVersion
    await check('A1 版本冲突返回结构化 currentGraphVersion', async () => {
      const stale = 999999
      const response = await call('graph.patch', {
        projectId,
        expectedGraphVersion: stale,
        ops: [{ action: 'node.create', nodeType: 'text', x: 0, y: 0, title: '冲突节点' }]
      })
      expect(response?.status === 'failed', `未按预期失败：${response?.status}`)
      expect(response.error?.code === 'REVISION_CONFLICT', `错误码=${response.error?.code}`)
      expect(
        Number.isInteger(response.error?.currentGraphVersion),
        `未返回结构化版本：${JSON.stringify(response.error)}`
      )
      // 用返回的版本直接重试应成功
      const retry = await call('graph.patch', {
        projectId,
        expectedGraphVersion: response.error.currentGraphVersion,
        ops: [{ action: 'node.create', nodeType: 'text', x: 200, y: 0, title: '重试节点' }]
      })
      ok(retry, '用 currentGraphVersion 重试')
      return { currentGraphVersion: response.error.currentGraphVersion }
    })

    // B8：INVALID_INPUT 带原因
    await check('B8 INVALID_INPUT 的 detail 含字段与原因', async () => {
      const response = await call('graph.patch', { projectId, expectedGraphVersion: 1, ops: [] })
      expect(response?.status === 'failed', '空 ops 未被拒')
      const detail = String(response.error?.detail ?? '')
      expect(detail.includes('ops'), `detail 未指出字段：${detail}`)
      expect(detail.length > String('ops').length, `detail 未给出原因：${detail}`)
      return { detail }
    })

    // A2：组合可解组
    await check('A2 group.create 回传 groupId，可据此解组', async () => {
      let graph = ok(await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 10 }), 'graph.get')
      // 保证至少两个节点（前面的用例只建了一个）
      for (let index = (graph.nodes ?? []).length; index < 2; index += 1) {
        const current = await version(projectId)
        const added = await call('graph.patch', {
          projectId,
          expectedGraphVersion: current,
          ops: [{ action: 'node.create', nodeType: 'text', x: 400 + index * 200, y: 0, title: 'A2 节点 ' + index }]
        })
        if (added?.error?.code === 'REVISION_CONFLICT') {
          await call('graph.patch', {
            projectId,
            expectedGraphVersion: added.error.currentGraphVersion,
            ops: [{ action: 'node.create', nodeType: 'text', x: 400 + index * 200, y: 0, title: 'A2 节点 ' + index }]
          })
        }
        graph = ok(await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 10 }), 'graph.get backfill')
      }
      const nodeIds = (graph.nodes ?? []).slice(0, 2).map((node) => node.nodeId)
      expect(nodeIds.length >= 2, '节点不足两个')
      const current = await version(projectId)
      const grouped = await call('graph.patch', {
        projectId,
        expectedGraphVersion: current,
        ops: [{ action: 'group.create', nodeIds, ref: 'g1' }]
      })
      if (grouped?.error?.code === 'REVISION_CONFLICT') {
        const retry = await call('graph.patch', {
          projectId,
          expectedGraphVersion: grouped.error.currentGraphVersion,
          ops: [{ action: 'group.create', nodeIds, ref: 'g1' }]
        })
        ok(retry, 'group.create 重试')
        expect(Array.isArray(retry.data.groups) && retry.data.groups[0]?.groupId, '回执没有 groups/groupId')
      } else {
        ok(grouped, 'group.create')
        expect(Array.isArray(grouped.data.groups) && grouped.data.groups[0]?.groupId, '回执没有 groups/groupId')
      }
      // 组合是异步落盘的：轮询几次再断言（最多 6 次 × 600ms）
      let groups = []
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((done) => setTimeout(done, 600))
        const list = ok(
          await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 10 }),
          'graph.get after group'
        )
        groups = list.groups ?? []
        if (groups.length >= 1) break
      }
      expect(groups.length >= 1, '画布里看不到 group')
      const groupId = groups[0].groupId ?? groups[0].id
      const currentAfter = await version(projectId)
      const removed = await call('graph.patch', {
        projectId,
        expectedGraphVersion: currentAfter,
        ops: [{ action: 'group.delete', groupId }]
      })
      ok(removed, 'group.delete')
      const afterUngroup = ok(await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 10 }), 'graph.get after ungroup')
      expect((afterUngroup.groups ?? []).length === 0, '解组后仍有 group')
      return { groupId }
    })

    // C11：media.list 的 id 别名与 hasRecipe
    await check('C11 media.list 条目带 id 与 hasRecipe', async () => {
      const source = join(directory, 'opt.png')
      await writeFile(
        source,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gAB3x0dAAAAAElFTkSuQmCC',
          'base64'
        )
      )
      ok(await call('media.import', { projectId, filePath: source }), 'media.import')
      const data = ok(await call('media.list', { projectId, limit: 10 }), 'media.list')
      const item = (data.items ?? [])[0]
      expect(item, '没有媒体条目')
      expect(typeof item.id === 'string' && item.id === item.mediaId, 'id 别名缺失或不等于 mediaId')
      expect(typeof item.hasRecipe === 'boolean', 'hasRecipe 缺失')
      return { id: item.id, hasRecipe: item.hasRecipe }
    })

    // C10：recovery.precheck 不传 decision
    await check('C10 recovery.precheck 不传 decision 也能读事实', async () => {
      const response = await call('history.recovery.precheck', { projectId })
      expect(response?.status === 'completed' || response?.status === 'failed', `异常状态 ${response?.status}`)
      if (response.status === 'completed') {
        expect(response.data.requiresDecision === true || response.data.exists === false, '未标记 requiresDecision')
        return { requiresDecision: response.data.requiresDecision, exists: response.data.exists }
      }
      expect(['ACTIVE_PROJECT_REQUIRED', 'NOT_FOUND'].includes(response.error?.code), `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    // A3：cooperate 稳定码
    await check('A3 cooperate 缺任务返回 AGENT_TASK_MISSING', async () => {
      const patched = await call('graph.patch', {
        projectId,
        expectedGraphVersion: await version(projectId),
        ops: [{ action: 'node.create', ref: 'agent', nodeType: 'agent', x: 0, y: 300, title: 'Agent 节点' }]
      })
      const data = ok(patched, 'graph.patch agent node')
      const agentNodeId = (data.created ?? [])[0]?.nodeId
      expect(agentNodeId, '缺少 Agent 节点 ID')
      const response = await call('flowAgent.cooperate', {
        projectId,
        nodeId: agentNodeId,
        taskId: 'missing-task',
        waitRevision: 0,
        revision: 0,
        eventId: 'opt-event-1',
        action: 'note',
        text: '优化验证备注'
      })
      expect(response?.status === 'failed', `状态=${response?.status}（不应是 unknown）`)
      expect(response.error?.code === 'AGENT_TASK_MISSING', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    // C9：结构包导出自动补保存屏障
    await check('C9 exportStructure 自动补保存屏障后可导出', async () => {
      const response = await call('project.exportStructure', {
        projectId,
        fileName: 'opt-verify.canvasflow'
      })
      if (response?.status === 'completed') {
        const target = join(directory, 'agent-exports', response.data.fileName)
        expect(existsSync(target), '结构包未落盘')
        return { nodeCount: response.data.nodeCount }
      }
      // 如果宿主无法生成快照，必须是明确原因，不能是模糊错误
      expect(
        response?.error?.code === 'STRUCTURE_SNAPSHOT_MISSING',
        `错误码=${response?.error?.code}`
      )
      throw new Error('结构包仍然无法导出（保存屏障未生效）：' + JSON.stringify(response.error))
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
      if (app) await app.close()
    } catch {}
    try {
      await rm(directory, { recursive: true, force: true })
    } catch {}
    console.log(`\nABC 优化验证：检查=${report.total} 通过=${report.passed} 失败=${report.failed}`)
    for (const failure of report.failures.slice(0, 15)) console.log('  FAIL ' + failure.name + ' :: ' + failure.detail)
    console.log('报告：qa/local-agent-access/optimizations-abc/report.json')
    process.exit(report.failed === 0 ? 0 : 1)
  }
}

main()
