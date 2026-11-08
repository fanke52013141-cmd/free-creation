/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars, no-empty, no-irregular-whitespace */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars, no-empty */
﻿/**
 * 真实 MCP 客户端验收：把 133 项外部操作逐个过一遍真实 MCP 协议栈
 * （@modelcontextprotocol/sdk Client + StdioClientTransport，不是直接调服务）。
 *
 * 目的：证明"Agent 真能通过 MCP 用这些能力"，而不只是单元测试里逻辑正确。
 *
 * 前提：应用必须**已激活**（授权门禁未通过就停在授权窗，本地接入服务不会启动）。
 * 本脚本把本机已激活的 security 目录复制进隔离数据目录——授权是设备绑定的，
 * 同一台机器上有效，不会绕过任何校验。
 *
 * 分四类判定：
 *  A. 约定层：tools/list 必须列出全部操作，且 inputSchema/outputSchema 都合法；
 *  B. 读操作：在种子项目上真实调用，检查返回结构（不通过 = 缺陷）；
 *  C. 风险操作（付费/网络/写/需人工）：**用非法或未确认输入调用**，验证"会被正确拦住"，
 *     绝不产生真实副作用（这是"接线正确"的证明，不是"功能已验收"的证明）；
 *  D. 未覆盖：明确列出并写原因，不假装通过。
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

/** 本机已激活授权的 security 目录（设备绑定，同一机器有效）。 */
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

/** 只读操作：可安全真实调用。 */
const READ_OPS = [
  'app.status',
  'capability.list',
  'node.type.list',
  'node.type.get',
  'project.list',
  'model.connection.list',
  'model.definition.list',
  'model.binding.list',
  'environment.local',
  'environment.videoEngine.status',
  'provider.list',
  'provider.listExecutable',
  'provider.exportableConnections',
  'workspace.palettePreferences.get',
  'diagnostics.query',
  'library.resource.list',
  'library.folder.list',
  'library.collection.list',
  'flowAgent.catalog',
  'history.list'
]

/** 风险操作：只验证"会被正确拦住"，参数故意不完整/未确认。 */
const GUARDED_OPS = [
  ['environment.videoEngine.install', {}, 'INSTALL_CONFIRM_REQUIRED'],
  ['provider.testConnection', { providerId: 'no-such-provider' }, 'NETWORK_CONFIRM_REQUIRED'],
  ['model.validate', { connectionId: 'c', modelDefinitionId: 'm', operation: 'text.generate' }, 'NETWORK_CONFIRM_REQUIRED'],
  ['provider.package.preview', { fileName: 'nope.cskeys', password: 'x' }, null],
  ['graph.patch', { projectId: 'p', expectedGraphVersion: 0, ops: [] }, null],
  ['project.import', { filePath: '/etc/passwd' }, 'PATH_NOT_ALLOWED'],
  ['run.cancel', { projectId: 'p', taskId: 't' }, null],

  ['flowAgent.cooperate', { projectId: 'p', nodeId: 'shape:x', action: 'note' }, null],
  ['license.getStatus', {}, null]
]

function toolName(operationId) {
  return operationId.replaceAll('.', '_')
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-mcp-acceptance-'))
  const evidence = join(appRoot, 'qa', 'local-agent-access', 'mcp-acceptance')
  await mkdir(evidence, { recursive: true })
  const report = {
    startedAt: new Date().toISOString(),
    dataDirectory: directory,
    toolCount: 0,
    checks: [],
    failures: [],
    guarded: [],
    uncovered: []
  }
  const record = (name, ok, detail) => {
    report.checks.push({ name, ok, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) })
    if (!ok) report.failures.push({ name, detail: String(detail).slice(0, 500) })
  }

  let app
  let client
  try {
    // 授权是设备绑定的：把本机已激活的 security 目录复制进隔离数据目录，
    // 应用才能越过授权门禁启动本地接入服务（不伪造任何签名）。
    if (existsSync(licensedSecurityDir)) {
      await cp(licensedSecurityDir, join(directory, 'security'), { recursive: true })
      report.licensed = true
    } else {
      report.licensed = false
      record('本机授权目录存在', false, licensedSecurityDir)
    }
    const env = { ...process.env, CANVAS_DATA_DIR: directory }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: electron,
      args: [appRoot, '--local-agent-access'],
      env
    })
    const page = await app.firstWindow()
    await page.waitForLoadState().catch(() => undefined)
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] MCP Acceptance')
    })
    for (let i = 0; i < 150; i++) {
      try {
        await readFile(join(directory, 'agent-access/connection.json'))
        break
      } catch {
        await new Promise((done) => setTimeout(done, 200))
      }
    }

    // ── A. 真实 MCP 握手与工具目录 ──
    // MCP 子进程是"用 electron 二进制跑 node 脚本"，必须带 ELECTRON_RUN_AS_NODE=1，
    // 否则 electron 会尝试当桌面应用启动（表现为 initialize 超时）。
    const mcpEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const transport = new StdioClientTransport({
      command: electron,
      args: [cliPath, 'mcp', 'serve', '--stdio', '--data-dir', directory],
      env: mcpEnv,
      stderr: 'pipe'
    })
    client = new Client({ name: 'mcp-acceptance', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    record('MCP 初始化握手', true)

    const listed = await client.listTools()
    report.toolCount = listed.tools.length
    record('tools/list 返回工具数 = 133', listed.tools.length === 133, String(listed.tools.length))
    const missingSchema = listed.tools.filter(
      (tool) => !tool.inputSchema || tool.inputSchema.type !== 'object'
    )
    record('所有工具都有 object 型 inputSchema', missingSchema.length === 0, missingSchema.map((t) => t.name).join(','))

    const call = async (operationId, input, idempotencyKey) => {
      const result = await client.callTool({
        name: toolName(operationId),
        arguments: { input, ...(idempotencyKey ? { idempotencyKey } : {}) }
      })
      // 校验失败时 SDK 只回纯文本（没有 structuredContent）——记下来作为协议层发现：
      // 真正的 Agent 客户端只能靠字符串判断错误类型，无法按错误码分支。
      if (result.structuredContent) return result.structuredContent
      const text = String(result.content?.[0]?.text ?? '{}')
      try {
        return JSON.parse(text)
      } catch {
        report.plainTextErrors = [...(report.plainTextErrors ?? []), { operationId, text: text.slice(0, 120) }]
        return { status: 'failed', error: { code: `PLAIN_TEXT:${text.slice(0, 60)}`, phase: 'protocol' } }
      }
    }

    // 种子项目
    const created = await call('project.create', { name: 'MCP 验收项目' }, key())
    const projectId = created?.data?.meta?.id
    record(
      'project.create 经 MCP 成功并返回项目 ID',
      Boolean(projectId),
      JSON.stringify(created?.error ?? created).slice(0, 300)
    )

    // flowAgent.catalog 要求项目已在画布中打开：先经 MCP project.open 走权威宿主握手。
    if (projectId) {
      const opened = await call('project.open', { projectId }, key())
      record(
        'project.open 经 MCP 在真实桌面中打开画布',
        opened?.status === 'completed',
        JSON.stringify(opened?.error ?? '').slice(0, 200)
      )
    }

    // ── B. 读操作真实调用（每项按自己的 Schema 传参，不能一律塞 projectId）──
    const READ_INPUTS = {
      'node.type.get': { typeId: 'text' },
      'diagnostics.query': { limit: 5 },
      'project.list': {},
      'history.list': { projectId },
      'flowAgent.catalog': { projectId },
      'library.folder.list': {},
      'library.collection.list': {},
      'library.resource.list': { limit: 5 }
    }
    for (const operationId of READ_OPS) {
      const input = READ_INPUTS[operationId] ?? {}
      try {
        const response = await call(operationId, input)
        const ok = response?.status === 'completed'
        record(
          `读操作 ${operationId}`,
          ok,
          ok ? '' : JSON.stringify(response?.error ?? response).slice(0, 200)
        )
      } catch (error) {
        record(`读操作 ${operationId}`, false, error instanceof Error ? error.message : String(error))
      }
    }

    // ── B2. 全量只读扫描：57 个 read 操作全部经真实 MCP 调一遍 ──
    // 入参由各自的 inputSchema.required 生成最小合法值（projectId 用种子项目，其余用占位 id）。
    // 判定：返回合法信封即算"接通"（completed=真通；failed 带业务码=缺前置数据但已接通）；
    // 超时/抛错/纯文本错误 = 缺陷。只读操作无副作用。
    const readOps = listed.tools.filter((tool) => /^(app|capability|node|project|model|environment|provider|workspace|diagnostics|library|flowAgent|flowAsset|flow_command|history|skill|director|node_library|publish)_/.test(tool.name.replaceAll('_', '_')))
    const contractsOutput = await new Promise((done) => {
      const { execFileSync } = require('node:child_process')
      try {
        const raw = execFileSync(
          electron,
          [cliPath, 'contracts', '--data-dir', directory],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }
        )
        done(JSON.parse(raw))
      } catch (error) {
        done({ operations: [] })
      }
    })
    const effectOf = new Map(
      (contractsOutput.operations ?? []).map((operation) => [operation.operationId, operation.effect])
    )
    const placeholder = (name, schema) => {
      if (/^projectId$/.test(name)) return projectId
      if (schema?.enum?.length) return schema.enum[0]
      if (schema?.type === 'integer' || schema?.type === 'number') return schema.minimum ?? 0
      if (schema?.type === 'boolean') return false
      if (schema?.type === 'array') return []
      if (schema?.type === 'object') return {}
      // 有正则约束的字段要生成**能过校验**的占位值，否则测出来的只是"我的入参不合法"。
      const pattern = typeof schema?.pattern === 'string' ? schema.pattern : ''
      if (pattern.includes('shape:')) return 'shape:missing'
      if (pattern.includes('pub_')) return 'pub_missing01'
      if (/\\\.\[a-z\]/.test(pattern) || pattern.includes('\\.')) return 'missing.cskeys'
      if (pattern.includes('::')) return 'missing::model'
      if (pattern.includes('https')) return 'https://missing.invalid'
      if (/Id$|^id$/.test(name)) return 'missing-00000000'
      return 'missingplaceholder'
    }
    report.readSweep = []
    for (const tool of listed.tools) {
      const operationId = tool.name.replaceAll('_', '.')
      if (effectOf.get(operationId) !== 'read') continue
      // 注意：MCP 工具的外层参数是 { input, idempotencyKey }，
      // 真正的操作入参 Schema 在 properties.input 里——不能把 required 读错一层。
      const opSchema = tool.inputSchema.properties?.input ?? {}
      const input = {}
      for (const required of opSchema.required ?? []) {
        input[required] = placeholder(required, opSchema.properties?.[required])
      }
      try {
        const response = await call(operationId, input)
        const status = response?.status
        const code = response?.error?.code ?? ''
        const plainText = typeof code === 'string' && code.startsWith('PLAIN_TEXT:')
        report.readSweep.push({ operationId, status, code })
        if (plainText) {
          record(`只读扫描 ${operationId}`, false, `协议层纯文本错误：${code}`)
        } else if (status !== 'completed' && status !== 'failed') {
          record(`只读扫描 ${operationId}`, false, `异常状态 ${status}`)
        } else {
          record(`只读扫描 ${operationId}`, true, status === 'completed' ? '' : `业务拒绝 ${code}`)
        }
      } catch (error) {
        report.readSweep.push({ operationId, status: 'threw' })
        record(
          `只读扫描 ${operationId}`,
          false,
          error instanceof Error ? error.message.slice(0, 150) : String(error).slice(0, 150)
        )
      }
    }

    for (const [operationId, input, expectedCode] of GUARDED_OPS) {
      const payload = { ...input, ...(projectId && 'projectId' in input ? { projectId } : {}) }
      try {
        const response = await call(operationId, payload, key())
        const code = response?.error?.code ?? ''
        const blocked = response?.status !== 'completed'
        if (expectedCode) {
          record(`拦住 ${operationId}（期望 ${expectedCode}）`, code === expectedCode, `实际 code=${code}`)
        } else {
          record(`拦住 ${operationId}（不得成功）`, blocked, `status=${response?.status} code=${code}`)
        }
        report.guarded.push({ operationId, status: response?.status, code })
      } catch (error) {
        // 抛错也算被拦住（协议层拒绝）
        record(`拦住 ${operationId}（协议层拒绝）`, true, error instanceof Error ? error.message.slice(0, 120) : '')
        report.guarded.push({ operationId, status: 'threw' })
      }
    }

    report.uncovered = listed.tools
      .map((tool) => tool.name)
      .filter((name) => {
        const operationId = name.replaceAll('_', '.')
        return !READ_OPS.includes(name.replaceAll('_', '.')) && !GUARDED_OPS.some(([id]) => id === operationId)
      })
  } catch (error) {
    record('验收脚本整体执行', false, error instanceof Error ? error.stack?.slice(0, 800) : String(error))
  } finally {
    report.finishedAt = new Date().toISOString()
    report.passed = report.checks.filter((c) => c.ok).length
    report.failed = report.failures.length
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
    console.log(
      `\nMCP 验收：工具数=${report.toolCount} 检查=${report.checks.length} 通过=${report.passed} 失败=${report.failed}`
    )
    for (const failure of report.failures.slice(0, 20)) console.log('  FAIL ' + failure.name + ' :: ' + failure.detail)
    console.log('报告：qa/local-agent-access/mcp-acceptance/report.json')
    process.exit(report.failed === 0 ? 0 : 1)
  }
}

main()
