/**
 * MCP 验收 · 第 2/3/7/8 族：媒体、传输、历史快照、诊断与工作区。
 *
 * 真实 MCP 协议栈 + 真实桌面会话，跑完整链路并校验**副作用真实发生**。
 * 遇到需要前置数据/模型/付费的操作，记录"稳定业务错误码"作为"接线正确但缺前置"，
 * 只有异常/超时/纯文本错误/假的 completed 才算失败。
 */
const { _electron } = require('playwright')
const { cp, mkdir, mkdtemp, readFile, writeFile, rm, readdir, stat } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { resolve, join, basename } = require('node:path')
const { tmpdir, homedir } = require('node:os')
const { randomUUID, createHash } = require('node:crypto')
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
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'license-current.json'))) return candidate
  }
  return candidates[0]
})()

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-accept-f2378-'))
  const evidence = join(appRoot, 'qa', 'local-agent-access', 'families-02-03-07-08')
  await mkdir(evidence, { recursive: true })
  const report = { families: {}, startedAt: new Date().toISOString(), failures: [], notes: [], found: [] }
  let failed = 0
  const section = (family) => {
    report.families[family] = report.families[family] ?? []
    return {
      check: async (name, fn) => {
        try {
          const detail = await fn()
          report.families[family].push({ name, ok: true, ...(detail ? { detail } : {}) })
          return detail
        } catch (error) {
          failed += 1
          const message = error instanceof Error ? error.message : String(error)
          report.families[family].push({ name, ok: false, detail: message.slice(0, 400) })
          report.failures.push({ family, name, detail: message.slice(0, 600) })
          return null
        }
      }
    }
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  /** 允许"业务拒绝"：记录为已接通但缺前置，不算失败。 */
  const allowBusiness = (response, allowed, name) => {
    if (response?.status === 'completed') return { completed: true }
    const code = response?.error?.code ?? ''
    expect(typeof code === 'string' && !code.startsWith('PLAIN_TEXT:'), `${name}: 协议层纯文本错误 ${code}`)
    expect(allowed.includes(code), `${name}: 非预期错误码 ${code}（${response?.error?.phase ?? ''}）`)
    report.notes.push(`${name}: 按预期返回 ${code}（缺前置数据，已接通）`)
    return { code }
  }

  let app
  let client
  try {
    await cp(licensedSecurityDir, join(directory, 'security'), { recursive: true })
    const env = { ...process.env, CANVAS_DATA_DIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: electron, args: [appRoot, '--local-agent-access'], env })
    await app.firstWindow().then((page) => page.waitForLoadState().catch(() => undefined))
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] MCP Acceptance 2/3/7/8')
    })
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
    client = new Client({ name: 'accept-2378', version: '1.0.0' }, { capabilities: {} })
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
      expect(response?.status === 'completed', `${name} :: ${JSON.stringify(response?.error ?? response).slice(0, 260)}`)
      return response.data
    }
    const version = async (projectId) => {
      let previous = -1
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 1 })
        const value = response?.status === 'completed' ? response.data?.graphVersion : undefined
        const unsaved = response?.status === 'completed' ? response.data?.unsaved : undefined
        // 版本相等且没有未保存改动才算稳定；首次读到 0 也允许（新项目）
        if (Number.isInteger(value) && value === previous && unsaved === false) return value
        previous = Number.isInteger(value) ? value : previous
        await new Promise((done) => setTimeout(done, 800))
      }
      return previous
    }
    /**
     * 写操作 + 版本冲突重试：冲突时从 detail 里取服务端报告的 current 版本立即重试。
     * 保存屏障会在握手前推进版本，这是外部串接写的必需品。
     */
    const writeWithVersionRetry = async (operationId, buildInput) => {
      let graphVersion = await version(projectId)
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

    // ── 准备：一个带媒体的项目 ──
    const project = ok(await call('project.create', { name: '族2-3 验收项目' }), 'project.create')
    const projectId = project.meta.id
    ok(await call('project.open', { projectId }), 'project.open')
    let graphVersion = await version(projectId)

    // ========== 第 2 族：媒体 ==========
    const media = section('family-2-media')
    const sourceImage = join(directory, 'acceptance-sample.png')
    await writeFile(
      sourceImage,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gAB3x0dAAAAAElFTkSuQmCC',
        'base64'
      )
    )
    const imported = await media.check('media.import 导入真实文件', async () => {
      const data = ok(await call('media.import', { projectId, filePath: sourceImage }), 'media.import')
      expect(data?.asset?.id || data?.mediaId, '回执缺媒体 ID')
      return { mediaId: data.asset?.id ?? data.mediaId, kind: data.asset?.kind }
    })
    const mediaId = imported?.mediaId
    await media.check('media.list 含新导入媒体', async () => {
      const data = ok(await call('media.list', { projectId, limit: 50 }), 'media.list')
      const items = data?.items ?? []
      expect(items.some((item) => item.mediaId === mediaId), '列表里找不到导入的媒体')
      return { total: items.length }
    })
    await media.check('media.getRecipe 导入件无生成来源（found=false）', async () => {
      const data = ok(await call('media.getRecipe', { projectId, mediaId }), 'media.getRecipe')
      expect(data.found === false, '导入件不应有生成来源')
      return { found: false }
    })
    await media.check('media.batchExport 落到受控目录且逐项回执', async () => {
      const data = ok(await call('media.batchExport', { projectId }), 'media.batchExport')
      expect(data.exported >= 1, `导出数=${data.exported}`)
      const dir = join(directory, 'agent-exports', data.directoryName)
      for (const file of data.files) {
        const target = join(dir, file.fileName)
        expect(existsSync(target), `${file.fileName} 未落盘`)
        const size = (await stat(target)).size
        expect(size === file.byteSize, `${file.fileName} 字节数不符`)
      }
      return { exported: data.exported, failed: data.failed }
    })
    await media.check('media.delete 删除后列表里消失', async () => {
      ok(await call('media.delete', { projectId, mediaId }), 'media.delete')
      const data = ok(await call('media.list', { projectId, limit: 50 }), 'media.list after delete')
      const items = data?.items ?? []
      expect(!items.some((item) => item.mediaId === mediaId), '删除后仍在列表')
      return {}
    })
    let exportedBundle = null
    await media.check('project.export 项目包导出（文件名/字节数/哈希自洽）', async () => {
      const data = ok(
        await call('project.export', {
          projectId,
          expectedGraphVersion: graphVersion,
          fileName: 'accept.canvasbundle'
        }),
        'project.export'
      )
      const name = data.fileName ?? String(data.path ?? '').split(/[\\/]/).pop()
      const target = join(directory, 'agent-exports', name)
      expect(existsSync(target), '导出文件不存在')
      const bytes = await readFile(target)
      expect(bytes.length === data.byteSize, '字节数与回执不符')
      if (data.sha256) {
        expect(createHash('sha256').update(bytes).digest('hex') === data.sha256, 'sha256 与文件不符')
      }
      exportedBundle = name
      return { fileName: name, byteSize: data.byteSize }
    })

    // ========== 第 3 族：传输 ==========
    const transfer = section('family-3-transfer')
    await transfer.check('project.exportStructure（无快照时给明确码）', async () => {
      const response = await call('project.exportStructure', {
        projectId,
        fileName: 'accept.canvasflow'
      })
      if (response?.status === 'completed') return { nodeCount: response.data.nodeCount }
      expect(
        response?.error?.code === 'STRUCTURE_SNAPSHOT_MISSING',
        `原因不明确：${JSON.stringify(response?.error)}`
      )
      report.notes.push('project.exportStructure: 未由 GUI 保存过画布快照时返回 STRUCTURE_SNAPSHOT_MISSING（诚实拒绝）')
      return { code: 'STRUCTURE_SNAPSHOT_MISSING' }
    })
    await transfer.check('project.import 导入刚导出的项目包（媒体重映射）', async () => {
      expect(exportedBundle, '缺少导出的项目包')
      const data = ok(
        await call('project.import', { filePath: exportedBundle }),
        'project.import'
      )
      expect(data?.meta?.id, '导入回执缺项目 ID')
      expect(data.committed === true, 'import 未提交')
      const list = ok(await call('project.list', { limit: 50 }), 'project.list after import')
      const items = list?.projects ?? []
      expect(items.some((item) => item.id === data.meta.id), '导入的项目不在列表里')
      return { importedProjectId: data.meta.id, mediaCount: data.mediaCount }
    })
    await transfer.check('project.import 拒绝目录外路径', async () => {
      const response = await call('project.import', { filePath: join(directory, '..', 'escape.canvasbundle') })
      expect(response?.status === 'failed', '越界路径不应成功')
      expect(['PATH_NOT_ALLOWED', 'INPUT_NOT_FOUND'].includes(response.error?.code), `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })
    await transfer.check('project.importStructure 拒绝目录外路径', async () => {
      const response = await call('project.importStructure', { filePath: '/tmp/evil.canvasflow' })
      expect(response?.status === 'failed', '越界路径不应成功')
      expect(['PATH_NOT_ALLOWED', 'INPUT_NOT_FOUND'].includes(response.error?.code), `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    // ========== 第 7 族：历史快照 ==========
    const history = section('family-7-history')
    // 造一次编辑，保证有可快照的内容
    ok(
      await writeWithVersionRetry('graph.patch', (version) => ({
        projectId,
        expectedGraphVersion: version,
        ops: [{ action: 'node.create', ref: 'n1', nodeType: 'text', x: 0, y: 0, title: '快照节点' }]
      })),
      'graph.patch for snapshot'
    )
    graphVersion = await version(projectId)
    const snapshot = await history.check('history.snapshot.create', async () => {
      const data = ok(
        await writeWithVersionRetry('history.snapshot.create', (version) => ({
          projectId,
          expectedGraphVersion: version,
          label: '验收快照'
        })),
        'history.snapshot.create'
      )
      const id = data?.snapshotId ?? data?.id
      expect(id, '回执缺快照 ID')
      return { snapshotId: id }
    })
    await history.check('history.list 含新快照', async () => {
      const data = ok(await call('history.list', { projectId, limit: 50 }), 'history.list')
      const items = data?.items ?? data?.snapshots ?? []
      expect(items.some((item) => item.snapshotId === snapshot?.snapshotId), '列表里找不到快照')
      return { total: items.length }
    })
    await history.check('history.restore.precheck', async () => {
      const response = await call('history.restore.precheck', {
        projectId,
        snapshotId: snapshot?.snapshotId
      })
      if (response?.status === 'completed') return { ok: true }
      allowBusiness(response, ['SNAPSHOT_NOT_FOUND', 'NOT_FOUND', 'RESTORE_BLOCKED', 'PROJECT_NOT_OPEN'], 'history.restore.precheck')
      return { code: response.error.code }
    })
    await history.check('history.recovery.precheck', async () => {
      // decision 是必填：除非给决策，否则应被 Schema 拒（先验证这一点，再给合法值）
      const missing = await call('history.recovery.precheck', { projectId })
      expect(
        missing?.status === 'failed' && missing.error?.code === 'INVALID_INPUT',
        '缺 decision 时未按预期被 Schema 拒绝'
      )
      const response = await call('history.recovery.precheck', { projectId, decision: 'discard' })
      if (response?.status === 'completed') return { ok: true }
      allowBusiness(response, ['NOT_FOUND', 'PROJECT_NOT_OPEN', 'NO_RECOVERY_AVAILABLE'], 'history.recovery.precheck')
      return { code: response.error.code }
    })
    await history.check('history.snapshot.delete 删除后消失', async () => {
      ok(await call('history.snapshot.delete', { projectId, snapshotId: snapshot?.snapshotId }), 'snapshot.delete')
      const data = ok(await call('history.list', { projectId, limit: 50 }), 'history.list after delete')
      const items = data?.items ?? data?.snapshots ?? []
      expect(!items.some((item) => item.snapshotId === snapshot?.snapshotId), '删除后快照仍在')
      return {}
    })

    // ========== 第 8 族：诊断与工作区 ==========
    const diag = section('family-8-diagnostics-workspace')
    await diag.check('app.status', async () => {
      const data = ok(await call('app.status', {}), 'app.status')
      expect(data?.instanceId || data?.version, '回执缺基础状态')
      return { version: data.version }
    })
    await diag.check('capability.list 操作数与门禁一致（133）', async () => {
      const data = ok(await call('capability.list', {}), 'capability.list')
      const operations = data?.operations ?? []
      expect(operations.length === 133, `操作数=${operations.length}`)
      return { operations: operations.length }
    })
    await diag.check('node.type.list 返回 32 类节点', async () => {
      const data = ok(await call('node.type.list', {}), 'node.type.list')
      const nodes = data?.nodes ?? []
      expect(nodes.length === 32, `节点类型数=${nodes.length}`)
      return { nodes: nodes.length }
    })
    await diag.check('node.type.get 读契约', async () => {
      const data = ok(await call('node.type.get', { typeId: 'text' }), 'node.type.get')
      expect(data?.ports || data?.nodeType === 'text', '回执缺端口/类型')
      return { nodeType: data.nodeType ?? 'text' }
    })
    await diag.check('workspace.palettePreferences 读→写→读回', async () => {
      const before = ok(await call('workspace.palettePreferences.get', {}), 'palette get')
      const order = before.order ?? []
      const data = ok(
        await call('workspace.palettePreferences.save', { order, labels: { image: '图片' } }),
        'palette save'
      )
      const after = ok(await call('workspace.palettePreferences.get', {}), 'palette get after save')
      expect(after.labels?.image === '图片', '名称覆盖未生效')
      return { changed: data.changed }
    })
    await diag.check('diagnostics.query', async () => {
      const data = ok(await call('diagnostics.query', { limit: 20 }), 'diagnostics.query')
      expect(Array.isArray(data.events), '事件不是数组')
      return { events: data.events.length, source: data.source }
    })
    await diag.check('diagnostics.summary', async () => {
      const response = await call('diagnostics.summary', {})
      if (response?.status === 'completed') return { ok: true }
      allowBusiness(response, ['STORAGE_UNAVAILABLE', 'DIAGNOSTICS_UNAVAILABLE'], 'diagnostics.summary')
      return { code: response.error.code }
    })
    await diag.check('diagnostics.exportBundle 受控目录 + 指纹自洽', async () => {
      const since = Date.now() - 24 * 60 * 60 * 1000
      const data = ok(
        await call('diagnostics.exportBundle', { since, label: '验收导出' }),
        'diagnostics.exportBundle'
      )
      const target = join(directory, 'agent-exports', data.fileName)
      expect(existsSync(target), '诊断包不存在')
      const bytes = await readFile(target)
      expect(bytes.length === data.byteSize, '字节数不符')
      expect(createHash('sha256').update(bytes).digest('hex') === data.sha256, 'sha256 不符')
      return { byteSize: data.byteSize, totalEvents: data.totalEvents }
    })
    await diag.check('diagnostics.exportBundle 拒绝空范围', async () => {
      const response = await call('diagnostics.exportBundle', {})
      expect(response?.status === 'failed', '空范围不应成功')
      expect(response.error?.code === 'INVALID_INPUT', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })
  } catch (error) {
    failed += 1
    report.failures.push({ family: 'setup', name: '脚本整体执行', detail: String(error).slice(0, 800) })
  } finally {
    report.finishedAt = new Date().toISOString()
    const all = Object.values(report.families).flat()
    report.total = all.length
    report.passed = all.filter((entry) => entry.ok).length
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
    console.log(`\n族 2/3/7/8 验收：步骤=${report.total} 通过=${report.passed} 失败=${report.failed}`)
    for (const [family, entries] of Object.entries(report.families)) {
      console.log(`  ${family}: ${entries.filter((e) => e.ok).length}/${entries.length}`)
    }
    for (const failure of report.failures.slice(0, 20)) console.log('  FAIL ' + failure.family + ' / ' + failure.name + ' :: ' + failure.detail)
    for (const note of report.notes) console.log('  NOTE ' + note)
    console.log('报告：qa/local-agent-access/families-02-03-07-08/report.json')
    process.exit(report.failed === 0 ? 0 : 1)
  }
}

main()
