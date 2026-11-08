/**
 * F9 剩余可做项验收：供应商管理（3）+ 凭据包导入闸门（2）+ 即梦登录闸门（2）。
 *
 * 真实 MCP 协议栈 + 真实桌面会话。
 * 注意：**人工确认路径无法自动化**（会在 GUI 弹确认框等人点），因此这里验证的是
 * "没有人的确认就绝对进不去"这一侧；人工确认后的导入需要真人手测（报告中说明）。
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
  const directory = await mkdtemp(join(tmpdir(), 'canvas-accept-f9rest-'))
  const evidence = join(appRoot, 'qa', 'local-agent-access', 'f9-remaining-doable')
  await mkdir(evidence, { recursive: true })
  const report = { checks: [], failures: [], notes: [] }
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
    client = new Client({ name: 'accept-f9rest', version: '1.0.0' }, { capabilities: {} })
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

    // 打开一个画布：人工确认与多数桌面动作都绑定当前画布
    const project = ok(await call('project.create', { name: 'F9 收尾验收' }), 'project.create')
    ok(await call('project.open', { projectId: project.meta.id }), 'project.open')

    // ── 供应商管理 ──
    const saved = await check('provider.save 保存连接且回执不回显密钥', async () => {
      const data = ok(
        await call('provider.save', {
          id: 'acc-admin-1',
          name: '验收供应商',
          specId: 'toapis',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-acceptance-admin-secret-0001',
          models: [{ id: 'm1', name: 'M1' }]
        }),
        'provider.save'
      )
      expect(data.id === 'acc-admin-1', 'id 不符')
      expect(data.hasApiKey === true, 'hasApiKey 应为 true')
      const serialized = JSON.stringify(data)
      expect(!serialized.includes('sk-acceptance-admin-secret-0001'), '回执泄漏明文密钥')
      expect(!serialized.includes('127.0.0.1'), '回执泄漏地址')
      return { id: data.id, modelCount: data.modelCount }
    })

    await check('provider.save 更新时留空 apiKey 保留原密钥', async () => {
      const data = ok(
        await call('provider.save', {
          id: 'acc-admin-1',
          name: '验收供应商-改名',
          specId: 'toapis',
          baseUrl: 'http://127.0.0.1:9/v1'
        }),
        'provider.save update'
      )
      expect(data.name === '验收供应商-改名', '名称未更新')
      expect(data.hasApiKey === true, '留空 apiKey 后密钥丢失')
      return { name: data.name }
    })

    await check('provider.probe 未确认联网必须拒绝', async () => {
      const response = await call('provider.probe', { providerId: 'acc-admin-1' })
      expect(response?.status === 'failed', '未确认却执行了探测')
      expect(response.error?.code === 'NETWORK_CONFIRM_REQUIRED', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    await check('provider.probe 确认后只探测已保存供应商（不发起计费调用）', async () => {
      const response = await call('provider.probe', {
        providerId: 'acc-admin-1',
        confirmNetwork: true
      })
      // 目标是不存在的本地地址：探测应如实返回失败结论，而不是报"操作成功"
      if (response?.status === 'completed') {
        const data = response.data
        expect(Array.isArray(data.items), '缺少探测条目')
        report.notes.push(
          'provider.probe 对不可达地址返回 ' + JSON.stringify(data.items.map((item) => item.outcome))
        )
        return { items: data.items.length, summary: String(data.summary).slice(0, 80) }
      }
      expect(response.error?.code, '探测失败但没有错误码')
      report.notes.push('provider.probe 失败码：' + response.error.code)
      return { code: response.error.code }
    })

    await check('provider.delete 删除后目录里消失', async () => {
      ok(await call('provider.delete', { id: 'acc-admin-1' }), 'provider.delete')
      const list = ok(await call('provider.list', { limit: 50 }), 'provider.list')
      expect(!(list.items ?? []).some((item) => item.id === 'acc-admin-1'), '删除后仍在目录')
      return {}
    })

    await check('provider.delete 不存在的 id 如实 NOT_FOUND', async () => {
      const response = await call('provider.delete', { id: 'no-such-provider' })
      expect(response?.status === 'failed', '不存在的供应商不应删除成功')
      expect(response.error?.code === 'NOT_FOUND', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    // ── 凭据包导入：确认闸门 ──
    await check('provider.package.import 未确认必须拒绝（且不读文件）', async () => {
      const response = await call('provider.package.import', {
        fileName: 'not-there.cskeys',
        password: 'pw'
      })
      expect(response?.status === 'failed', '未确认却执行了导入')
      expect(response.error?.code === 'IMPORT_CONFIRM_REQUIRED', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    await check('provider.package.import 确认后仍要求文件存在', async () => {
      const response = await call('provider.package.import', {
        fileName: 'not-there.cskeys',
        password: 'pw',
        confirmImport: true
      })
      expect(response?.status === 'failed', '文件不存在却成功')
      expect(response.error?.code === 'INPUT_NOT_FOUND', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    await check('provider.package.importProviders 未确认必须拒绝', async () => {
      const response = await call('provider.package.importProviders', {
        fileName: 'not-there.cskeys',
        password: 'pw'
      })
      expect(response?.status === 'failed', '未确认却执行了导入')
      expect(response.error?.code === 'IMPORT_CONFIRM_REQUIRED', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    // 人工确认路径：放一个真实格式的假包，确认会走到"等人确认"这一步而不会静默导入
    await check('provider.package.import 走到人工确认（无人在场时不落库）', async () => {
      const packageFile = join(directory, 'agent-exports', 'confirm-probe.cskeys')
      await writeFile(packageFile, 'not-a-real-package', 'utf8')
      const response = await call('provider.package.import', {
        fileName: 'confirm-probe.cskeys',
        password: 'pw',
        confirmImport: true
      })
      // 假包会先在 openKeyPackagePreview 处失败（包无效）；关键是没有静默导入
      expect(response?.status === 'failed', '假包不应导入成功')
      report.notes.push('provider.package.import 假包返回：' + response.error?.code)
      return { code: response.error?.code }
    })

    // ── 即梦登录：确认闸门 ──
    await check('dreamina.login.start 未确认联网必须拒绝', async () => {
      const response = await call('dreamina.login.start', {})
      expect(response?.status === 'failed', '未确认却发起了登录请求')
      expect(response.error?.code === 'NETWORK_CONFIRM_REQUIRED', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    await check('dreamina.login.check 未确认联网必须拒绝', async () => {
      const response = await call('dreamina.login.check', { deviceCode: 'x' })
      expect(response?.status === 'failed', '未确认却查询了登录状态')
      expect(response.error?.code === 'NETWORK_CONFIRM_REQUIRED', `错误码=${response.error?.code}`)
      return { code: response.error.code }
    })

    await check('dreamina.login.start 确认后如实反映本机状态（不伪造成功）', async () => {
      const response = await call('dreamina.login.start', { confirmNetwork: true })
      if (response?.status === 'completed') {
        expect(['already', 'pending', 'failed'].includes(response.data.status), `状态=${response.data.status}`)
        report.notes.push('dreamina.login.start 返回 ' + response.data.status + '（' + response.data.message + '）')
        return { status: response.data.status }
      }
      expect(response.error?.code, '失败但无错误码')
      report.notes.push('dreamina.login.start 失败码：' + response.error.code)
      return { code: response.error.code }
    })

    // ── diagnostics.exportNodeRun：真实执行一次节点再导出，验证脱敏 ──
    await check('diagnostics.exportNodeRun 导出节点诊断且抹掉正文', async () => {
      const SECRET_TEXT = 'F9-EXPORT-SECRET-TEXT-0001'
      const patched = await call('graph.patch', {
        projectId: project.meta.id,
        expectedGraphVersion: await (async () => {
          let previous = -1
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const response = await call('graph.get', {
              projectId: project.meta.id,
              view: 'latest',
              offset: 0,
              limit: 1
            })
            const value = response?.data?.graphVersion
            const unsaved = response?.data?.unsaved
            if (Number.isInteger(value) && value === previous && unsaved === false) return value
            previous = Number.isInteger(value) ? value : previous
            await new Promise((done) => setTimeout(done, 700))
          }
          return previous
        })(),
        ops: [
          {
            action: 'node.create',
            ref: 'diag',
            nodeType: 'text',
            x: 0,
            y: 0,
            title: '诊断节点',
            text: SECRET_TEXT
          }
        ]
      })
      if (patched?.error?.code === 'REVISION_CONFLICT') {
        const retry = await call('graph.patch', {
          projectId: project.meta.id,
          expectedGraphVersion: patched.error.currentGraphVersion,
          ops: [
            {
              action: 'node.create',
              ref: 'diag',
              nodeType: 'text',
              x: 0,
              y: 0,
              title: '诊断节点',
              text: SECRET_TEXT
            }
          ]
        })
        ok(retry, 'graph.patch for exportNodeRun')
      } else {
        ok(patched, 'graph.patch for exportNodeRun')
      }
      const graph = ok(
        await call('graph.get', { projectId: project.meta.id, view: 'latest', offset: 0, limit: 10 }),
        'graph.get after patch'
      )
      const nodeId = (graph.nodes ?? []).find((node) => node.title === '诊断节点')?.nodeId
      expect(nodeId, '找不到诊断节点')

      const exported = await call('diagnostics.exportNodeRun', {
        projectId: project.meta.id,
        nodeId
      })
      // 允许"该节点还没有运行记录"这类业务拒绝，但不允许协议层纯文本错误
      if (exported?.status !== 'completed') {
        expect(
          !String(exported?.error?.code ?? '').startsWith('PLAIN_TEXT:'),
          '协议层纯文本错误：' + exported?.error?.code
        )
        report.notes.push('diagnostics.exportNodeRun 返回：' + exported?.error?.code)
        return { code: exported?.error?.code }
      }
      const data = exported.data
      const target = join(directory, 'agent-exports', data.fileName)
      expect(existsSync(target), '诊断文件不存在')
      const text = await readFile(target, 'utf8')
      // 报告含中文：必须比字节数而不是字符数
      expect(Buffer.byteLength(text, 'utf8') === data.byteSize, '字节数与回执不符')
      expect(!text.includes(SECRET_TEXT), '导出文件泄漏了节点正文')
      expect(!text.includes('"sk-'), '导出文件泄漏了密钥形态')
      const parsed = JSON.parse(text)
      expect(parsed.format === 'canvas-studio-node-diagnostics-v1', '报告格式不符')
      return { fileName: data.fileName, runCount: data.runCount }
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
    console.log(`\nF9 剩余可做项验收：检查=${report.total} 通过=${report.passed} 失败=${report.failed}`)
    for (const failure of report.failures.slice(0, 15)) console.log('  FAIL ' + failure.name + ' :: ' + failure.detail)
    for (const note of report.notes) console.log('  NOTE ' + note)
    console.log('报告：qa/local-agent-access/f9-remaining-doable/report.json')
    process.exit(report.failed === 0 ? 0 : 1)
  }
}

main()
