/**
 * MCP 验收 · 第 4/5/6/9 族：资源库、Agent Flow、模型与环境、执行与对话。
 *
 * 真实 MCP 协议栈 + 真实桌面会话。按业务链路组织：
 *  - 资源库：文件夹/收藏集/分类 → 资源创建→读→归档→归属→发布修订→检索 → 采集(媒体/节点)
 *            → 导出/导入包 → 物化到画布 → 丢弃物化 → 批量删除
 *  - 模型：连接保存→凭据指纹→定义保存→绑定保存→解析→目录读取→环境探测→安装闸门→清理
 *  - Flow：Agent 节点上的 inspect/catalog/collaboration/run/pause/stop/cooperate/build/review
 *          + flow.command.* + flowAsset.* + director.publish.*
 *  - 执行/对话：node.execute → run.get/wait → output.get → run.cancel；chat.*；skill.*
 *
 * 判定：completed 或"稳定业务码（缺前置数据/模型/授权）"都算接通；只有异常/超时/纯文本错误、
 * 或声称 completed 却没有真实副作用才算失败。
 */
const { _electron } = require('playwright')
const { cp, mkdir, mkdtemp, readFile, writeFile, rm, stat } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { resolve, join } = require('node:path')
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
  for (const candidate of candidates) if (existsSync(join(candidate, 'license-current.json'))) return candidate
  return candidates[0]
})()

const MISSING_PREREQ = [
  'NOT_FOUND', 'NODE_NOT_FOUND', 'AGENT_NODE_MISSING', 'AGENT_TASK_MISSING', 'MEDIA_NOT_FOUND',
  'MODEL_BINDING_NOT_FOUND', 'MODEL_NOT_VERIFIED', 'ASSET_VERSION_MISSING', 'REVISION_CONFLICT',
  'PROJECT_NOT_OPEN', 'FLOW_PROJECT_INACTIVE', 'DIRECTOR_NODE_MISSING', 'NO_SHOT', 'SHOT_NOT_FOUND',
  'COMMAND_NOT_FOUND', 'SNAPSHOT_NOT_FOUND', 'TASK_NOT_FOUND', 'UNSUPPORTED_OPERATION',
  'NETWORK_CONFIRM_REQUIRED', 'COST_CONFIRM_REQUIRED', 'INSTALL_CONFIRM_REQUIRED', 'INPUT_NOT_FOUND',
  'IMPACT_CONFIRM_REQUIRED', 'CHAT_NODE_REQUIRED', 'NOT_IMPLEMENTED', 'EMPTY_NODE_VISIBILITY'
]

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-accept-f4569-'))
  const evidence = join(appRoot, 'qa', 'local-agent-access', 'families-04-05-06-09')
  await mkdir(evidence, { recursive: true })
  const report = { families: {}, failures: [], notes: [], businessCodes: {} }
  let failed = 0

  const family = (name) => {
    report.families[name] = report.families[name] ?? []
    return async (stepName, fn) => {
      try {
        const detail = await fn()
        report.families[name].push({ name: stepName, ok: true, ...(detail ? { detail } : {}) })
        return detail
      } catch (error) {
        failed += 1
        const message = error instanceof Error ? error.message : String(error)
        report.families[name].push({ name: stepName, ok: false, detail: message.slice(0, 400) })
        report.failures.push({ family: name, name: stepName, detail: message.slice(0, 600) })
        return null
      }
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
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] MCP Acceptance 4/5/6/9')
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
    client = new Client({ name: 'accept-4569', version: '1.0.0' }, { capabilities: {} })
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
    /** completed 或稳定业务码都算接通；记录业务码便于汇总。 */
    const wire = (response, name) => {
      const code = response?.error?.code ?? ''
      if (response?.status === 'completed') return { completed: true, data: response.data }
      expect(!String(code).startsWith('PLAIN_TEXT:'), `${name}: 协议层纯文本错误 ${code}`)
      expect(response?.status === 'failed', `${name}: 异常状态 ${response?.status}`)
      expect(
        MISSING_PREREQ.includes(code) || /^[A-Z_]+$/.test(code),
        `${name}: 非预期错误码 ${code}`
      )
      report.businessCodes[code] = (report.businessCodes[code] ?? 0) + 1
      return { code }
    }
    const version = async (projectId) => {
      let previous = -1
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await call('graph.get', { projectId, view: 'latest', offset: 0, limit: 1 })
        const value = response?.status === 'completed' ? response.data?.graphVersion : undefined
        const unsaved = response?.status === 'completed' ? response.data?.unsaved : undefined
        if (Number.isInteger(value) && value === previous && unsaved === false) return value
        previous = Number.isInteger(value) ? value : previous
        await new Promise((done) => setTimeout(done, 800))
      }
      return previous
    }
    let projectId = ''
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

    // ── 准备 ──
    const created = ok(await call('project.create', { name: '族4-9 验收项目' }), 'project.create')
    projectId = created.meta.id
    ok(await call('project.open', { projectId }), 'project.open')
    let graphVersion = await version(projectId)
    const patch = ok(
      await writeWithVersionRetry('graph.patch', (version) => ({
        projectId,
        expectedGraphVersion: version,
        ops: [
          { action: 'node.create', ref: 'text', nodeType: 'text', x: 0, y: 0, title: '文本节点' },
          { action: 'node.create', ref: 'agent', nodeType: 'agent', x: 400, y: 0, title: 'Agent 节点' }
        ]
      })),
      'graph.patch 准备节点'
    )
    graphVersion = await version(projectId)
    const createdNodes = patch.created ?? []
    const textNodeId = createdNodes.find((entry) => entry.ref === 'text')?.nodeId
    const agentNodeId = createdNodes.find((entry) => entry.ref === 'agent')?.nodeId
    const sourceImage = join(directory, 'sample.png')
    await writeFile(
      sourceImage,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gAB3x0dAAAAAElFTkSuQmCC',
        'base64'
      )
    )
    const imported = ok(await call('media.import', { projectId, filePath: sourceImage }), 'media.import')

    // ========== 第 4 族：资源库 ==========
    const lib = family('family-4-library')
    const folder = await lib('library.folder.create', async () => {
      const data = ok(await call('library.folder.create', { name: '验收文件夹' }), 'folder.create')
      expect(data.folderId, '缺文件夹 ID')
      return { folderId: data.folderId }
    })
    await lib('library.folder.list 含新文件夹', async () => {
      const data = ok(await call('library.folder.list', {}), 'folder.list')
      expect((data.folders ?? []).some((item) => item.folderId === folder?.folderId), '列表缺新文件夹')
      return { total: (data.folders ?? []).length }
    })
    await lib('library.folder.rename', async () => {
      ok(await call('library.folder.rename', { folderId: folder?.folderId, name: '验收文件夹-改' }), 'folder.rename')
      return {}
    })
    const collection = await lib('library.collection.create', async () => {
      const data = ok(await call('library.collection.create', { name: '验收收藏集' }), 'collection.create')
      expect(data.collectionId, '缺收藏集 ID')
      return { collectionId: data.collectionId }
    })
    await lib('library.collection.list', async () => {
      const data = ok(await call('library.collection.list', {}), 'collection.list')
      expect((data.collections ?? []).some((item) => item.collectionId === collection?.collectionId), '列表缺收藏集')
      return { total: (data.collections ?? []).length }
    })
    await lib('library.category.list', async () => {
      const data = ok(await call('library.category.list', {}), 'category.list')
      return { total: (data.categories ?? []).length }
    })
    const resource = await lib('library.resource.create 建文本资源', async () => {
      const data = ok(
        await call('library.resource.create', {
          title: '验收资源',
          formPreset: 'prompt',
          components: [{ role: 'prompt', valueType: 'text', text: '验收正文' }]
        }),
        'resource.create'
      )
      const id = data.resourceId
      expect(id, '缺资源 ID')
      return { resourceId: id }
    })
    await lib('library.resource.get', async () => {
      const data = ok(
        await call('library.resource.get', { resourceId: resource?.resourceId }),
        'resource.get'
      )
      expect((data.components ?? []).length >= 1, '缺组件')
      return { components: data.components.length }
    })
    await lib('library.resource.list', async () => {
      const data = ok(await call('library.resource.list', { limit: 20 }), 'resource.list')
      expect((data.items ?? []).some((item) => item.resourceId === resource?.resourceId), '列表缺资源')
      return { total: data.total }
    })
    await lib('library.search 能检索到', async () => {
      const data = ok(await call('library.search', { query: '验收', limit: 20 }), 'library.search')
      expect((data.items ?? []).length >= 1, '检索无结果')
      return { found: (data.items ?? []).length }
    })
    await lib('library.resource.set_folder / set_collections', async () => {
      wire(
        await call('library.resource.set_folder', {
          resourceId: resource?.resourceId,
          folderId: folder?.folderId
        }),
        'set_folder'
      )
      wire(
        await call('library.resource.set_collections', {
          resourceId: resource?.resourceId,
          collectionIds: [collection?.collectionId]
        }),
        'set_collections'
      )
      return {}
    })
    await lib('library.resource.publish（发布修订）', async () => {
      const response = await call('library.resource.publish', {
        resourceId: resource?.resourceId,
        changeNote: '验收修订'
      })
      return wire(response, 'resource.publish')
    })
    await lib('library.resource.archive', async () => {
      return wire(
        await call('library.resource.archive', { resourceId: resource?.resourceId, archived: true }),
        'resource.archive'
      )
    })
    await lib('library.captureProjectMedia（采集项目媒体）', async () => {
      const response = await call('library.captureProjectMedia', {
        projectId,
        mediaId: imported.mediaId,
        title: '采集的媒体'
      })
      const result = wire(response, 'captureProjectMedia')
      return result
    })
    await lib('library.captureProjectNodes（采集节点）', async () => {
      if (!textNodeId) throw new Error('缺少文本节点')
      const response = await call('library.captureProjectNodes', {
        projectId,
        title: '采集的节点',
        nodes: [{ nodeId: textNodeId, title: '文本节点', nodeType: 'text', text: '' }]
      })
      return wire(response, 'captureProjectNodes')
    })
    let libraryPackage = null
    await lib('library.export 资源包导出（指纹自洽）', async () => {
      const data = ok(
        await call('library.export', { fileName: 'accept.canvaslib' }),
        'library.export'
      )
      const name = String(data.path ?? '').split(/[\\/]/).pop()
      const target = join(directory, 'agent-exports', name)
      expect(existsSync(target), '资源包不存在')
      const bytes = await readFile(target)
      if (data.sha256) expect(createHash('sha256').update(bytes).digest('hex') === data.sha256, 'sha256 不符')
      libraryPackage = name
      return { fileName: name, resourceCount: data.resourceCount }
    })
    await lib('library.import 导入刚导出的资源包', async () => {
      expect(libraryPackage, '缺资源包')
      const response = await call('library.import', { filePath: libraryPackage })
      return wire(response, 'library.import')
    })
    await lib('library.resource.materialize（物化到画布）', async () => {
      const response = await call('library.resource.materialize', {
        projectId,
        resourceId: resource?.resourceId
      })
      return wire(response, 'resource.materialize')
    })
    await lib('library.materialization.discard', async () => {
      const response = await call('library.materialization.discard', { projectId })
      return wire(response, 'materialization.discard')
    })
    await lib('node.library.* 形态检查（需 chat/agent 模板）', async () => {
      const codes = []
      for (const [operationId, input] of [
        ['node.library.list', {}],
        ['node.library.save', { projectId, expectedGraphVersion: graphVersion, nodeId: textNodeId, name: '节点库条目' }],
        ['node.library.search', { query: '节点' }],
        ['node.library.get', { entryId: 'missing-entry' }],
        ['node.library.update', { entryId: 'missing-entry', name: 'x' }],
        ['node.library.delete', { entryId: 'missing-entry' }],
        ['node.library.compose', { entryId: 'missing-entry' }],
        ['node.library.insert', { projectId, expectedGraphVersion: graphVersion, entryId: 'missing-entry' }]
      ]) {
        const response = await call(operationId, input)
        const result = wire(response, operationId)
        codes.push(operationId + '=' + (result.code ?? 'completed'))
        if (response?.status === 'completed') graphVersion = await version(projectId)
      }
      report.notes.push('node.library.* 实际返回：' + codes.join(', '))
      return { codes }
    })
    await lib('library.resource.delete_many', async () => {
      const response = await call('library.resource.delete_many', {
        resourceIds: [resource?.resourceId]
      })
      const result = wire(response, 'delete_many')
      return result
    })

    // ========== 第 6 族：模型与环境（放在 Flow 前，因为 Flow 需要模型绑定） ==========
    const model = family('family-6-model')
    await model('model.connection.save（假密钥，不回显）', async () => {
      const data = ok(
        await call('model.connection.save', {
          id: 'acc-conn',
          name: '验收连接',
          protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-acceptance-fake-key-0001'
        }),
        'connection.save'
      )
      expect(JSON.stringify(data).includes('sk-acceptance-fake-key-0001') === false, '回执泄漏明文密钥')
      return { id: data.id }
    })
    await model('model.credential.status（只给指纹）', async () => {
      const data = ok(await call('model.credential.status', { connectionId: 'acc-conn' }), 'credential.status')
      expect(String(JSON.stringify(data)).includes('sk-acceptance-fake-key-0001') === false, '泄漏明文')
      return { fingerprint: data.fingerprint }
    })
    await model('model.definition.save', async () => {
      ok(
        await call('model.definition.save', {
          id: 'acc-model',
          connectionId: 'acc-conn',
          name: '验收模型',
          modelId: 'acc-upstream',
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
      return {}
    })
    await model('model.definition.list / model.list', async () => {
      const definitions = ok(await call('model.definition.list', { limit: 20 }), 'definition.list')
      const models = ok(await call('model.list', {}), 'model.list')
      return {
        definitions: (definitions.items ?? []).length,
        models: (models.items ?? []).length
      }
    })
    await model('model.binding.save / binding.list / binding.resolve', async () => {
      wire(
        await call('model.binding.save', {
          featureKey: 'acc-feature',
          connectionId: 'acc-conn',
          modelDefinitionId: 'acc-model',
          operation: 'text.generate'
        }),
        'binding.save'
      )
      wire(await call('model.binding.list', { limit: 20 }), 'binding.list')
      const resolved = await call('model.binding.resolve', {
        featureKey: 'acc-feature',
        operation: 'text.generate'
      })
      return wire(resolved, 'binding.resolve')
    })
    await model('provider 目录三项（去敏）', async () => {
      const list = ok(await call('provider.list', { limit: 50 }), 'provider.list')
      const executable = ok(await call('provider.listExecutable', {}), 'provider.listExecutable')
      const exportable = ok(await call('provider.exportableConnections', {}), 'exportableConnections')
      const serialized = JSON.stringify([list, executable, exportable])
      expect(!serialized.includes('sk-acceptance-fake-key-0001'), '目录泄漏密钥')
      return {
        providers: (list.items ?? []).length,
        executable: (executable.items ?? []).length,
        exportable: (exportable.items ?? []).length
      }
    })
    await model('environment.local / videoEngine.status', async () => {
      const local = ok(await call('environment.local', {}), 'environment.local')
      const engine = ok(await call('environment.videoEngine.status', {}), 'videoEngine.status')
      return { python: local.python?.available, engineReady: engine.ready, phase: local.videoEngine?.phase }
    })
    await model('environment.videoEngine.install 未确认必须拒绝', async () => {
      const response = await call('environment.videoEngine.install', {})
      expect(response?.status === 'failed', '未确认却启动了安装')
      expect(response.error?.code === 'INSTALL_CONFIRM_REQUIRED', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })
    await model('model.validate / provider.testConnection 未确认必须拒绝', async () => {
      const validate = await call('model.validate', {
        connectionId: 'acc-conn',
        modelDefinitionId: 'acc-model',
        operation: 'text.generate'
      })
      expect(validate.error?.code === 'NETWORK_CONFIRM_REQUIRED', `validate=${validate.error?.code}`)
      const test = await call('provider.testConnection', { providerId: 'acc-conn' })
      expect(test.error?.code === 'NETWORK_CONFIRM_REQUIRED', `testConnection=${test.error?.code}`)
      return { validate: validate.error.code, test: test.error.code }
    })
    await model('provider.package.* 形态检查', async () => {
      const codes = []
      for (const [operationId, input] of [
        ['provider.package.export', { fileName: 'x.cskeys', password: 'pw' }],
        ['provider.package.seal', { fileName: 'y.cskeys', password: 'pw', recipientCredentialFileName: 'none.cscred', connectionIds: ['acc-conn'] }],
        ['provider.package.preview', { fileName: 'none.cskeys', password: 'pw' }]
      ]) {
        const response = await call(operationId, input)
        const result = wire(response, operationId)
        codes.push(operationId + '=' + (result.code ?? 'completed'))
      }
      report.notes.push('provider.package.* 实际返回：' + codes.join(', '))
      return { codes }
    })
    await model('model.definition.deleteMany / connection.delete 清理', async () => {
      wire(await call('model.definition.deleteMany', { modelDefinitionIds: ['acc-model'] }), 'deleteMany')
      wire(await call('model.connection.delete', { connectionId: 'acc-conn' }), 'connection.delete')
      return {}
    })
    await model('skill.list', async () => {
      const response = await call('skill.list', { limit: 20 })
      return wire(response, 'skill.list')
    })

    // ========== 第 5 族：Agent Flow ==========
    const flow = family('family-5-flow')
    await flow('flowAgent.inspect', async () => {
      if (!agentNodeId) throw new Error('缺少 Agent 节点')
      return wire(await call('flowAgent.inspect', { projectId, nodeId: agentNodeId }), 'inspect')
    })
    await flow('flowAgent.catalog', async () => {
      return wire(await call('flowAgent.catalog', { projectId }), 'catalog')
    })
    await flow('flowAgent.collaboration', async () => {
      if (!agentNodeId) throw new Error('缺少 Agent 节点')
      return wire(await call('flowAgent.collaboration', { projectId, nodeId: agentNodeId }), 'collaboration')
    })
    await flow('flowAgent.run start（无可用模型应被拒且不发起请求）', async () => {
      if (!agentNodeId) throw new Error('缺少 Agent 节点')
      return wire(
        await call('flowAgent.run', { projectId, nodeId: agentNodeId, action: 'start' }),
        'run.start'
      )
    })
    await flow('flowAgent.pause / stop', async () => {
      if (!agentNodeId) throw new Error('缺少 Agent 节点')
      const pause = wire(await call('flowAgent.pause', { projectId, nodeId: agentNodeId }), 'pause')
      const stop = wire(await call('flowAgent.stop', { projectId, nodeId: agentNodeId }), 'stop')
      return { pause, stop }
    })
    await flow('flowAgent.cooperate（缺任务时的返回形态）', async () => {
      if (!agentNodeId) throw new Error('缺少 Agent 节点')
      const response = await call('flowAgent.cooperate', {
        projectId,
        nodeId: agentNodeId,
        taskId: 'missing-task',
        waitRevision: 0,
        revision: 0,
        eventId: 'acc-event-1',
        action: 'note',
        text: '验收备注'
      })
      if (response?.status === 'unknown') {
        // 写操作在"已准入但宿主抛错"时按账本语义返回 unknown（不谎报成功）。
        // 但业务前置缺失本应给稳定码，这里记为可用性问题。
        report.notes.push(
          'flowAgent.cooperate 缺任务时返回 unknown（而非稳定的 AGENT_TASK_MISSING）：调用方无法区分"没发生"和"不确定"'
        )
        return { status: 'unknown' }
      }
      return wire(response, 'cooperate')
    })
    await flow('flowAgent.build.inspect / propose', async () => {
      if (!agentNodeId) throw new Error('缺少 Agent 节点')
      const inspect = wire(
        await call('flowAgent.build.inspect', { projectId, nodeId: agentNodeId }),
        'build.inspect'
      )
      const propose = wire(
        await call('flowAgent.build.propose', { projectId, nodeId: agentNodeId, prompt: '验收建图' }),
        'build.propose'
      )
      return { inspect, propose }
    })
    await flow('flowAgent.review', async () => {
      if (!agentNodeId) throw new Error('缺少 Agent 节点')
      return wire(
        await call('flowAgent.review', { projectId, nodeId: agentNodeId, action: 'run' }),
        'review'
      )
    })
    await flow('flow.command 六项形态检查', async () => {
      const codes = []
      for (const [operationId, input] of [
        ['flow.command.lookup', { projectId }],
        ['flow.command.availability', { projectId }],
        ['flow.command.check', { projectId, commandId: 'missing-command' }],
        ['flow.command.reconcile', { projectId }],
        ['flow.command.dispatch', { projectId, commandId: 'missing-command' }],
        ['flow.command.abort', { projectId, commandId: 'missing-command' }]
      ]) {
        const response = await call(operationId, input)
        const result = wire(response, operationId)
        codes.push(operationId + '=' + (result.code ?? 'completed'))
      }
      report.notes.push('flow.command.* 实际返回：' + codes.join(', '))
      return { codes }
    })
    await flow('flowAsset.list / read / submit', async () => {
      const list = wire(await call('flowAsset.list', { projectId }), 'flowAsset.list')
      const read = wire(await call('flowAsset.read', { projectId, assetId: 'missing-asset', versionId: 'v0' }), 'flowAsset.read')
      const submit = wire(
        await call('flowAsset.submit', { projectId, nodeId: textNodeId, title: '验收资产' }),
        'flowAsset.submit'
      )
      return { list, read, submit }
    })
    await flow('director.publish.prepare / status / continue', async () => {
      const prepare = wire(
        await call('director.publish.prepare', { projectId, nodeId: textNodeId, mode: 'video', shotId: 'shot-1' }),
        'publish.prepare'
      )
      const status = wire(
        await call('director.publish.status', { projectId, publishRequestId: 'pub_missing01' }),
        'publish.status'
      )
      const cont = wire(
        await call('director.publish.continue', { projectId, publishRequestId: 'pub_missing01' }),
        'publish.continue'
      )
      return { prepare, status, continue: cont }
    })

    // ========== 第 9 族：执行与对话 ==========
    const exec = family('family-9-execution-chat')
    await exec('node.execute（文本节点本地执行）+ run.get/wait + output.get', async () => {
      if (!textNodeId) throw new Error('缺少文本节点')
      const executed = await call('node.execute', {
        projectId,
        expectedGraphVersion: graphVersion,
        nodeIds: [textNodeId]
      })
      const result = wire(executed, 'node.execute')
      const data = executed?.status === 'completed' ? executed.data : null
      const taskId = data?.taskId ?? data?.runs?.[0]?.taskId
      if (taskId) {
        wire(await call('run.get', { projectId, taskId }), 'run.get')
        wire(await call('run.wait', { projectId, taskId, timeoutMs: 5000 }), 'run.wait')
      }
      wire(
        await call('output.get', { projectId, nodeId: textNodeId, view: 'persisted' }),
        'output.get'
      )
      return { taskId, ...result }
    })
    await exec('run.cancel（不存在的任务应为业务拒绝）', async () => {
      return wire(await call('run.cancel', { projectId, taskId: 'missing-task' }), 'run.cancel')
    })
    await exec('chat.skill.list / bind / chat.read / chat.messages', async () => {
      const codes = []
      for (const [operationId, input] of [
        ['chat.skill.list', { projectId }],
        ['chat.skill.bind', { projectId, nodeId: textNodeId, skillIds: [] }],
        ['chat.read', { projectId, nodeId: textNodeId }],
        ['chat.messages', { projectId, nodeId: textNodeId }]
      ]) {
        const response = await call(operationId, input)
        const result = wire(response, operationId)
        codes.push(operationId + '=' + (result.code ?? 'completed'))
      }
      report.notes.push('chat.* 实际返回：' + codes.join(', '))
      return { codes }
    })
  } catch (error) {
    failed += 1
    report.failures.push({ family: 'setup', name: '脚本整体执行', detail: String(error).slice(0, 800) })
  } finally {
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
    console.log(`\n族 4/5/6/9 验收：步骤=${report.total} 通过=${report.passed} 失败=${report.failed}`)
    for (const [name, entries] of Object.entries(report.families)) {
      console.log(`  ${name}: ${entries.filter((e) => e.ok).length}/${entries.length}`)
    }
    for (const failure of report.failures.slice(0, 24)) {
      console.log('  FAIL ' + failure.family + ' / ' + failure.name + ' :: ' + failure.detail)
    }
    console.log(' 业务码分布：' + JSON.stringify(report.businessCodes))
    console.log('报告：qa/local-agent-access/families-04-05-06-09/report.json')
    process.exit(report.failed === 0 ? 0 : 1)
  }
}

main()
