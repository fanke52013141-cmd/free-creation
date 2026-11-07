/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 首个开发里程碑验收：Agent 经真实 CLI 在真实 Electron 桌面上
//   1) 建立三个独立项目画布 A/B/C 并批量建图连线
//   2) 读取并修改其中一张图；非法操作不留半张图
//   3) 执行确定性文本流程并读取正式结果（node.execute → run.wait → output.get）
//   4) 不覆盖人的未保存修改（flush → 版本冲突 → 重读后成功且用户正文保留）
//   5) 保存、关闭并重启；任务账本与图结构跨重启一致；GUI 重新打开可直接继续编辑
// 证据写入 qa/local-agent-access/milestone-a-b-c/report.json 与截图。
const { _electron } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { mkdtemp, mkdir, readFile, writeFile, rm, readdir, cp } = require('node:fs/promises')
const { resolve, join, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { existsSync } = require('node:fs')
const { sep } = require('node:path')
const { qaOutputPath } = require('./qa-output.cjs')
const key = () => `${Date.now()}:${randomUUID()}`
const electron = require('electron')
const appRoot = resolve('.')
const cliPath = join(appRoot, 'out/main/local-agent.js')

function check(ok, code) {
  if (!ok) throw new Error(code)
}
async function runCli(directory, args, input, timeoutMs = 30000) {
  if (process.env.CS_MILESTONE_TRACE) console.log('[cli]', args.join(' '))
  const file = join(directory, `input-${randomUUID()}.json`)
  if (input) await writeFile(file, JSON.stringify(input))
  return await new Promise((resolveCall, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, ...args, '--data-dir', directory, ...(input ? ['--input-file', file] : [])],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    let output = ''
    let error = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-1000) })
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      try { resolveCall({ code, response: JSON.parse(output) }) }
      catch { reject(new Error(`CLI_INVALID_RESULT:${code}:${error}`)) }
    })
  })
}
function runIssuer(args) {
  return execFileSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', join(appRoot, 'tools/cs-issuer/cli.ts'), ...args, '--store', join(appRoot, 'qa/security-dev-root')],
    { encoding: 'utf8', timeout: 120000, cwd: appRoot }
  )
}
async function writeDialogConfig(configPath, savePaths, openPaths) {
  await mkdir(join(directory0(), 'x'), { recursive: true }).catch(() => {})
  await writeFile(configPath, JSON.stringify({ savePaths, openPaths }), 'utf8')
}
let milestoneRoot = ''
function directory0() {
  return milestoneRoot
}
function makeBootstrap() {
  const bootstrap = join(milestoneRoot, 'bootstrap.cjs')
  const contents = `
const { app, dialog } = require('electron');
const fs = require('node:fs');
const cfgPath = process.env.CS_LICENSE_QA_CFG;
dialog.showSaveDialog = async (_win, options) => {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const target = cfg.savePaths[options.defaultPath] || null;
  return { canceled: !target, filePath: target || undefined };
};
dialog.showOpenDialog = async (_win, options) => {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  let key = null;
  if (String(options.title).includes('挑战')) key = 'challenge';
  else if (String(options.title).includes('授权')) key = 'license';
  else if (String(options.title).includes('策略')) key = 'policy';
  const target = (cfg.openPaths || {})[key] || null;
  return { canceled: !target, filePaths: target ? [target] : [] };
};
require(${JSON.stringify(join(appRoot, 'out/main/index.js'))});
`
  fs.writeFileSync(bootstrap, contents, 'utf8')
  return bootstrap
}
/** 启动真实应用；未授权时走授权窗全流程激活（与 test-license-electron.cjs 同一协作路径）。 */
async function launchLicensedApp(dataDirectory) {
  const bootstrap = makeBootstrap()
  const cfgPath = join(milestoneRoot, 'dialog-config.json')
  let env = {
    ...process.env,
    CANVAS_DATA_DIR: dataDirectory,
    CS_LICENSE_QA_CFG: cfgPath
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  // 本机无 PCP 时走软件设备适配器（仅开发构建允许）。
  let pcpAvailable = false
  try {
    const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$provider=New-Object System.Security.Cryptography.CngProvider('Microsoft Platform Crypto Provider');$e=[System.Security.Cryptography.CngKey]::Exists('CS-STUDIO-SIGN-K1',$provider,[System.Security.Cryptography.CngKeyOpenOptions]::UserKey);Write-Output (ConvertTo-Json -Compress -InputObject @{ok=$true;exists=$e})`
    const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 })
    const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'))
    pcpAvailable = JSON.parse(line).exists === true
  } catch { pcpAvailable = false }
  if (!pcpAvailable) env = { ...env, CANVAS_LICENSE_ALLOW_SOFTWARE_DEVICE: '1' }
  const app = await _electron.launch({ executablePath: electron, args: [bootstrap, '--local-agent-access'], env, timeout: 60000 })
  let first = await app.firstWindow()
  await first.waitForLoadState('load', { timeout: 30000 }).catch(() => {})
  const body = await first.textContent('body').catch(() => '')
  if (body.includes('导出设备申请')) {
    // ── 授权窗全流程激活 ──
    const req = join(milestoneRoot, 'device.csreq')
    const challenge = join(milestoneRoot, 'device.cschallenge')
    const proof = join(milestoneRoot, 'device.csproof')
    const licenseFile = join(milestoneRoot, 'device.cslicense')
    await writeDialogConfig(cfgPath, { 'device.csreq': req }, {})
    await first.click('#btn-export-request')
    await first.waitForFunction(() => document.getElementById('diagnostic') && !document.getElementById('diagnostic').hidden && document.getElementById('diagnostic').textContent.includes('导出申请完成'), null, { timeout: 90000 })
    check(fs.existsSync(req), 'LICENSE_REQUEST_EXPORT_FAILED')
    runIssuer(['enroll-ek', '--request', req, '--note', 'agent-graph-milestone'])
    runIssuer(['challenge', '--request', req, '--out', challenge])
    await writeDialogConfig(cfgPath, {}, { challenge })
    await first.click('#btn-import-challenge')
    await first.waitForFunction(() => document.getElementById('diagnostic').textContent.includes('导入挑战完成'), null, { timeout: 60000 })
    await writeDialogConfig(cfgPath, { 'device.csproof': proof }, {})
    await first.click('#btn-export-proof')
    await first.waitForFunction(() => document.getElementById('diagnostic').textContent.includes('导出证明完成'), null, { timeout: 60000 })
    check(fs.existsSync(proof), 'LICENSE_PROOF_EXPORT_FAILED')
    runIssuer(['issue', '--proof', proof, '--permanent', '--role', 'recipient', '--operator', 'agent-graph-milestone', '--out', licenseFile])
    await writeDialogConfig(cfgPath, {}, { license: licenseFile })
    await first.click('#btn-import-license')
    let business = null
    const deadline = Date.now() + 45000
    while (Date.now() < deadline && !business) {
      business = app.windows().find((w) => w !== first) ?? null
      if (!business) await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    check(business, 'LICENSE_ACTIVATION_NO_BUSINESS_WINDOW')
    first = business
    await first.waitForLoadState('load', { timeout: 60000 })
  }
  await first.waitForFunction(() => typeof window.api?.createProject === 'function', null, { timeout: 30000 })
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] Agent Graph Milestone')
  })
  for (let i = 0; i < 150; i++) {
    try { await readFile(join(dataDirectory, 'agent-access/connection.json')); break }
    catch { await new Promise((done) => setTimeout(done, 200)) }
  }
  return { app, page: first }
}
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-agent-milestone-'))
  milestoneRoot = directory
  const evidence = qaOutputPath('qa/local-agent-access/milestone-a-b-c')
  await mkdir(evidence, { recursive: true })
  let app
  let page
  const receipt = { status: 'running', checks: [], projects: {} }
  try {
    ;({ app, page } = await launchLicensedApp(directory))
    // ── 1. 三个独立项目画布 ──
    const created = {}
    for (const [alias, name] of [['A', '角色素材'], ['B', '视频剪辑'], ['C', '配音']]) {
      const response = await runCli(directory, ['project', 'create'], { input: { name: `${name}（里程碑）` }, idempotencyKey: key() })
      check(response.response.status === 'completed', `CREATE_${alias}_FAILED`)
      created[alias] = response.response.data.meta.id
      receipt.projects[alias] = { id: created[alias], name }
    }
    check(new Set(Object.values(created)).size === 3, 'PROJECT_IDS_NOT_INDEPENDENT')
    receipt.checks.push('created three independent project canvases via CLI')

    const graphVersions = {}
    // 批量图编辑批次（同批 ref 建点连线）
    const batchFor = (alias, scriptText) => ({
      projectId: created[alias],
      expectedGraphVersion: graphVersions[alias],
      ops: [
        { action: 'node.create', ref: `${alias}-script`, nodeType: 'text', x: 60, y: 60, title: `${alias} 剧本文本`, text: scriptText },
        { action: 'node.create', ref: `${alias}-pass`, nodeType: 'processor', x: 480, y: 60, title: `${alias} 透传`, config: { operation: 'pass' } },
        { action: 'node.create', ref: `${alias}-merge`, nodeType: 'text', x: 900, y: 60, title: `${alias} 合并文本`, text: `${alias} 前缀：` },
        { action: 'node.create', ref: `${alias}-config`, nodeType: 'json', x: 60, y: 420, title: `${alias} 配置`, text: '{"locale":"zh-CN"}' },
        {
          action: 'edge.create', ref: `${alias}-e1`,
          from: { nodeId: `${alias}-script`, portId: 'out-text' },
          to: { nodeId: `${alias}-pass`, portId: 'in-value' }
        },
        {
          action: 'edge.create', ref: `${alias}-e2`,
          from: { nodeId: `${alias}-pass`, portId: 'out-value' },
          to: { nodeId: `${alias}-merge`, portId: 'in-text' }
        }
      ]
    })

    // ── 2. 逐张串行打开并批量建图（graph.patch 经权威宿主原子应用）──
    for (const alias of ['A', 'B', 'C']) {
      const opened = await runCli(directory, ['project', 'open'], { input: { projectId: created[alias] }, idempotencyKey: key() })
      check(opened.response.status === 'completed', `OPEN_${alias}_FAILED`)
      await page.locator('.node-palette').waitFor({ timeout: 30000 })
      // 打开握手会把初始画布状态落盘：Agent 不猜测版本，先读权威修订。
      const versionProbe = await runCli(directory, ['project', 'get'], { input: { projectId: created[alias] } })
      check(versionProbe.response.status === 'completed', `VERSION_PROBE_${alias}_FAILED`)
      graphVersions[alias] = versionProbe.response.data.meta.graphVersion
      const patched = await runCli(directory, ['graph', 'patch'], {
        input: batchFor(alias, `${alias} 的剧本文本：一段确定性测试正文。`),
        idempotencyKey: key()
      })
      check(patched.response.status === 'completed', `PATCH_${alias}_FAILED:${JSON.stringify(patched.response.error)}`)
      const applied = patched.response.data.applied
      check(applied.nodeCreated === 4 && applied.edgeCreated === 2, `PATCH_${alias}_COUNTS`)
      graphVersions[alias] = patched.response.data.graphVersion
      const createdNodes = patched.response.data.created
      // created 只映射 node.create 的 ref（连线 ID 经 graph.get 读取）。
      check(
        createdNodes.length === 4 && createdNodes.every((c) => c.ref && c.nodeId),
        `PATCH_${alias}_MAPPING:${JSON.stringify(createdNodes)}`
      )
      receipt.projects[alias].graphVersion = graphVersions[alias]
      if (process.env.CS_MILESTONE_TRACE) {
        const passRef = `${alias}-pass`
        const probeTarget = patched.response.data.created.find((c) => c.ref === passRef)
        const probe = await runCli(directory, ['node', 'get'], { input: { projectId: created[alias], nodeId: probeTarget.nodeId } })
        console.log('[probe]', alias, JSON.stringify(probe.response.data && probe.response.data.node && probe.response.data.node.config))
      }
    }
    receipt.checks.push('serially opened A/B/C and applied atomic batch graph patches with id mapping')
    // 幂等重放（用保存过的键）——单独对 A 重放验证 receipt 一致、节点数不变
    {
      const openA = await runCli(directory, ['project', 'open'], { input: { projectId: created.A }, idempotencyKey: key() })
      check(openA.response.status === 'completed', 'REOPEN_A_FAILED')
      await page.locator('.node-palette').waitFor({ timeout: 30000 })
      // 切换画布可能推进版本：重读权威修订后再提交。
      const versionProbe = await runCli(directory, ['project', 'get'], { input: { projectId: created.A } })
      graphVersions.A = versionProbe.response.data.meta.graphVersion
      const before = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A } })
      const totalBefore = before.response.data.total
      const replayKey = key()
      const first = await runCli(directory, ['graph', 'patch'], {
        input: { projectId: created.A, expectedGraphVersion: graphVersions.A, ops: [{ action: 'node.create', nodeType: 'text', x: 60, y: 800, title: 'A 幂等节点' }] },
        idempotencyKey: replayKey
      })
      check(first.response.status === 'completed', 'IDEMPOTENT_PATCH_FAILED')
      const replay = await runCli(directory, ['graph', 'patch'], {
        input: { projectId: created.A, expectedGraphVersion: graphVersions.A, ops: [{ action: 'node.create', nodeType: 'text', x: 60, y: 800, title: 'A 幂等节点' }] },
        idempotencyKey: replayKey
      })
      check(replay.response.data.graphVersion === first.response.data.graphVersion, 'IDEMPOTENT_REPLAY_DIVERGED')
      const after = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A } })
      check(after.response.data.total === totalBefore + 1, 'IDEMPOTENT_REPLAY_DUPLICATED')
      graphVersions.A = first.response.data.graphVersion
      receipt.projects.A.graphVersion = graphVersions.A
    }
    receipt.checks.push('idempotency: same key replays the original receipt without duplicating nodes')

    // ── 3. 非法操作不留半张图 ──
    {
      const before = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A } })
      const totalBefore = before.response.data.total
      const illegal = await runCli(directory, ['graph', 'patch'], {
        input: {
          projectId: created.A,
          expectedGraphVersion: graphVersions.A,
          ops: [
            { action: 'node.create', nodeType: 'text', x: 0, y: 0, title: '不应存在' },
            { action: 'edge.create', from: { nodeId: 'shape:a-none', portId: 'out-text' }, to: { nodeId: 'shape:b-none', portId: 'in-text' } }
          ]
        },
        idempotencyKey: key()
      })
      check(illegal.response.status === 'failed' && illegal.response.error?.code === 'PATCH_REFERENCE_INVALID', 'ILLEGAL_PATCH_NOT_REJECTED')
      const after = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A } })
      check(after.response.data.total === totalBefore, 'ILLEGAL_PATCH_LEFT_HALF_GRAPH')
      const incompatible = await runCli(directory, ['graph', 'patch'], {
        input: {
          projectId: created.A,
          expectedGraphVersion: graphVersions.A,
          ops: [
            { action: 'node.create', ref: 't', nodeType: 'text', x: 0, y: 0 },
            { action: 'node.create', ref: 'j', nodeType: 'json', x: 400, y: 0 },
            { action: 'edge.create', from: { nodeId: 't', portId: 'out-text' }, to: { nodeId: 'j', portId: 'in-json' } }
          ]
        },
        idempotencyKey: key()
      })
      check(incompatible.response.status === 'failed' && incompatible.response.error?.code === 'EDGE_INCOMPATIBLE', 'INCOMPATIBLE_EDGE_ACCEPTED')
      const after2 = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A } })
      check(after2.response.data.total === totalBefore, 'INCOMPATIBLE_PATCH_LEFT_NODES')
    }
    receipt.checks.push('illegal operations leave no half-applied graph (reference + compatibility)')

    // ── 4. 不覆盖人的未保存修改 ──
    {
      // UI 直接输入未保存正文（防抖 800ms 内不落盘）。精确命中脚本节点正文，
      // 避免依赖不稳定的 DOM 顺序。
      await page.locator('.node-text').filter({ hasText: 'A 的剧本文本' }).first().dblclick()
      await page.locator('textarea.node-textarea').first().fill('用户未保存的手工正文')
      await page.keyboard.press('Control+Enter')
      // Agent 带旧版本提交：权威宿主先保存用户内容 → 版本前进 → 冲突
      const stale = await runCli(directory, ['graph', 'patch'], {
        input: { projectId: created.A, expectedGraphVersion: graphVersions.A, ops: [{ action: 'node.create', nodeType: 'text', x: 60, y: 1180, title: 'A 冲突测试' }] },
        idempotencyKey: key()
      })
      check(stale.response.status === 'failed' && stale.response.error?.code === 'REVISION_CONFLICT', `UNSAVED_EDIT_NOT_PROTECTED:${JSON.stringify(stale.response.error)}`)
      const fresh = await runCli(directory, ['project', 'get'], { input: { projectId: created.A } })
      const version = fresh.response.data.meta.graphVersion
      const retried = await runCli(directory, ['graph', 'patch'], {
        input: { projectId: created.A, expectedGraphVersion: version, ops: [{ action: 'node.create', nodeType: 'text', x: 60, y: 1180, title: 'A 冲突测试' }] },
        idempotencyKey: key()
      })
      check(retried.response.data.graphVersion > version, 'RETRY_VERSION_UNEXPECTED')
      // 用户正文被保存而不是被覆盖（数据级验证：权威宿主 latest 视图中存在该正文）。
      let userTextAlive = false
      let unsaved = true
      for (let i = 0; i < 20 && (unsaved || !userTextAlive); i++) {
        const probe = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A, view: 'latest', limit: 200 } })
        unsaved = probe.response.data.unsaved === true
        if (process.env.CS_MILESTONE_TRACE) console.log('[poll]', i, 'version', probe.response.data.graphVersion, 'unsaved', unsaved)
        // 目录视图不携带正文：用 output.get 逐个文本节点验证正文存活。
        for (const node of probe.response.data.nodes.filter((n) => n.type === 'text')) {
          const read = await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: node.nodeId } })
          if ((read.response.data.node.text || '').includes('用户未保存的手工正文')) userTextAlive = true
        }
        if (unsaved || !userTextAlive) await new Promise((done) => setTimeout(done, 300))
      }
      check(userTextAlive, 'USER_TEXT_LOST_AFTER_CONFLICT')
      check(unsaved === false, 'LATEST_VIEW_STILL_DIRTY')
      graphVersions.A = retried.response.data.graphVersion
      receipt.projects.A.graphVersion = graphVersions.A
    }
    receipt.checks.push('unsaved user edit flushed and preserved; stale agent version rejected then retried on fresh revision')

    // ── 5. 执行确定性文本流程并读取正式结果 ──
    {
      const graph = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A, limit: 200 } })
      const nodes = graph.response.data.nodes
      const passNode = nodes.find((n) => n.title === 'A 透传')
      const mergeNode = nodes.find((n) => n.title === 'A 合并文本')
      check(passNode && mergeNode, 'MILESTONE_NODES_MISSING')
      const executeKey = key()
      const executed = await runCli(directory, ['node', 'execute'], {
        input: { projectId: created.A, expectedGraphVersion: graphVersions.A, nodeIds: [passNode.nodeId, mergeNode.nodeId], mode: 'subgraph', confirmPaidRerun: false },
        idempotencyKey: executeKey
      })
      check(executed.response.status === 'completed' && executed.response.data.accepted === true, `EXECUTE_FAILED:${JSON.stringify(executed.response.error)}`)
      const taskId = executed.response.data.taskId
      const waited = await runCli(directory, ['run', 'wait'], { input: { projectId: created.A, taskId, timeoutMs: 60000 } }, 90000)
      check(waited.response.data.state === 'completed', `RUN_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
      const output = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: mergeNode.nodeId } })
      check(output.response.status === 'completed', 'OUTPUT_READ_FAILED')
      const outText = output.response.data.outputs.find((o) => o.portId === 'out-text')
      // 运行使用当前画布内容：脚本正文已被人在 GUI 改写并保存，合并节点的
      // 正文仍是批次前缀——正式输出同时含两者，证明 Agent 执行的是最新权威内容。
      check(
        outText &&
          outText.text.includes('用户未保存的手工正文') &&
          outText.text.includes('A 前缀'),
        `FORMAL_OUTPUT_MISMATCH:${JSON.stringify(output.response.data.outputs)}`
      )
      // 运行终态前的保存屏障已推进版本；后续保存用最新版本。
      const refreshed = await runCli(directory, ['project', 'get'], { input: { projectId: created.A } })
      graphVersions.A = refreshed.response.data.meta.graphVersion
      receipt.projects.A.graphVersion = graphVersions.A
      receipt.execute = { taskId, finalState: waited.response.data.state, outputText: outText.text }
      receipt.checks.push('deterministic text flow executed via node.execute and formal output read via output.get')
    }

    // ── 6. 项目隔离：B/C 图不受 A 影响 ──
    for (const alias of ['B', 'C']) {
      const graph = await runCli(directory, ['graph', 'get'], { input: { projectId: created[alias] } })
      check(graph.response.data.total === 4, `ISOLATION_BROKEN_${alias}`)
      check(!JSON.stringify(graph.response.data).includes('A 剧本文本'), `CROSS_PROJECT_LEAK_${alias}`)
    }
    receipt.checks.push('project isolation: nodes/media/tasks do not cross A/B/C')

    // ── 6.5 F4 图片族：媒体登记 → 素材节点引用 → 本地裁剪执行 → 正式产物读取 ──
    {
      const fixture = join(appRoot, 'qa-fixtures/media/images/I-A.png')
      const imported = await runCli(directory, ['media', 'import'], { input: { projectId: created.A, filePath: fixture, name: '里程碑素材' }, idempotencyKey: key() })
      check(imported.response.status === 'completed', `MEDIA_IMPORT_FAILED:${JSON.stringify(imported.response.error)}`)
      const mediaId = imported.response.data.mediaId
      const graph = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A } })
      const versionBefore = graph.response.data.graphVersion
      const mediaPatch = await runCli(directory, ['graph', 'patch'], {
        input: {
          projectId: created.A,
          expectedGraphVersion: versionBefore,
          ops: [
            { action: 'node.create', ref: 'asset', nodeType: 'image', x: 60, y: 1500, media: { mediaId } },
            { action: 'node.create', ref: 'crop', nodeType: 'image-crop', x: 480, y: 1500, config: { mode: 'rect', aspectRatio: 'free', rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } },
            { action: 'edge.create', from: { nodeId: 'asset', portId: 'out-image' }, to: { nodeId: 'crop', portId: 'in-image' } }
          ]
        },
        idempotencyKey: key()
      })
      check(mediaPatch.response.status === 'completed', `MEDIA_PATCH_FAILED:${JSON.stringify(mediaPatch.response.error)}`)
      const cropNode = mediaPatch.response.data.created.find((c) => c.ref === 'crop')
      check(Boolean(cropNode), 'MEDIA_PATCH_MAPPING')
      const executed = await runCli(directory, ['node', 'execute'], {
        input: { projectId: created.A, expectedGraphVersion: mediaPatch.response.data.graphVersion, nodeIds: [cropNode.nodeId], mode: 'single', confirmPaidRerun: false },
        idempotencyKey: key()
      })
      check(executed.response.status === 'completed', `CROP_EXECUTE_FAILED:${JSON.stringify(executed.response.error)}`)
      const cropTask = executed.response.data.taskId
      const waited = await runCli(directory, ['run', 'wait'], { input: { projectId: created.A, taskId: cropTask, timeoutMs: 60000 } }, 90000)
      check(waited.response.data.state === 'completed', `CROP_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
      const cropOutput = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: cropNode.nodeId } })
      check(
        cropOutput.response.status === 'completed',
        `CROP_OUTPUT_READ_FAILED:${JSON.stringify(cropOutput.response.error)}:${JSON.stringify(cropOutput.response.data && cropOutput.response.data.outputs)}`
      )
      const outImage = cropOutput.response.data.outputs.find((o) => o.portId === 'out-image')
      check(outImage && outImage.mediaId && outImage.mediaId !== mediaId, 'CROP_OUTPUT_NOT_NEW_ASSET')
      // 产物真实落盘（正式产物，非伪造引用）
      const artifactPath = join(directory, (outImage.mediaPath ?? '').replace(/\//g, sep))
      check(existsSync(artifactPath), 'CROP_ARTIFACT_MISSING_ON_DISK')
      // 媒体索引中登记为新资产
      const mediaAfter = await runCli(directory, ['media', 'list'], { input: { projectId: created.A, limit: 100 } })
      check(mediaAfter.response.data.items.some((m) => m.mediaId === outImage.mediaId), 'CROP_ARTIFACT_NOT_INDEXED')
      receipt.crop = { mediaId, artifactMediaId: outImage.mediaId, outputPath: outImage.mediaPath }
      receipt.checks.push('F4 image family: media.import → graph.patch media reference → local crop execute → formal artifact on disk and indexed')
    }

    // ── 6.6 F4 深验收：quad 裁剪 / 坐标越界钳制 / 拆分与失败回滚 / 取消契约 ──
    {
      const stable = async (projectId) => {
        let previous = -1
        for (let i = 0; i < 15; i++) {
          const probe = await runCli(directory, ['project', 'get'], { input: { projectId } })
          const current = probe.response.data.meta.graphVersion
          if (current === previous) return current
          previous = current
          await new Promise((done) => setTimeout(done, 900))
        }
        return previous
      }
      const executeAnd = async (projectId, version, nodeId, label) => {
        const executed = await runCli(directory, ['node', 'execute'], {
          input: { projectId, expectedGraphVersion: version, nodeIds: [nodeId], mode: 'single', confirmPaidRerun: false },
          idempotencyKey: key()
        })
        check(executed.response.status === 'completed', `${label}_SUBMIT_FAILED:${JSON.stringify(executed.response.error)}`)
        const waited = await runCli(directory, ['run', 'wait'], { input: { projectId, taskId: executed.response.data.taskId, timeoutMs: 60000 } }, 90000)
        return waited
      }
      const mediaCount = async (projectId) => {
        const listed = await runCli(directory, ['media', 'list'], { input: { projectId, limit: 100 } })
        return listed.response.data.total
      }

      // (a) quad 四点透视裁剪：合法点集 → 成功且产物落盘
      {
        const version = await stable(created.A)
        const patched = await runCli(directory, ['graph', 'patch'], {
          input: {
            projectId: created.A,
            expectedGraphVersion: version,
            ops: [
              { action: 'node.create', ref: 'q-src', nodeType: 'image', x: 60, y: 1900, media: { mediaId: receipt.crop.mediaId } },
              { action: 'node.create', ref: 'q-crop', nodeType: 'image-crop', x: 480, y: 1900, config: { mode: 'quad', aspectRatio: 'free', points: [[0, 0], [1, 0], [1, 1], [0, 1]] } },
              { action: 'edge.create', from: { nodeId: 'q-src', portId: 'out-image' }, to: { nodeId: 'q-crop', portId: 'in-image' } }
            ]
          },
          idempotencyKey: key()
        })
        check(patched.response.status === 'completed', `QUAD_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
        const qNode = patched.response.data.created.find((c) => c.ref === 'q-crop')
        const waited = await executeAnd(created.A, patched.response.data.graphVersion, qNode.nodeId, 'QUAD')
        check(waited.response.data.state === 'completed', `QUAD_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
        const output = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: qNode.nodeId } })
        const outImage = (output.response.data.outputs || []).find((o) => o.portId === 'out-image')
        check(outImage && outImage.mediaId && existsSync(join(directory, (outImage.mediaPath ?? '').replace(/\//g, sep))), 'QUAD_ARTIFACT_INVALID')
        receipt.checks.push('F4 quad crop: four-point perspective crop executes and materializes a formal artifact')
      }

      // (b) 坐标越界钳制：越界 rect 被规范层钳制后成功（与 GUI 同一解析）
      {
        const version = await stable(created.A)
        const patched = await runCli(directory, ['graph', 'patch'], {
          input: {
            projectId: created.A,
            expectedGraphVersion: version,
            ops: [
              { action: 'node.create', ref: 'o-src', nodeType: 'image', x: 60, y: 2300, media: { mediaId: receipt.crop.mediaId } },
              { action: 'node.create', ref: 'o-crop', nodeType: 'image-crop', x: 480, y: 2300, config: { mode: 'rect', aspectRatio: 'free', rect: { x: 0.9, y: 0.9, width: 0.9, height: 0.9 } } },
              { action: 'edge.create', from: { nodeId: 'o-src', portId: 'out-image' }, to: { nodeId: 'o-crop', portId: 'in-image' } }
            ]
          },
          idempotencyKey: key()
        })
        check(patched.response.status === 'completed', `CLAMP_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
        const oNode = patched.response.data.created.find((c) => c.ref === 'o-crop')
        const waited = await executeAnd(created.A, patched.response.data.graphVersion, oNode.nodeId, 'CLAMP')
        // 越界 rect 在执行期由与 GUI 同一 parseImageCropConfig 钳制（配置保存原值，
        // 与 GUI 行为一致）：运行必须成功并产出有效裁剪，而不是报错或整图输出。
        check(waited.response.data.state === 'completed', `CLAMP_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
        const clampOutput = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: oNode.nodeId } })
        const clampImage = (clampOutput.response.data.outputs || []).find((o) => o.portId === 'out-image')
        check(
          clampImage && clampImage.mediaId && existsSync(join(directory, (clampImage.mediaPath ?? '').replace(/\//g, sep))),
          'CLAMP_ARTIFACT_INVALID'
        )
        receipt.checks.push('F4 clamp: out-of-bounds crop rect clamped at execution by the same normalization as GUI')
      }

      // (c) 拆分成功：2x2 拆分 → 4 个新资产入库，out-image 投影选中格
      {
        const gridSource = join(appRoot, 'qa-fixtures/media/images/I-GRID.png')
        const imported = await runCli(directory, ['media', 'import'], { input: { projectId: created.A, filePath: gridSource, name: '宫格源图' }, idempotencyKey: key() })
        check(imported.response.status === 'completed', 'GRID_IMPORT_FAILED')
        const gridMediaId = imported.response.data.mediaId
        const version = await stable(created.A)
        const before = await mediaCount(created.A)
        const patched = await runCli(directory, ['graph', 'patch'], {
          input: {
            projectId: created.A,
            expectedGraphVersion: version,
            ops: [
              { action: 'node.create', ref: 'g-src', nodeType: 'image', x: 60, y: 2700, media: { mediaId: gridMediaId } },
              { action: 'node.create', ref: 'g-split', nodeType: 'image-split', x: 480, y: 2700, config: { rows: 2, columns: 2, scalePercent: 100 } },
              { action: 'edge.create', from: { nodeId: 'g-src', portId: 'out-image' }, to: { nodeId: 'g-split', portId: 'in-image' } }
            ]
          },
          idempotencyKey: key()
        })
        check(patched.response.status === 'completed', `SPLIT_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
        const gNode = patched.response.data.created.find((c) => c.ref === 'g-split')
        const waited = await executeAnd(created.A, patched.response.data.graphVersion, gNode.nodeId, 'SPLIT')
        check(waited.response.data.state === 'completed', `SPLIT_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
        const after = await mediaCount(created.A)
        check(after === before + 4, `SPLIT_CELL_COUNT:${before}->${after}`)
        const output = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: gNode.nodeId } })
        const splitImage = (output.response.data.outputs || []).find((o) => o.portId === 'out-image')
        check(splitImage && splitImage.mediaId && splitImage.mediaId !== gridMediaId, 'SPLIT_OUTPUT_NOT_NEW_ASSET')
        receipt.split = { cells: after - before, selected: splitImage && splitImage.mediaId }
        receipt.checks.push('F4 split: 2x2 grid split materializes exactly four indexed assets with selected-cell projection')
      }

      // (d) 拆分失败回滚：坏图 → 运行 failed → 媒体数量不变（无半次产物）
      {
        const badSource = join(appRoot, 'qa-fixtures/media/bad/I-BAD-corrupt.png')
        const imported = await runCli(directory, ['media', 'import'], { input: { projectId: created.A, filePath: badSource, name: '坏图' }, idempotencyKey: key() })
        check(imported.response.status === 'completed', 'BAD_IMPORT_FAILED')
        const badMediaId = imported.response.data.mediaId
        const version = await stable(created.A)
        const before = await mediaCount(created.A)
        const patched = await runCli(directory, ['graph', 'patch'], {
          input: {
            projectId: created.A,
            expectedGraphVersion: version,
            ops: [
              { action: 'node.create', ref: 'b-src', nodeType: 'image', x: 60, y: 3100, media: { mediaId: badMediaId } },
              { action: 'node.create', ref: 'b-split', nodeType: 'image-split', x: 480, y: 3100, config: { rows: 2, columns: 2, scalePercent: 100 } },
              { action: 'edge.create', from: { nodeId: 'b-src', portId: 'out-image' }, to: { nodeId: 'b-split', portId: 'in-image' } }
            ]
          },
          idempotencyKey: key()
        })
        check(patched.response.status === 'completed', `BAD_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
        const bNode = patched.response.data.created.find((c) => c.ref === 'b-split')
        const waited = await executeAnd(created.A, patched.response.data.graphVersion, bNode.nodeId, 'BADSPLIT')
        check(waited.response.data.state === 'failed', `BADSPLIT_NOT_FAILED:${waited.response.data.state}`)
        const after = await mediaCount(created.A)
        check(after === before, `BADSPLIT_LEFT_ORPHANS:${before}->${after}`)
        receipt.checks.push('F4 split failure rollback: corrupt source fails the run and leaves no orphan cell assets')
      }

      // (e) 取消契约：终态任务取消为无操作（不伪造 cancelRequested）；未知任务拒绝
      {
        const doneTask = receipt.execute.taskId
        check(Boolean(doneTask), 'CANCEL_CONTRACT_NO_DONE_TASK')
        const noop = await runCli(directory, ['run', 'cancel'], { input: { projectId: created.A, taskId: doneTask }, idempotencyKey: key() })
        check(
          noop.response.status === 'completed' &&
            noop.response.data.state === 'completed' &&
            noop.response.data.cancelRequested === false,
          `CANCEL_NOOP_INVALID:${JSON.stringify(noop.response.data || noop.response.error)}`
        )
        const missing = await runCli(directory, ['run', 'cancel'], { input: { projectId: created.A, taskId: 'run-missing' }, idempotencyKey: key() })
        check(missing.response.error?.code === 'NOT_FOUND', 'CANCEL_UNKNOWN_ACCEPTED')
        receipt.checks.push('F4 cancel contract: terminal-task cancel is an honest no-op; unknown task rejected')
      }
    }

    // ── 7. 保存、关闭并重启；重启后图与任务账本一致 ──
    // 运行后的节点状态写入有 800ms 防抖：等版本连续两次读数稳定后再保存。
    const stableVersion = async (projectId) => {
      let previous = -1
      for (let i = 0; i < 20; i++) {
        const probe = await runCli(directory, ['project', 'get'], { input: { projectId } })
        const current = probe.response.data.meta.graphVersion
        if (current === previous) return current
        previous = current
        await new Promise((done) => setTimeout(done, 900))
      }
      return previous
    }
    for (const alias of ['A', 'B', 'C']) {
      graphVersions[alias] = await stableVersion(created[alias])
      const saved = await runCli(directory, ['project', 'save'], { input: { projectId: created[alias], expectedGraphVersion: graphVersions[alias] }, idempotencyKey: key() })
      check(saved.response.status === 'completed', `SAVE_${alias}_FAILED:${JSON.stringify(saved.response.error)}`)
      graphVersions[alias] = saved.response.data.graphVersion
      receipt.projects[alias].graphVersion = graphVersions[alias]
    }
    const taskBefore = receipt.execute.taskId
    // 关闭前记录各项目节点总数：重启后逐一比对（产物节点在运行中增加，不硬编码）。
    const totalsBeforeRestart = {}
    for (const alias of ['A', 'B', 'C']) {
      const probe = await runCli(directory, ['graph', 'get'], { input: { projectId: created[alias] } })
      totalsBeforeRestart[alias] = probe.response.data.total
    }
    await app.close()
    app = undefined
    ;({ app, page } = await launchLicensedApp(directory))
    for (const alias of ['A', 'B', 'C']) {
      const graph = await runCli(directory, ['graph', 'get'], { input: { projectId: created[alias] } })
      check(graph.response.data.total === totalsBeforeRestart[alias], `RESTART_GRAPH_MISMATCH_${alias}:${graph.response.data.total}!=${totalsBeforeRestart[alias]}`)
      // 关窗保存会推进版本（保存即前进）；重启后只要求单调不减且结构一致。
      check(graph.response.data.graphVersion >= graphVersions[alias], `RESTART_VERSION_MISMATCH_${alias}`)
    }
    const taskAfter = await runCli(directory, ['run', 'get'], { input: { projectId: created.A, taskId: taskBefore } })
    check(taskAfter.response.data.state === 'completed', 'TASK_LEDGER_LOST_AFTER_RESTART')
    receipt.checks.push('graph structure and task ledger survive app restart')

    // ── 8. 人在 GUI 打开 A，可直接继续编辑 ──
    {
      const reopened = await runCli(directory, ['project', 'open'], { input: { projectId: created.A }, idempotencyKey: key() })
      check(reopened.response.status === 'completed', 'GUI_REOPEN_FAILED')
      await page.locator('.node-palette').waitFor({ timeout: 30000 })
      await page.getByText('A 剧本文本', { exact: true }).first().waitFor({ timeout: 15000 })
      await page.getByText('A 透传', { exact: true }).first().waitFor({ timeout: 15000 })
      const encoded = await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.webContents.invalidate()
        return (await window.webContents.capturePage()).toPNG().toString('base64')
      })
      await writeFile(join(evidence, 'milestone-reopened-canvas.png'), Buffer.from(encoded, 'base64'))
      // GUI 继续编辑：双击脚本节点正文（等待重开提示消失）输入新内容并保存。
      // 合并节点正文也含该片段：用 hasNotText 排除，精确命中脚本节点。
      await page.waitForTimeout(2500)
      await page
        .locator('.node-text')
        .filter({ hasText: '用户未保存的手工正文' })
        .filter({ hasNotText: 'A 前缀' })
        .first()
        .dblclick()
      await page.locator('textarea.node-textarea').first().fill('人在GUI继续编辑的新正文')
      await page.keyboard.press('Control+Enter')
      // 数据级验证：权威宿主 latest 视图中脚本节点正文已是新内容
      let guiEditAlive = false
      for (let i = 0; i < 20 && !guiEditAlive; i++) {
        const scriptProbe = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A, view: 'latest', limit: 200 } })
        const scriptNode = scriptProbe.response.data.nodes.find((n) => n.title === 'A 剧本文本')
        const read = await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: scriptNode.nodeId } })
        guiEditAlive = (read.response.data.node.text || '').includes('人在GUI继续编辑的新正文')
        if (!guiEditAlive) await new Promise((done) => setTimeout(done, 400))
      }
      check(guiEditAlive, 'GUI_CONTINUE_EDIT_NOT_PERSISTED')
      receipt.checks.push('human reopened project in GUI, continued editing without conversion')
    }

    // 日志脱敏：正文与标题不进诊断
    {
      const events = []
      async function scan(path) {
        for (const item of await readdir(path, { withFileTypes: true })) {
          const target = join(path, item.name)
          if (item.isDirectory()) await scan(target)
          else if (item.name.endsWith('.jsonl')) {
            for (const line of (await readFile(target, 'utf8')).split('\n')) if (line.trim()) events.push(JSON.parse(line))
          }
        }
      }
      await scan(join(directory, 'diagnostics'))
      check(events.length > 0, 'NO_DIAGNOSTIC_EVENTS')
      check(!JSON.stringify(events).includes('一段确定性测试正文'), 'LOG_CONTENT_LEAK_BODY')
      check(!JSON.stringify(events).includes('用户未保存的手工正文'), 'LOG_CONTENT_LEAK_USER_TEXT')
      receipt.checks.push('diagnostics JSONL exists without prompt/body/user-content leakage')
    }

    receipt.status = 'passed'
  } catch (error) {
    receipt.status = 'failed'
    receipt.error = String(error && error.message ? error.message : error)
    throw error
  } finally {
    if (app) await app.close().catch(() => {})
    await writeFile(join(evidence, 'report.json'), JSON.stringify(receipt, null, 2))
    if (receipt.status === 'failed') {
      await cp(join(directory, 'diagnostics'), join(evidence, 'failed-diagnostics'), { recursive: true }).catch(() => {})
    }
    if (resolve(directory, '..') === resolve(tmpdir()) && basename(directory).startsWith('canvas-agent-milestone-')) {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }
  process.stdout.write(`Agent graph milestone acceptance passed: ${evidence}\n`)
})().catch((error) => {
  process.stderr.write(String(error && error.message ? error.message : error) + '\n')
  process.exitCode = 1
})
