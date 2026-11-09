/* eslint-disable @typescript-eslint/no-unused-vars */
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
/**
 * 权威图版本稳定读数：节点运行状态/宿主保存有 800ms 防抖，可能在两次读数之间落盘。
 * 相邻两次相等后再隔一个防抖窗口复核，避免把偏旧版本当作 expectedGraphVersion。
 */
async function stableProjectVersion(directory, projectId) {
  let previous = -1
  for (let i = 0; i < 20; i++) {
    const probe = await runCli(directory, ['project', 'get'], { input: { projectId } })
    const current = probe.response.data.meta.graphVersion
    if (current === previous) {
      await new Promise((done) => setTimeout(done, 1200))
      const confirm = await runCli(directory, ['project', 'get'], { input: { projectId } })
      const confirmed = confirm.response.data.meta.graphVersion
      if (confirmed === current) return current
      previous = confirmed
      continue
    }
    previous = current
    await new Promise((done) => setTimeout(done, 900))
  }
  return previous
}
/**
 * 以稳定读数为 expectedGraphVersion 提交 graph.patch。预检版本冲突无副作用，
 * 重新读版本后重试；只重试 REVISION_CONFLICT，其余失败立即抛出。
 */
async function patchWithFreshVersion(directory, projectId, makeOps, label, attempts = 5) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, 1200))
    const result = await runCli(directory, ['graph', 'patch'], {
      input: {
        projectId,
        expectedGraphVersion: await stableProjectVersion(directory, projectId),
        ops: makeOps()
      },
      idempotencyKey: key()
    })
    if (result.response.status === 'completed') return result
    lastError = result.response.error
    if (lastError?.code !== 'REVISION_CONFLICT')
      throw new Error(`${label}:${JSON.stringify(lastError)}`)
  }
  throw new Error(`${label}:REVISION_CONFLICT:${JSON.stringify(lastError)}`)
}
let milestoneRoot = ''
function directory0() {
  return milestoneRoot
}
function makeBootstrap() {
  const bootstrap = join(milestoneRoot, 'bootstrap.cjs')
  const contents = `
const { app, dialog, powerMonitor } = require('electron');
const fs = require('node:fs');
// 生命周期取证：桌面验收失败时区分“应用被外部关闭/系统恢复/渲染进程崩溃”，
// 不改变任何业务行为，只把事实追加到 milestone 根目录的 lifecycle.log。
const lifecycle = (name, extra) => {
  try {
    fs.appendFileSync(process.env.CS_MILESTONE_LIFECYCLE, JSON.stringify({ at: Date.now(), pid: process.pid, name, ...(extra || {}) }) + '\\n');
  } catch {}
};
app.on('before-quit', () => lifecycle('before-quit'));
app.on('will-quit', () => lifecycle('will-quit'));
app.on('window-all-closed', () => lifecycle('window-all-closed'));
app.on('browser-window-created', (_event, window) => {
  lifecycle('window-created', { id: window.id });
  window.on('close', () => lifecycle('window-close', { id: window.id }));
  window.on('closed', () => lifecycle('window-closed', { id: window.id }));
});
app.on('render-process-gone', (_event, contents, details) => lifecycle('render-process-gone', { reason: details && details.reason, exitCode: details && details.exitCode }));
app.on('child-process-gone', (_event, details) => lifecycle('child-process-gone', { type: details && details.type, reason: details && details.reason }));
app.whenReady().then(() => {
  for (const name of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) {
    try { powerMonitor.on(name, () => lifecycle('power-' + name)) } catch {}
  }
  lifecycle('ready');
});
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
    CS_LICENSE_QA_CFG: cfgPath,
    CS_MILESTONE_LIFECYCLE: join(milestoneRoot, 'lifecycle.log')
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
      const patched = await patchWithFreshVersion(
        directory,
        created[alias],
        () => batchFor(alias, `${alias} 的剧本文本：一段确定性测试正文。`).ops,
        `PATCH_${alias}_FAILED`
      )
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
      // 单次读数会被保存屏障防抖再次推进（与 family1 同一已知竞态）：用稳定读数+冲突重试 helper。
      const retried = await patchWithFreshVersion(
        directory,
        created.A,
        () => [{ action: 'node.create', nodeType: 'text', x: 60, y: 1180, title: 'A 冲突测试' }],
        'CONFLICT_RETRY_FAILED'
      )
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
      const mediaPatch = await patchWithFreshVersion(directory, created.A, () => [
        { action: 'node.create', ref: 'asset', nodeType: 'image', x: 60, y: 1500, media: { mediaId } },
        { action: 'node.create', ref: 'crop', nodeType: 'image-crop', x: 480, y: 1500, config: { mode: 'rect', aspectRatio: 'free', rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } },
        { action: 'edge.create', from: { nodeId: 'asset', portId: 'out-image' }, to: { nodeId: 'crop', portId: 'in-image' } }
      ], 'MEDIA_PATCH_FAILED')
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
      const stable = (projectId) => stableProjectVersion(directory, projectId)
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
        const patchArgs = {
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
        }
      let patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      // GUI 防抖保存可能在稳定读数与准入之间推进版本：预检冲突无副作用，重读后重试。
      for (let retry = 0; retry < 3 && patched.response.status !== 'completed' && patched.response.error?.code === 'REVISION_CONFLICT'; retry += 1) {
        await new Promise((done) => setTimeout(done, 1200))
        patchArgs.input.expectedGraphVersion = await stable(created.A)
        patchArgs.idempotencyKey = key()
        patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      }        check(patched.response.status === 'completed', `QUAD_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
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
        const patchArgs = {
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
        }
      let patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      // GUI 防抖保存可能在稳定读数与准入之间推进版本：预检冲突无副作用，重读后重试。
      for (let retry = 0; retry < 3 && patched.response.status !== 'completed' && patched.response.error?.code === 'REVISION_CONFLICT'; retry += 1) {
        await new Promise((done) => setTimeout(done, 1200))
        patchArgs.input.expectedGraphVersion = await stable(created.A)
        patchArgs.idempotencyKey = key()
        patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      }        check(patched.response.status === 'completed', `CLAMP_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
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
        const patchArgs = {
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
        }
      let patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      // GUI 防抖保存可能在稳定读数与准入之间推进版本：预检冲突无副作用，重读后重试。
      for (let retry = 0; retry < 3 && patched.response.status !== 'completed' && patched.response.error?.code === 'REVISION_CONFLICT'; retry += 1) {
        await new Promise((done) => setTimeout(done, 1200))
        patchArgs.input.expectedGraphVersion = await stable(created.A)
        patchArgs.idempotencyKey = key()
        patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      }        check(patched.response.status === 'completed', `SPLIT_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
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
        const patchArgs = {
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
        }
      let patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      // GUI 防抖保存可能在稳定读数与准入之间推进版本：预检冲突无副作用，重读后重试。
      for (let retry = 0; retry < 3 && patched.response.status !== 'completed' && patched.response.error?.code === 'REVISION_CONFLICT'; retry += 1) {
        await new Promise((done) => setTimeout(done, 1200))
        patchArgs.input.expectedGraphVersion = await stable(created.A)
        patchArgs.idempotencyKey = key()
        patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      }        check(patched.response.status === 'completed', `BAD_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
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

    // ── 6.7 F5 视频/音频：抽帧 / 截取双产物 / 声音调整（本机 ffmpeg）──
    {
      const stable = (projectId) => stableProjectVersion(directory, projectId)
      const executeAnd = async (projectId, version, nodeId, label) => {
        const executed = await runCli(directory, ['node', 'execute'], {
          input: { projectId, expectedGraphVersion: version, nodeIds: [nodeId], mode: 'single', confirmPaidRerun: false },
          idempotencyKey: key()
        })
        check(executed.response.status === 'completed', `${label}_SUBMIT_FAILED:${JSON.stringify(executed.response.error)}`)
        const waited = await runCli(directory, ['run', 'wait'], { input: { projectId, taskId: executed.response.data.taskId, timeoutMs: 90000 } }, 120000)
        return waited
      }
      const mediaCount = async (projectId) => {
        const listed = await runCli(directory, ['media', 'list'], { input: { projectId, limit: 200 } })
        return listed.response.data.total
      }
      const importFixture = async (projectId, relPath, name) => {
        const imported = await runCli(directory, ['media', 'import'], { input: { projectId, filePath: join(appRoot, relPath), name }, idempotencyKey: key() })
        check(imported.response.status === 'completed', `${name}_IMPORT_FAILED:${JSON.stringify(imported.response.error)}`)
        return imported.response.data.mediaId
      }
      const artifactOnDisk = (mediaPath) => existsSync(join(directory, (mediaPath ?? '').replace(/\//g, sep)))
      const probeMediaDuration = (relPath) => {
        const abs = join(directory, (relPath ?? '').replace(/\//g, sep))
        try {
          const out = require('node:child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs], { encoding: 'utf8', timeout: 20000 })
          return Number(out.trim())
        } catch { return null }
      }

      // (a) 视频素材导入 + 抽帧：指定 2000ms 时刻 → PNG 产物
      {
        const videoId = await importFixture(created.A, 'qa-fixtures/media/video/V-AV.mp4', '验收视频')
        const version = await stable(created.A)
        const patchArgs = {
          input: {
            projectId: created.A,
            expectedGraphVersion: version,
            ops: [
              { action: 'node.create', ref: 'v-src', nodeType: 'video-asset', x: 60, y: 3500, media: { mediaId: videoId } },
              { action: 'node.create', ref: 'v-frame', nodeType: 'video-frame', x: 480, y: 3500, config: { mode: 'custom', timeMs: 2000, format: 'png' } },
              { action: 'edge.create', from: { nodeId: 'v-src', portId: 'out-video' }, to: { nodeId: 'v-frame', portId: 'in-video' } }
            ]
          },
          idempotencyKey: key()
        }
      let patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      // GUI 防抖保存可能在稳定读数与准入之间推进版本：预检冲突无副作用，重读后重试。
      for (let retry = 0; retry < 3 && patched.response.status !== 'completed' && patched.response.error?.code === 'REVISION_CONFLICT'; retry += 1) {
        await new Promise((done) => setTimeout(done, 1200))
        patchArgs.input.expectedGraphVersion = await stable(created.A)
        patchArgs.idempotencyKey = key()
        patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      }        check(patched.response.status === 'completed', `FRAME_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
        const fNode = patched.response.data.created.find((c) => c.ref === 'v-frame')
        const waited = await executeAnd(created.A, patched.response.data.graphVersion, fNode.nodeId, 'FRAME')
        check(waited.response.data.state === 'completed', `FRAME_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
        const output = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: fNode.nodeId } })
        const frame = (output.response.data.outputs || []).find((o) => o.portId === 'out-image')
        check(frame && frame.mime === 'image/png' && artifactOnDisk(frame.mediaPath), `FRAME_ARTIFACT_INVALID:${JSON.stringify(output.response.data.outputs)}`)
        receipt.frame = { mediaId: frame && frame.mediaId }
        receipt.checks.push('F5 video-frame: 2000ms frame extraction from imported video materializes an indexed PNG')
      }

      // (b) 视频截取：3s–6s，保留画面+音频 → 同一区间双产物
      {
        const videoId = await importFixture(created.A, 'qa-fixtures/media/video/V-AV.mp4', '截取源视频')
        const version = await stable(created.A)
        const before = await mediaCount(created.A)
        const patchArgs = {
          input: {
            projectId: created.A,
            expectedGraphVersion: version,
            ops: [
              { action: 'node.create', ref: 'c-src', nodeType: 'video-asset', x: 60, y: 3900, media: { mediaId: videoId } },
              { action: 'node.create', ref: 'c-clip', nodeType: 'video-clip', x: 480, y: 3900, config: { version: 3, startMs: 3000, endMs: 6000, keepVideo: true, keepAudio: true, includeAudio: true } },
              { action: 'edge.create', from: { nodeId: 'c-src', portId: 'out-video' }, to: { nodeId: 'c-clip', portId: 'in-video' } }
            ]
          },
          idempotencyKey: key()
        }
      let patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      // GUI 防抖保存可能在稳定读数与准入之间推进版本：预检冲突无副作用，重读后重试。
      for (let retry = 0; retry < 3 && patched.response.status !== 'completed' && patched.response.error?.code === 'REVISION_CONFLICT'; retry += 1) {
        await new Promise((done) => setTimeout(done, 1200))
        patchArgs.input.expectedGraphVersion = await stable(created.A)
        patchArgs.idempotencyKey = key()
        patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      }        check(patched.response.status === 'completed', `CLIP_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
        const clipNode = patched.response.data.created.find((c) => c.ref === 'c-clip')
        const waited = await executeAnd(created.A, patched.response.data.graphVersion, clipNode.nodeId, 'CLIP')
        check(waited.response.data.state === 'completed', `CLIP_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
        const after = await mediaCount(created.A)
        check(after === before + 2, `CLIP_ASSET_COUNT:${before}->${after}`)
        const output = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: clipNode.nodeId } })
        const outputs = output.response.data.outputs || []
        const outVideo = outputs.find((o) => o.portId === 'out-video')
        const outAudio = outputs.find((o) => o.portId === 'out-audio')
        check(outVideo && (outVideo.mime || '').startsWith('video/') && artifactOnDisk(outVideo.mediaPath), `CLIP_VIDEO_INVALID:${JSON.stringify(outputs)}`)
        check(outAudio && (outAudio.mime || '').startsWith('audio/') && artifactOnDisk(outAudio.mediaPath), `CLIP_AUDIO_INVALID:${JSON.stringify(outputs)}`)
        // 产物时长与区间一致（3s）
        const clipSec = probeMediaDuration(outVideo.mediaPath)
        check(clipSec !== null && Math.abs(clipSec - 3) < 0.6, `CLIP_DURATION_MISMATCH:${clipSec}`)
        receipt.clip = { videoMediaId: outVideo && outVideo.mediaId, audioMediaId: outAudio && outAudio.mediaId, durationSec: clipSec }
        receipt.checks.push('F5 video-clip: 3s-6s clip materializes both video and audio artifacts of matching range and duration')
      }

      // (c) 声音调整：视频源倍速 2.0 → 产物时长减半；音频源也各验一条
      {
        const audioId = await importFixture(created.A, 'qa-fixtures/media/audio/A-MIX.wav', '调整源音频')
        const version = await stable(created.A)
        const patchArgs = {
          input: {
            projectId: created.A,
            expectedGraphVersion: version,
            ops: [
              { action: 'node.create', ref: 's-src', nodeType: 'audio', x: 60, y: 4300, media: { mediaId: audioId } },
              { action: 'node.create', ref: 's-adjust', nodeType: 'sound-adjust', x: 480, y: 4300, config: { mode: 'rate', rate: 2.0, volumePercent: 100, targetDurationMs: 0 } },
              { action: 'edge.create', from: { nodeId: 's-src', portId: 'out-audio' }, to: { nodeId: 's-adjust', portId: 'in-audio' } }
            ]
          },
          idempotencyKey: key()
        }
      let patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      // GUI 防抖保存可能在稳定读数与准入之间推进版本：预检冲突无副作用，重读后重试。
      for (let retry = 0; retry < 3 && patched.response.status !== 'completed' && patched.response.error?.code === 'REVISION_CONFLICT'; retry += 1) {
        await new Promise((done) => setTimeout(done, 1200))
        patchArgs.input.expectedGraphVersion = await stable(created.A)
        patchArgs.idempotencyKey = key()
        patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      }        check(patched.response.status === 'completed', `ADJUST_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
        const sNode = patched.response.data.created.find((c) => c.ref === 's-adjust')
        const waited = await executeAnd(created.A, patched.response.data.graphVersion, sNode.nodeId, 'ADJUST')
        check(waited.response.data.state === 'completed', `ADJUST_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
        const output = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: sNode.nodeId } })
        const adjusted = (output.response.data.outputs || []).find((o) => o.portId === 'out-audio')
        check(adjusted && (adjusted.mime || '').startsWith('audio/') && artifactOnDisk(adjusted.mediaPath), `ADJUST_ARTIFACT_INVALID:${JSON.stringify(output.response.data.outputs)}`)
        const abs = join(directory, (adjusted.mediaPath ?? '').replace(/\//g, sep))
        const out = require('node:child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs], { encoding: 'utf8', timeout: 20000 })
        const duration = Number(out.trim())
        check(Math.abs(duration - 5) < 0.8, `ADJUST_RATE_MISMATCH:${duration}`)
        receipt.adjust = { mediaId: adjusted.mediaId, durationSec: duration }
        receipt.checks.push('F5 sound-adjust: 2x rate adjustment halves duration via the same ffmpeg pipeline as GUI')
      }

      // (d) 时间线：轨道/片段结构编辑（graph.patch text 通道承载 timeline JSON）→ 合成成片
      {
        const videoId = await importFixture(created.A, 'qa-fixtures/media/video/V-AV.mp4', '时间线素材')
        const version = await stable(created.A)
        const timelineJson = JSON.stringify({
          schemaVersion: 1,
          frameRate: 30,
          tracks: [{ id: 't1', name: '轨道 1', muted: false, locked: false, visible: true }],
          clips: [
            {
              id: 'clip1',
              trackId: 't1',
              kind: 'video',
              mediaId: videoId,
              mediaPath: '',
              name: '验收片段',
              startMs: 0,
              durationMs: 4000,
              inMs: 1000,
              sourceDurationMs: 10000,
              volume: 1
            }
          ],
          references: [{ mediaId: videoId, mediaPath: '', name: '验收素材', kind: 'video' }]
        })
        const patchArgs = {
          input: {
            projectId: created.A,
            expectedGraphVersion: version,
            ops: [
              { action: 'node.create', ref: 'tl', nodeType: 'timeline', x: 60, y: 4700, text: timelineJson, config: { render: { width: 1280, height: 720 } } }
            ]
          },
          idempotencyKey: key()
        }
      let patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      // GUI 防抖保存可能在稳定读数与准入之间推进版本：预检冲突无副作用，重读后重试。
      for (let retry = 0; retry < 3 && patched.response.status !== 'completed' && patched.response.error?.code === 'REVISION_CONFLICT'; retry += 1) {
        await new Promise((done) => setTimeout(done, 1200))
        patchArgs.input.expectedGraphVersion = await stable(created.A)
        patchArgs.idempotencyKey = key()
        patched = await runCli(directory, ['graph', 'patch'], patchArgs)
      }        check(patched.response.status === 'completed', `TIMELINE_PATCH_FAILED:${JSON.stringify(patched.response.error)}`)
        const tlNode = patched.response.data.created.find((c) => c.ref === 'tl')
        // 编辑结构读取核对：node.get 返回的正文与提交一致（轨道/片段真实承载）
        const tlRead = await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: tlNode.nodeId } })
        const tlData = JSON.parse(tlRead.response.data.node.text || '{}')
        check(Array.isArray(tlData.tracks) && tlData.tracks.length === 1 && Array.isArray(tlData.clips) && tlData.clips.length === 1 && tlData.clips[0].durationMs === 4000, `TIMELINE_EDIT_NOT_PERSISTED:${JSON.stringify(tlData).slice(0, 200)}`)
        // 片段 mediaPath 由执行器在导入时补齐；外部只给 mediaId。先跑一次「链接导入」：
        // timeline 执行器要求 clip.mediaPath 真实；通过 node.update 把解析到的 mediaPath 写入。
        const mediaListed = await runCli(directory, ['media', 'list'], { input: { projectId: created.A, limit: 200 } })
        const videoAsset = mediaListed.response.data.items.find((m) => m.mediaId === videoId)
        const edited = await patchWithFreshVersion(directory, created.A, () => [
          {
            action: 'node.update',
            nodeId: tlNode.nodeId,
            text: JSON.stringify({
              ...tlData,
              clips: [{ ...tlData.clips[0], mediaPath: videoAsset.path }],
              references: [{ ...tlData.references[0], mediaPath: videoAsset.path }]
            })
          }
        ], 'TIMELINE_UPDATE_FAILED')
        // 二次编辑验证轨道结构可继续修改（加一条静音轨道），证明编辑不是一次性快照
        const tlRead2 = await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: tlNode.nodeId } })
        const tlData2 = JSON.parse(tlRead2.response.data.node.text || '{}')
        const tlJson2 = JSON.stringify({
          ...tlData2,
          tracks: [...tlData2.tracks, { id: 't2', name: '轨道 2', muted: true, locked: false, visible: true }]
        })
        const edited2 = await patchWithFreshVersion(directory, created.A, () => [
          { action: 'node.update', nodeId: tlNode.nodeId, text: tlJson2 }
        ], 'TIMELINE_TRACK_ADD_FAILED')
        const tlRead3 = await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: tlNode.nodeId } })
        const tlData3 = JSON.parse(tlRead3.response.data.node.text || '{}')
        check(tlData3.tracks.length === 2 && tlData3.tracks[1].muted === true && tlData3.clips.length === 1, 'TIMELINE_TRACK_ADD_NOT_PERSISTED')
        // 合成：执行时间线节点 → out-video 成片产物
        const waited = await executeAnd(created.A, edited2.response.data.graphVersion, tlNode.nodeId, 'TLRENDER')
        check(waited.response.data.state === 'completed', `TLRENDER_DID_NOT_COMPLETE:${waited.response.data.state}:${waited.response.data.error}`)
        const output = await runCli(directory, ['output', 'get'], { input: { projectId: created.A, nodeId: tlNode.nodeId } })
        const composed = (output.response.data.outputs || []).find((o) => o.portId === 'out-video')
        check(composed && (composed.mime || '').startsWith('video/') && artifactOnDisk(composed.mediaPath), `TLRENDER_ARTIFACT_INVALID:${JSON.stringify(output.response.data.outputs)}`)
        const renderSec = probeMediaDuration(composed.mediaPath)
        check(renderSec !== null && Math.abs(renderSec - 4) < 1.2, `TLRENDER_DURATION_MISMATCH:${renderSec}`)
        // 成片是独立资产（node-invariants）：不出现在 timeline 节点自身 mediaId
        const finalRead = await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: tlNode.nodeId } })
        check(!finalRead.response.data.node.mediaId, 'TLRENDER_WROTE_SELF_MEDIA')
        receipt.timeline = { composedMediaId: composed.mediaId, durationSec: renderSec, tracks: 2 }
        receipt.checks.push('F5 timeline: track/clip structure edits via graph.patch persist across reads, then compose materializes an independent 4s video artifact')
      }
    }

    // ── 6.8 F6 收尾：真实画布对话节点 ──
    // 外部 graph.patch(chat.patch) 追加用户消息 → GUI 对话面板 DOM 可见 → node.execute
    // 在无已验证模型连接时如实失败（与 GUI 同一执行器/原因）→ chat.messages 读回 →
    // 附件 mediaId 由宿主注入项目相对路径/MIME → 幂等重放不重复 → 跨项目 mediaId 拒绝。
    {
      const stable = (projectId) => stableProjectVersion(directory, projectId)
      const mediaCount = async (projectId) => {
        const listed = await runCli(directory, ['media', 'list'], { input: { projectId, limit: 200 } })
        return listed.response.data.total
      }
      // graph.patch 的 expectedGraphVersion 以权威读数为准；GUI 防抖保存可能在读取与
      // 准入之间推进版本。预检冲突无副作用，用新幂等键重读重试；只重试
      // REVISION_CONFLICT，其余失败立即抛出。
      const patchWithRetry = async (label, makeOps, attempts = 6) => {
        let lastError = null
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (attempt > 0) await new Promise((done) => setTimeout(done, 1200))
          const expectedGraphVersion = await stable(created.A)
          const input = { projectId: created.A, expectedGraphVersion, ops: makeOps() }
          const idempotencyKey = key()
          const result = await runCli(directory, ['graph', 'patch'], { input, idempotencyKey })
          if (result.response.status === 'completed') return { result, input, idempotencyKey }
          lastError = result.response.error
          if (lastError?.code !== 'REVISION_CONFLICT')
            throw new Error(`${label}:${JSON.stringify(lastError)}`)
        }
        throw new Error(`${label}:REVISION_CONFLICT:${JSON.stringify(lastError)}`)
      }

      // (a) 外部创建对话节点：权威宿主原子应用并正式保存，persisted 数据可读
      let chatNodeId = ''
      {
        const createdPatch = await patchWithRetry('F6_CHAT_NODE_CREATE_FAILED', () => [
          { action: 'node.create', ref: 'f6-chat', nodeType: 'chat', x: 480, y: 380, title: 'F6 对话验收' }
        ])
        const mapped = createdPatch.result.response.data.created.find((item) => item.ref === 'f6-chat')
        check(Boolean(mapped), 'F6_CHAT_NODE_MAPPING_MISSING')
        chatNodeId = mapped.nodeId
        const read = await runCli(directory, ['chat', 'read'], { input: { projectId: created.A, nodeId: chatNodeId } })
        check(
          read.response.status === 'completed' && read.response.data.nodeId === chatNodeId,
          `F6_CHAT_NODE_NOT_PERSISTED:${JSON.stringify(read.response.error)}`
        )
      }
      const readMessages = async (sessionId) => {
        const read = await runCli(directory, ['chat', 'messages'], {
          input: {
            projectId: created.A,
            nodeId: chatNodeId,
            limit: 200,
            ...(sessionId ? { sessionId } : {})
          }
        })
        check(read.response.status === 'completed', `F6_CHAT_MESSAGES_READ_FAILED:${JSON.stringify(read.response.error)}`)
        return read.response.data
      }

      // (b) 新建会话并追加第一条用户消息；chat.read/chat.messages 从持久化数据读回
      const MSG1 = 'F6 外部追加：对话面板应可见的第一条用户消息'
      const MSG2 = 'F6 外部追加：对话顺序验证的第二条用户消息'
      const MSG3 = 'F6 外部追加：宿主注入附件的第三条用户消息'
      const appendOne = await patchWithRetry('F6_CHAT_APPEND_FAILED', () => [
        {
          action: 'chat.patch',
          nodeId: chatNodeId,
          ops: [
            { action: 'chat.session.create', title: '外部会话 F6' },
            { action: 'chat.message.append', message: { role: 'user', content: MSG1 } }
          ]
        }
      ])
      const appendKey = appendOne.idempotencyKey
      const appendInput = appendOne.input
      const appended = appendOne.result
      const directoryRead = await runCli(directory, ['chat', 'read'], { input: { projectId: created.A, nodeId: chatNodeId } })
      check(directoryRead.response.status === 'completed', 'F6_CHAT_READ_FAILED')
      const catalog = directoryRead.response.data
      const activeSession = catalog.conversations.find((conversation) => conversation.active)
      check(
        Boolean(activeSession) && activeSession.title === '外部会话 F6' && activeSession.messageCount === 1,
        `F6_CHAT_SESSION_INVALID:${JSON.stringify(catalog.conversations)}`
      )
      const sessionId = activeSession.id
      const firstRead = await readMessages(sessionId)
      check(
        firstRead.total === 1 &&
          firstRead.messages[0].role === 'user' &&
          firstRead.messages[0].content === MSG1,
        `F6_CHAT_FIRST_READ_INVALID:${JSON.stringify(firstRead)}`
      )

      // (c) 同幂等键重放原回执：不重复追加消息
      const replayed = await runCli(directory, ['graph', 'patch'], { input: appendInput, idempotencyKey: appendKey })
      check(replayed.response.status === 'completed', 'F6_CHAT_REPLAY_FAILED')
      check(
        replayed.response.data.graphVersion === appended.response.data.graphVersion,
        'F6_CHAT_REPLAY_RECEIPT_DIVERGED'
      )
      const afterReplay = await readMessages(sessionId)
      check(afterReplay.total === 1, `F6_CHAT_REPLAY_DUPLICATED:${afterReplay.total}`)

      await patchWithRetry('F6_CHAT_SECOND_APPEND_FAILED', () => [
        {
          action: 'chat.patch',
          nodeId: chatNodeId,
          ops: [{ action: 'chat.message.append', message: { role: 'user', content: MSG2 } }]
        }
      ])

      // (d) 附件注入：外部输入只有 mediaId，宿主写项目相对路径与 MIME
      const mediaCountBefore = await mediaCount(created.A)
      const attachmentSource = join(appRoot, 'qa-fixtures/media/images/I-A.png')
      const importedAttachment = await runCli(directory, ['media', 'import'], {
        input: { projectId: created.A, filePath: attachmentSource, name: 'F6附件图' },
        idempotencyKey: key()
      })
      check(
        importedAttachment.response.status === 'completed',
        `F6_CHAT_MEDIA_IMPORT_FAILED:${JSON.stringify(importedAttachment.response.error)}`
      )
      const attachmentMediaId = importedAttachment.response.data.mediaId
      const attachmentAttempt = await patchWithRetry('F6_CHAT_ATTACH_FAILED', () => [
        {
          action: 'chat.patch',
          nodeId: chatNodeId,
          ops: [
            {
              action: 'chat.message.append',
              message: { role: 'user', content: MSG3, images: [{ mediaId: attachmentMediaId }] }
            }
          ]
        }
      ])
      const attachmentInput = attachmentAttempt.input
      // 外部输入不可携带路径/MIME：只有受控 mediaId。
      check(!JSON.stringify(attachmentInput).includes('projects/'), 'F6_CHAT_EXTERNAL_INPUT_HAS_PATH')
      check(!JSON.stringify(attachmentInput).includes('image/png'), 'F6_CHAT_EXTERNAL_INPUT_HAS_MIME')
      const allMessages = await readMessages(sessionId)
      check(allMessages.total === 3, `F6_CHAT_MESSAGE_COUNT:${allMessages.total}`)
      check(
        allMessages.messages.map((message) => message.role).join(',') === 'user,user,user' &&
          allMessages.messages[0].content === MSG1 &&
          allMessages.messages[1].content === MSG2 &&
          allMessages.messages[2].content === MSG3,
        `F6_CHAT_ORDER_MISMATCH:${JSON.stringify(allMessages.messages.map((message) => message.content))}`
      )
      const injectedImage = allMessages.messages[2].images?.[0]
      check(Boolean(injectedImage), 'F6_CHAT_ATTACHMENT_MISSING')
      check(injectedImage.mediaId === attachmentMediaId, 'F6_CHAT_ATTACHMENT_ID_MISMATCH')
      check(
        new RegExp(`^projects/${String(created.A).replace(/[^a-zA-Z0-9_-]/g, '\\$&')}/media/[^/]+$`).test(
          injectedImage.mediaPath
        ),
        `F6_CHAT_ATTACHMENT_PATH_NOT_INJECTED:${JSON.stringify(injectedImage)}`
      )
      check(injectedImage.mime === 'image/png', `F6_CHAT_ATTACHMENT_MIME_NOT_INJECTED:${injectedImage.mime}`)
      const attachmentAbs = join(directory, injectedImage.mediaPath.replace(/\//g, sep))
      check(existsSync(attachmentAbs), 'F6_CHAT_ATTACHMENT_FILE_MISSING')
      // 节点持久化正文（权威数据）同样携带注入路径/MIME，不是响应层拼装
      const chatNodeRead = await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: chatNodeId } })
      const persistedChat = JSON.parse(chatNodeRead.response.data.node.text)
      const persistedConversation = persistedChat.conversations.find(
        (conversation) => conversation.id === persistedChat.activeConversationId
      )
      check(
        Boolean(persistedConversation) &&
          persistedConversation.messages[2].images[0].mediaPath === injectedImage.mediaPath &&
          persistedConversation.messages[2].images[0].mime === 'image/png',
        'F6_CHAT_ATTACHMENT_NOT_IN_PERSISTED_TEXT'
      )

      // (e) GUI 可见性：真实对话面板 DOM + 附件图片实际加载（不是只看服务回执）
      const openChatDialog = async () => {
        // 标题行在 node-card-wrap 内、正文卡片 .node-card 之外：按包装定位并点击公共
        // “打开对话”按钮（与 GUI 手动入口同一 nodePanel store 动作）。
        const card = page.locator('.node-card-wrap').filter({ hasText: 'F6 对话验收' }).first()
        await card.waitFor({ timeout: 20000 })
        // NodePrimaryButton 由公共外壳 portal 到卡片底部操作栏，保留原始 className 在
        // data-original-action；这里点击与用户相同的主按钮“打开对话”。
        await card.locator('[data-original-action="chat-open-button"]').click()
        await page.locator('.chat-dialog').waitFor({ timeout: 20000 })
        if (!(await page.locator('.chat-dialog-messages').isVisible().catch(() => false))) {
          // 无已验证模型时面板默认展开设置页；用户同一点击“对话设置”可切回消息列表。
          await page.locator('button[aria-label="对话设置"]').click()
          await page.locator('.chat-dialog-messages').waitFor({ timeout: 10000 })
        }
      }
      const closeChatDialog = async () => {
        await page.locator('button[aria-label="关闭对话"]').click()
        await page.locator('.chat-dialog').waitFor({ state: 'detached', timeout: 10000 })
      }
      const guiMessages = async () =>
        await page.evaluate(() =>
          Array.from(document.querySelectorAll('.chat-dialog-message')).map((message) => ({
            role: message.getAttribute('aria-label'),
            text: message.querySelector('.chat-dialog-bubble')?.textContent ?? ''
          }))
        )
      await openChatDialog()
      const firstGui = await guiMessages()
      check(firstGui.length === 3, `F6_CHAT_GUI_MESSAGE_COUNT:${firstGui.length}`)
      check(
        firstGui[0].role === '用户消息' &&
          firstGui[0].text.includes(MSG1) &&
          firstGui[1].text.includes(MSG2) &&
          firstGui[2].text.includes(MSG3),
        `F6_CHAT_GUI_ORDER_MISMATCH:${JSON.stringify(firstGui.map((message) => message.text.slice(0, 40)))}`
      )
      await page.waitForFunction(
        () => {
          const image = document.querySelector('.chat-dialog-message .chat-dialog-image img')
          return Boolean(image && image.complete && image.naturalWidth > 0)
        },
        null,
        { timeout: 15000 }
      )
      const guiImage = await page.evaluate(() => {
        const image = document.querySelector('.chat-dialog-message .chat-dialog-image img')
        return image ? { src: image.getAttribute('src') ?? '', alt: image.getAttribute('alt') ?? '' } : null
      })
      check(
        Boolean(guiImage) && guiImage.src.includes('/media/'),
        `F6_CHAT_GUI_IMAGE_SRC_INVALID:${JSON.stringify(guiImage)}`
      )
      // 消息入场动画 280ms（opacity 0→1）：等首条消息真正完成绘制再截图，
      // 否则证据图可能是动画首帧的空列表。
      await page.waitForFunction(
        () => {
          const message = document.querySelector('.chat-dialog-message')
          return Boolean(message && Number(getComputedStyle(message).opacity) >= 0.99)
        },
        null,
        { timeout: 10000 }
      )
      await page.waitForTimeout(400)
      const guiShot = await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.webContents.invalidate()
        return (await window.webContents.capturePage()).toPNG().toString('base64')
      })
      await writeFile(join(evidence, 'milestone-f6-chat-dialog.png'), Buffer.from(guiShot, 'base64'))
      await closeChatDialog()

      // (f) node.execute：本地无已验证模型连接时与 GUI 一致地如实失败；不得伪造助手回复
      const textBeforeExecute = (
        await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: chatNodeId } })
      ).response.data.node.text
      const chatExecute = await runCli(directory, ['node', 'execute'], {
        input: {
          projectId: created.A,
          expectedGraphVersion: await stable(created.A),
          nodeIds: [chatNodeId],
          mode: 'single',
          confirmPaidRerun: false
        },
        idempotencyKey: key()
      })
      check(
        chatExecute.response.status === 'completed' && chatExecute.response.data.accepted === true,
        `F6_CHAT_EXECUTE_SUBMIT_FAILED:${JSON.stringify(chatExecute.response.error)}`
      )
      const chatTaskId = chatExecute.response.data.taskId
      const chatWaited = await runCli(
        directory,
        ['run', 'wait'],
        { input: { projectId: created.A, taskId: chatTaskId, timeoutMs: 60000 } },
        90000
      )
      check(
        chatWaited.response.status === 'completed' && chatWaited.response.data.state === 'failed',
        `F6_CHAT_EXECUTE_NOT_HONEST_FAILURE:${JSON.stringify(chatWaited.response.data)}`
      )
      const chatExecuteError = String(chatWaited.response.data.error ?? '')
      check(
        chatExecuteError.includes('尚未绑定已验证文本模型'),
        `F6_CHAT_EXECUTE_ERROR_NOT_GUI_CONSISTENT:${chatExecuteError}`
      )
      const afterExecute = await readMessages(sessionId)
      check(
        afterExecute.total === 3 && afterExecute.messages.every((message) => message.role === 'user'),
        `F6_CHAT_EXECUTE_FABRICATED_REPLY:${JSON.stringify(afterExecute.messages.map((message) => message.role))}`
      )
      const textAfterExecute = (
        await runCli(directory, ['node', 'get'], { input: { projectId: created.A, nodeId: chatNodeId } })
      ).response.data.node.text
      check(textAfterExecute === textBeforeExecute, 'F6_CHAT_EXECUTE_MUTATED_CONVERSATION')
      await openChatDialog()
      const afterExecuteGui = await guiMessages()
      check(
        afterExecuteGui.length === 3 && afterExecuteGui.every((message) => message.role === '用户消息'),
        `F6_CHAT_EXECUTE_GUI_FABRICATED:${JSON.stringify(afterExecuteGui.map((message) => message.role))}`
      )
      await closeChatDialog()

      // (g) 跨项目 mediaId：main 预检拒绝且不留半条消息/孤儿媒体
      const importedForeign = await runCli(directory, ['media', 'import'], {
        input: { projectId: created.B, filePath: attachmentSource, name: 'B项目附件' },
        idempotencyKey: key()
      })
      check(importedForeign.response.status === 'completed', 'F6_CHAT_FOREIGN_IMPORT_FAILED')
      const foreignMediaId = importedForeign.response.data.mediaId
      const foreign = await runCli(directory, ['graph', 'patch'], {
        input: {
          projectId: created.A,
          expectedGraphVersion: await stable(created.A),
          ops: [
            {
              action: 'chat.patch',
              nodeId: chatNodeId,
              ops: [
                {
                  action: 'chat.message.append',
                  message: {
                    role: 'user',
                    content: '不应写入的跨项目附件消息',
                    images: [{ mediaId: foreignMediaId }]
                  }
                }
              ]
            }
          ]
        },
        idempotencyKey: key()
      })
      check(
        foreign.response.status === 'failed' && foreign.response.error?.code === 'MEDIA_NOT_FOUND',
        `F6_CHAT_FOREIGN_MEDIA_NOT_REJECTED:${JSON.stringify(foreign.response.error)}`
      )
      const afterForeign = await readMessages(sessionId)
      check(afterForeign.total === 3, `F6_CHAT_FOREIGN_LEFT_HALF_MESSAGE:${afterForeign.total}`)
      check((await mediaCount(created.A)) === mediaCountBefore + 1, 'F6_CHAT_FOREIGN_LEFT_ORPHAN_MEDIA')

      // (h) 混批防御：chat.patch 与几何 op 同批 → 准入前拒绝，不静默丢弃几何 op
      const mixed = await runCli(directory, ['graph', 'patch'], {
        input: {
          projectId: created.A,
          expectedGraphVersion: await stable(created.A),
          ops: [
            { action: 'node.create', nodeType: 'text', x: 60, y: 3400, title: '不应存在的混批节点' },
            {
              action: 'chat.patch',
              nodeId: chatNodeId,
              ops: [{ action: 'chat.message.append', message: { role: 'user', content: '不应写入的混批消息' } }]
            }
          ]
        },
        idempotencyKey: key()
      })
      check(
        mixed.response.status === 'failed' && mixed.response.error?.code === 'MIXED_PATCH_UNSUPPORTED',
        `F6_CHAT_MIXED_PATCH_NOT_REJECTED:${JSON.stringify(mixed.response.error)}`
      )
      check((await readMessages(sessionId)).total === 3, 'F6_CHAT_MIXED_PATCH_LEFT_MESSAGE')
      const graphAfterMixed = await runCli(directory, ['graph', 'get'], { input: { projectId: created.A } })
      check(
        !graphAfterMixed.response.data.nodes.some((node) => node.title === '不应存在的混批节点'),
        'F6_CHAT_MIXED_PATCH_LEFT_NODE'
      )

      receipt.chat = {
        nodeId: chatNodeId,
        sessionId,
        messages: allMessages.messages.map((message) => ({ role: message.role, content: message.content })),
        attachment: { mediaId: injectedImage.mediaId, mediaPath: injectedImage.mediaPath, mime: injectedImage.mime },
        idempotentReplay: { graphVersion: replayed.response.data.graphVersion, totalAfterReplay: afterReplay.total },
        gui: { messageBubbles: firstGui.length, imageLoaded: true, screenshot: 'milestone-f6-chat-dialog.png' },
        execute: {
          taskId: chatTaskId,
          state: chatWaited.response.data.state,
          error: chatExecuteError,
          modelPath: 'none: isolated data dir has no verified text model connection (same failure as GUI)'
        },
        crossProjectMedia: {
          attemptedMediaId: foreignMediaId,
          code: foreign.response.error?.code,
          totalAfter: afterForeign.total
        },
        mixedBatch: {
          code: mixed.response.error?.code,
          totalAfterMixed: 3,
          nodeCreated: graphAfterMixed.response.data.nodes.some((node) => node.title === '不应存在的混批节点')
        }
      }
      receipt.checks.push(
        'F6 chat: external graph.patch creates a real canvas chat node; chat.patch appends a user message that the GUI dialog really renders'
      )
      receipt.checks.push(
        'F6 chat: chat.messages read-back preserves user message order/content; the same idempotency key replays the original receipt without duplicating messages'
      )
      receipt.checks.push(
        'F6 chat attachment: mediaId-only input is resolved by the host into project-relative path and MIME in persisted data and GUI image; cross-project mediaId is rejected with MEDIA_NOT_FOUND and leaves no half message'
      )
      receipt.checks.push(
        'F6 chat execute: with no verified text model the run fails honestly with the same reason as GUI; no fabricated assistant reply'
      )
      receipt.checks.push(
        'F6 chat guard: a chat.patch mixed with geometry ops is rejected before admission (MIXED_PATCH_UNSUPPORTED); neither a node nor a message is half-applied'
      )
    }

    // ── 6.9 F6 收尾：导演台外部发布授权（manual-publish 必须由人授权）──
    // 外部只能 prepare（登记待授权请求）→ 人在 GUI 确认弹窗点「允许发布」→ continue 才执行；
    // 发布渲染与正式记录写入复用 GUI 面板同一发布服务；node.execute 永远不发布。
    {
      const stable = (projectId) => stableProjectVersion(directory, projectId)
      // (a) 外部创建导演台节点并正式保存
      let directorNodeId = ''
      for (let attempt = 0; attempt < 6 && !directorNodeId; attempt++) {
        if (attempt > 0) await new Promise((done) => setTimeout(done, 1200))
        const expectedGraphVersion = await stable(created.A)
        const patched = await runCli(directory, ['graph', 'patch'], {
          input: {
            projectId: created.A,
            expectedGraphVersion,
            ops: [
              {
                action: 'node.create',
                ref: 'f6-director',
                nodeType: 'director',
                x: 760,
                y: 380,
                title: 'F6 发布授权验收'
              }
            ]
          },
          idempotencyKey: key()
        })
        if (patched.response.status === 'completed') {
          directorNodeId =
            patched.response.data.created.find((item) => item.ref === 'f6-director')?.nodeId ?? ''
        } else if (patched.response.error?.code !== 'REVISION_CONFLICT') {
          throw new Error(`F6_PUBLISH_NODE_CREATE_FAILED:${JSON.stringify(patched.response.error)}`)
        }
      }
      check(Boolean(directorNodeId), 'F6_PUBLISH_NODE_MAPPING_MISSING')

      // 申请发布以权威读数为版本；GUI 防抖保存可能在读取与准入之间推进版本，
      // 预检冲突无副作用，用新幂等键重试。授权与版本绑定，版本漂移必须重新申请。
      const prepareOnce = async () => {
        let lastError = null
        for (let attempt = 0; attempt < 6; attempt++) {
          if (attempt > 0) await new Promise((done) => setTimeout(done, 1200))
          const expectedGraphVersion = await stable(created.A)
          const prepared = await runCli(directory, ['director', 'publish', 'prepare'], {
            input: { projectId: created.A, nodeId: directorNodeId, mode: 'frame', expectedGraphVersion },
            idempotencyKey: key()
          })
          if (prepared.response.status === 'completed') return { prepared, expectedGraphVersion }
          lastError = prepared.response.error
          if (lastError?.code !== 'REVISION_CONFLICT')
            throw new Error(`F6_PUBLISH_PREPARE_FAILED:${JSON.stringify(lastError)}`)
        }
        throw new Error(`F6_PUBLISH_PREPARE_FAILED:REVISION_CONFLICT:${JSON.stringify(lastError)}`)
      }
      const waitStatus = async (publishRequestId, expected, attempts = 40) => {
        for (let attempt = 0; attempt < attempts; attempt++) {
          const status = await runCli(directory, ['director', 'publish', 'status'], {
            input: { projectId: created.A, publishRequestId }
          })
          if (
            status.response.status === 'completed' &&
            status.response.data.status === expected
          )
            return status.response.data
          await new Promise((done) => setTimeout(done, 500))
        }
        return null
      }

      // (b) 授权 → 执行。版本若在人工确认期间前进，按“必须重新申请”重来。
      let publishRequestId = ''
      let continueInput = null
      let continued = null
      for (let attempt = 0; attempt < 3 && !continued; attempt++) {
        const prepared = await prepareOnce()
        publishRequestId = prepared.prepared.response.data.publishRequestId
        check(
          prepared.prepared.response.data.status === 'awaiting-authorization' &&
            prepared.prepared.response.data.authorizationRequired === true,
          `F6_PUBLISH_NOT_AWAITING_AUTHORIZATION:${JSON.stringify(prepared.prepared.response.data)}`
        )
        // 人真的在 GUI 上确认：复用应用自己的确认弹窗（外部没有授权通道）。
        const dialog = page.locator('.confirm-dialog')
        await dialog.waitFor({ timeout: 20000 })
        const dialogText = (await dialog.textContent()) ?? ''
        check(dialogText.includes('外部发布请求'), `F6_PUBLISH_GUI_CONFIRM_TEXT:${dialogText.slice(0, 80)}`)
        await dialog.locator('.confirm-btn.primary').click()
        const authorized = await waitStatus(publishRequestId, 'authorized')
        check(Boolean(authorized), 'F6_PUBLISH_NOT_AUTHORIZED_AFTER_GUI_CLICK')
        const versionNow = await stable(created.A)
        if (versionNow !== prepared.expectedGraphVersion) continue
        const idempotencyKey = key()
        const input = {
          projectId: created.A,
          publishRequestId,
          expectedGraphVersion: prepared.expectedGraphVersion
        }
        const result = await runCli(directory, ['director', 'publish', 'continue'], {
          input,
          idempotencyKey
        })
        if (result.response.status === 'completed') {
          continued = { result, input, idempotencyKey }
          continueInput = input
        } else if (result.response.error?.code !== 'REVISION_CONFLICT') {
          throw new Error(`F6_PUBLISH_CONTINUE_FAILED:${JSON.stringify(result.response.error)}`)
        }
      }
      check(Boolean(continued), 'F6_PUBLISH_CONTINUE_NEVER_COMPLETED')
      const artifact = continued.result.response.data.artifact
      check(
        Boolean(artifact?.mediaId) && artifact.mime === 'image/png',
        `F6_PUBLISH_ARTIFACT_INVALID:${JSON.stringify(artifact)}`
      )
      check(
        existsSync(join(directory, artifact.mediaPath.replace(/\//g, sep))),
        'F6_PUBLISH_ARTIFACT_MISSING_ON_DISK'
      )
      // 正式输出投影：manual-publish 门控的导演台输出必须指向这次发布的帧。
      const published = await runCli(directory, ['output', 'get'], {
        input: { projectId: created.A, nodeId: directorNodeId }
      })
      check(
        published.response.status === 'completed' &&
          published.response.data.outputSource === 'manual-publish',
        `F6_PUBLISH_OUTPUT_FAILED:${JSON.stringify(published.response.error)}`
      )
      const projected = (published.response.data.outputs ?? []).filter(
        (entry) => entry.mediaId === artifact.mediaId
      )
      check(projected.length > 0, 'F6_PUBLISH_OUTPUT_NOT_PROJECTED')
      // 幂等重放：同一幂等键返回原回执，不再渲染第二份产物。
      const replay = await runCli(directory, ['director', 'publish', 'continue'], {
        input: continueInput,
        idempotencyKey: continued.idempotencyKey
      })
      check(
        replay.response.status === 'completed' &&
          replay.response.data.artifact.mediaId === artifact.mediaId,
        `F6_PUBLISH_REPLAY_DIVERGED:${JSON.stringify(replay.response.error)}`
      )

      // (c) 人拒绝：请求作废，continue 被拒，且不产生第二份产物。
      const secondPrepared = await prepareOnce()
      const secondRequestId = secondPrepared.prepared.response.data.publishRequestId
      await page.locator('.confirm-dialog').waitFor({ timeout: 20000 })
      await page.locator('.confirm-dialog .confirm-btn.cancel').click()
      const denied = await waitStatus(secondRequestId, 'denied')
      check(Boolean(denied), 'F6_PUBLISH_NOT_DENIED')
      const deniedContinue = await runCli(directory, ['director', 'publish', 'continue'], {
        input: {
          projectId: created.A,
          publishRequestId: secondRequestId,
          expectedGraphVersion: secondPrepared.expectedGraphVersion
        },
        idempotencyKey: key()
      })
      check(
        deniedContinue.response.status === 'failed' &&
          deniedContinue.response.error?.code === 'PUBLISH_DENIED',
        `F6_PUBLISH_DENIED_CONTINUE:${JSON.stringify(deniedContinue.response.error)}`
      )

      receipt.publish = {
        nodeId: directorNodeId,
        publishRequestId,
        artifact,
        outputSource: published.response.data.outputSource,
        deniedCode: deniedContinue.response.error?.code
      }
      receipt.checks.push(
        'F6 publish: manual-publish is not smuggled through node.execute; the external prepare only registers a pending request and a human authorizes it in the GUI confirm dialog'
      )
      receipt.checks.push(
        'F6 publish: after human authorization the host renders with the same GUI publish service, writes the formal publish record, the artifact exists on disk and output.get projects it as manual-publish'
      )
      receipt.checks.push(
        'F6 publish: when the human denies, the request is revoked and continue fails with PUBLISH_DENIED without producing a second artifact'
      )
    }

    // ── 6.10 音频族零成本桌面验收：speech / tts / voice-design ──
    // 用户明确要求验收阶段不做真实音色克隆/音色设计产物（会触发付费请求）。
    // 本段只做：外部 graph.patch 建节点 → GUI 卡片真实可见（不打开编辑器、不点合成/试听/生成）
    // → node.execute 的真实门禁（缺参考音频/缺已验证模型）→ 无媒体副作用。
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
    {
      const AUDIO_SPECS = [
        {
          ref: 'f7-speech',
          nodeType: 'speech',
          title: 'F7 语音合成验收',
          x: 120,
          y: 740,
          text: '这是一段用于验收的朗读文本。',
          config: { backend: 'minimax' },
          expectedReason: '功能 speech.synthesize 尚未绑定已验证语音模型'
        },
        {
          ref: 'f7-tts',
          nodeType: 'tts',
          title: 'F7 语音克隆验收',
          x: 560,
          y: 740,
          config: { backend: 'minimax', modelId: 'speech-2.8-turbo' },
          expectedReason: '缺少参考语音'
        },
        {
          ref: 'f7-voice-design',
          nodeType: 'voice-design',
          title: 'F7 音色设计验收',
          x: 1000,
          y: 740,
          text: '清亮、略带磁性的青年女声，语速偏慢，语气温柔。',
          config: { previewText: '你好，很高兴认识你。' },
          expectedReason: '功能 voice.design 尚未绑定已验证音色设计模型'
        }
      ]
      const audioPatch = await patchWithFreshVersion(
        directory,
        created.A,
        () =>
          AUDIO_SPECS.map((spec) => ({
            action: 'node.create',
            ref: spec.ref,
            nodeType: spec.nodeType,
            x: spec.x,
            y: spec.y,
            title: spec.title,
            ...(spec.text !== undefined ? { text: spec.text } : {}),
            ...(spec.config !== undefined ? { config: spec.config } : {})
          })),
        'F7_AUDIO_NODE_CREATE_FAILED'
      )
      check(
        audioPatch.response.data.applied.nodeCreated === AUDIO_SPECS.length,
        `F7_AUDIO_NODE_COUNTS:${JSON.stringify(audioPatch.response.data.applied)}`
      )
      const audioNodes = AUDIO_SPECS.map((spec) => {
        const mapped = audioPatch.response.data.created.find((item) => item.ref === spec.ref)
        check(Boolean(mapped), `F7_AUDIO_NODE_MAPPING:${spec.ref}`)
        return { ...spec, nodeId: mapped.nodeId }
      })
      // 数据级读回：类型/标题/正文/配置必须是真实 JSON 配置（不是空壳）。
      for (const spec of audioNodes) {
        const read = await runCli(directory, ['node', 'get'], {
          input: { projectId: created.A, nodeId: spec.nodeId }
        })
        check(
          read.response.status === 'completed',
          `F7_AUDIO_NODE_READ_FAILED:${spec.ref}:${JSON.stringify(read.response.error)}`
        )
        const audioNode = read.response.data.node
        check(audioNode.type === spec.nodeType, `F7_AUDIO_NODE_TYPE:${spec.ref}:${audioNode.type}`)
        check(audioNode.title === spec.title, `F7_AUDIO_NODE_TITLE:${spec.ref}:${audioNode.title}`)
        check(
          Boolean(audioNode.config) &&
            typeof audioNode.config === 'object' &&
            !Array.isArray(audioNode.config),
          `F7_AUDIO_NODE_CONFIG_NOT_JSON:${spec.ref}:${JSON.stringify(audioNode.config)}`
        )
        if (spec.text !== undefined)
          check(audioNode.text === spec.text, `F7_AUDIO_NODE_TEXT:${spec.ref}`)
      }
      // GUI 可见性：三个节点卡片真实出现在画布 DOM 中（按标题定位 node-card-wrap）。
      // 全程不打开编辑器、不点“合成/试听/生成”，因此不会产生任何付费请求。
      await page.locator('.node-palette').waitFor({ timeout: 30000 }).catch(() => {})
      for (const spec of audioNodes) {
        await page
          .locator('.node-card-wrap')
          .filter({ hasText: spec.title })
          .first()
          .waitFor({ timeout: 20000 })
      }

      const mediaTotal = async (projectId) => {
        const listed = await runCli(directory, ['media', 'list'], { input: { projectId, limit: 200 } })
        check(listed.response.status === 'completed', 'F7_AUDIO_MEDIA_LIST_FAILED')
        return listed.response.data.total
      }
      const mediaBefore = await mediaTotal(created.A)
      const audioResults = {}
      for (const spec of audioNodes) {
        const executed = await runCli(directory, ['node', 'execute'], {
          input: {
            projectId: created.A,
            expectedGraphVersion: await stableProjectVersion(directory, created.A),
            nodeIds: [spec.nodeId],
            mode: 'single',
            confirmPaidRerun: false
          },
          idempotencyKey: key()
        })
        check(
          executed.response.status === 'completed' && executed.response.data.accepted === true,
          `F7_AUDIO_EXECUTE_REJECTED:${spec.ref}:${JSON.stringify(executed.response.error)}`
        )
        const taskId = executed.response.data.taskId
        const waited = await runCli(
          directory,
          ['run', 'wait'],
          { input: { projectId: created.A, taskId, timeoutMs: 60000 } },
          90000
        )
        const state = waited.response.data.state
        const reason = String(waited.response.data.error ?? '')
        check(
          state === 'failed' || state === 'skipped',
          `F7_AUDIO_GATE_STATE:${spec.ref}:${state}:${reason}`
        )
        check(reason.includes(spec.expectedReason), `F7_AUDIO_GATE_REASON:${spec.ref}:${reason}`)
        const read = await runCli(directory, ['node', 'get'], {
          input: { projectId: created.A, nodeId: spec.nodeId }
        })
        check(read.response.status === 'completed', `F7_AUDIO_EXEC_READ_FAILED:${spec.ref}`)
        check(
          read.response.data.node.exec !== 'success',
          `F7_AUDIO_EXEC_MARKED_SUCCESS:${spec.ref}:${read.response.data.node.exec}`
        )
        // output.get 不得给出伪造的媒体输出：无产物时为空 / 无投影契约时明确拒绝。
        const output = await runCli(directory, ['output', 'get'], {
          input: { projectId: created.A, nodeId: spec.nodeId }
        })
        let outputShape = 'empty'
        if (output.response.status === 'completed') {
          const outputs = output.response.data.outputs ?? []
          check(
            outputs.every((entry) => !['image', 'audio', 'video'].includes(entry.kind)),
            `F7_AUDIO_OUTPUT_FABRICATED:${spec.ref}:${JSON.stringify(outputs)}`
          )
          outputShape = outputs.length
            ? JSON.stringify(outputs.map((entry) => entry.portId))
            : 'empty'
        } else {
          check(
            output.response.error?.code === 'UNSUPPORTED_CONTRACT',
            `F7_AUDIO_OUTPUT_UNEXPECTED:${spec.ref}:${JSON.stringify(output.response.error)}`
          )
          outputShape = `unsupported:${output.response.error?.code}`
        }
        audioResults[spec.ref] = {
          nodeId: spec.nodeId,
          nodeType: spec.nodeType,
          taskId,
          state,
          reason,
          exec: read.response.data.node.exec,
          output: outputShape
        }
      }
      const mediaAfter = await mediaTotal(created.A)
      check(mediaAfter === mediaBefore, `F7_AUDIO_MEDIA_SIDE_EFFECT:${mediaBefore}->${mediaAfter}`)
      receipt.audioFamily = {
        nodes: audioResults,
        media: { before: mediaBefore, after: mediaAfter },
        paidRequests:
          'none: executors gate on missing reference audio / unbound verified voice models before any gateway call'
      }
      receipt.checks.push(
        'F7 audio: external graph.patch creates speech/tts/voice-design nodes; node.get reads back their types, titles and JSON configs and all three render as GUI node cards without opening an editor'
      )
      receipt.checks.push(
        'F7 audio: tts without reference audio is honestly gated with 缺少参考语音 and no success state, so no voice-clone request is sent'
      )
      receipt.checks.push(
        'F7 audio: speech and voice-design without a verified model are gated with the executor reasons 功能 speech.synthesize 尚未绑定已验证语音模型 / 功能 voice.design 尚未绑定已验证音色设计模型'
      )
      receipt.checks.push(
        'F7 audio: zero paid side effects — media.list count is unchanged, output.get exposes no fabricated image/audio/video output and node exec is not success'
      )
    }

    // ── 6.11 F7 资源库物化：CLI 建资源 → 物化到当前画布 → 受控媒体落盘 → 重启存活 ──
    // 当前活动画布是 A。物化要求目标画布已打开（ACTIVE_PROJECT_REQUIRED），链路与 GUI
    // 同一份实现：复制资源 blob 为项目受控媒体 → graph-patch 权威宿主应用 → 正式保存。
    {
      const fixture = join(appRoot, 'qa-fixtures/media/images/I-A.png')
      const fixtureBytes = await readFile(fixture)
      const createdResource = await runCli(directory, ['library', 'resource', 'create'], {
        input: {
          title: 'F7 资源库物化验收图',
          formPreset: 'image',
          description: '桌面验收：本地 png → 资源库 → 物化到画布',
          components: [{ role: '主图', valueType: 'image', filePath: fixture }]
        },
        idempotencyKey: key()
      })
      check(
        createdResource.response.status === 'completed',
        `F7_LIBRARY_CREATE_FAILED:${JSON.stringify(createdResource.response.error)}`
      )
      const resource = createdResource.response.data
      const resourceComponent = resource.components.find((component) => component.valueType === 'image')
      check(
        Boolean(resourceComponent) && resourceComponent.hasBlob === true,
        `F7_LIBRARY_COMPONENT_MISSING_BLOB:${JSON.stringify(resource.components)}`
      )
      check(
        resourceComponent.sizeBytes === fixtureBytes.byteLength,
        `F7_LIBRARY_BLOB_SIZE:${resourceComponent.sizeBytes}!=${fixtureBytes.byteLength}`
      )

      // 物化：expectedGraphVersion 取权威稳定读数；GUI 防抖保存可能在读数与准入之间
      // 推进版本（预检冲突无副作用，重读后重试）。
      let materialized = null
      let lastMaterializeError = null
      for (let attempt = 0; attempt < 6 && !materialized; attempt++) {
        if (attempt > 0) await sleep(1200)
        const attemptResult = await runCli(directory, ['library', 'resource', 'materialize'], {
          input: {
            projectId: created.A,
            resourceId: resource.resourceId,
            revisionId: resource.selectedRevisionId,
            componentIds: [resourceComponent.componentId],
            expectedGraphVersion: await stableProjectVersion(directory, created.A),
            x: 120,
            y: 5100
          },
          idempotencyKey: key()
        })
        if (attemptResult.response.status === 'completed') materialized = attemptResult
        else {
          lastMaterializeError = attemptResult.response.error
          if (lastMaterializeError?.code !== 'REVISION_CONFLICT')
            throw new Error(`F7_LIBRARY_MATERIALIZE_FAILED:${JSON.stringify(lastMaterializeError)}`)
        }
      }
      check(
        Boolean(materialized),
        `F7_LIBRARY_MATERIALIZE_FAILED:${JSON.stringify(lastMaterializeError)}`
      )
      const materializeData = materialized.response.data
      check(materializeData.saved === true, 'F7_LIBRARY_MATERIALIZE_NOT_SAVED')
      check(
        materializeData.assetCount === 1 && materializeData.nodes.length === 1,
        `F7_LIBRARY_MATERIALIZE_ASSETS:${materializeData.assetCount}/${materializeData.nodes.length}`
      )
      const materializedNode = materializeData.nodes[0]
      check(
        materializedNode.nodeType === 'image',
        `F7_LIBRARY_MATERIALIZE_NODE_TYPE:${materializedNode.nodeType}`
      )
      check(Boolean(materializedNode.mediaId), 'F7_LIBRARY_MATERIALIZE_NO_MEDIA')

      const graphAfterMaterialize = await runCli(directory, [
        'graph',
        'get'
      ], { input: { projectId: created.A, limit: 200 } })
      check(
        graphAfterMaterialize.response.data.nodes.some(
          (entry) => entry.nodeId === materializedNode.nodeId
        ),
        'F7_LIBRARY_MATERIALIZED_NODE_NOT_IN_GRAPH'
      )
      const nodeRead = await runCli(directory, ['node', 'get'], {
        input: { projectId: created.A, nodeId: materializedNode.nodeId }
      })
      check(
        nodeRead.response.status === 'completed',
        `F7_LIBRARY_NODE_READ_FAILED:${JSON.stringify(nodeRead.response.error)}`
      )
      const materializedRead = nodeRead.response.data.node
      check(
        materializedRead.mediaId === materializedNode.mediaId,
        `F7_LIBRARY_NODE_MEDIA_MISMATCH:${materializedRead.mediaId}`
      )
      const mediaPath = String(materializedRead.mediaPath ?? '')
      check(
        mediaPath.startsWith(`projects/${created.A}/media/`),
        `F7_LIBRARY_MEDIA_NOT_PROJECT_CONTROLLED:${mediaPath}`
      )
      check(!mediaPath.includes('library/'), `F7_LIBRARY_MEDIA_IS_LIBRARY_BLOB:${mediaPath}`)
      const materializedAbs = join(directory, mediaPath.replace(/\//g, sep))
      const diskBytes = await readFile(materializedAbs).catch(() => null)
      check(Boolean(diskBytes) && diskBytes.byteLength > 0, 'F7_LIBRARY_MEDIA_FILE_MISSING')
      check(
        diskBytes.byteLength === fixtureBytes.byteLength,
        `F7_LIBRARY_MEDIA_BYTES:${diskBytes.byteLength}!=${fixtureBytes.byteLength}`
      )
      check(
        Buffer.compare(Buffer.from(diskBytes), fixtureBytes) === 0,
        'F7_LIBRARY_MEDIA_BYTES_DIFFER'
      )
      const mediaIndex = await runCli(directory, ['media', 'list'], {
        input: { projectId: created.A, limit: 200 }
      })
      check(
        mediaIndex.response.data.items.some((item) => item.mediaId === materializedNode.mediaId),
        'F7_LIBRARY_MEDIA_NOT_INDEXED'
      )
      const detailAfterMaterialize = await runCli(directory, ['library', 'resource', 'get'], {
        input: { resourceId: resource.resourceId }
      })
      const resourceUsage = (detailAfterMaterialize.response.data.usages ?? []).find(
        (entry) => entry.projectId === created.A
      )
      check(
        Boolean(resourceUsage) && resourceUsage.materializedNodeCount >= 1,
        'F7_LIBRARY_USAGE_NOT_RECORDED'
      )

      // 重启应用：物化节点与受控媒体必须仍在（项目正式持久化 + 媒体落盘）。
      await app.close()
      app = undefined
      ;({ app, page } = await launchLicensedApp(directory))
      const reopened = await runCli(directory, ['project', 'open'], {
        input: { projectId: created.A },
        idempotencyKey: key()
      })
      check(
        reopened.response.status === 'completed',
        `F7_LIBRARY_REOPEN_FAILED:${JSON.stringify(reopened.response.error)}`
      )
      await page.locator('.node-palette').waitFor({ timeout: 30000 })
      const graphAfterRestart = await runCli(directory, ['graph', 'get'], {
        input: { projectId: created.A, limit: 200 }
      })
      check(
        graphAfterRestart.response.data.nodes.some(
          (entry) => entry.nodeId === materializedNode.nodeId
        ),
        'F7_LIBRARY_NODE_LOST_AFTER_RESTART'
      )
      const nodeAfterRestart = await runCli(directory, ['node', 'get'], {
        input: { projectId: created.A, nodeId: materializedNode.nodeId }
      })
      check(
        nodeAfterRestart.response.status === 'completed' &&
          nodeAfterRestart.response.data.node.mediaId === materializedNode.mediaId,
        'F7_LIBRARY_MEDIA_LOST_AFTER_RESTART'
      )
      check(
        existsSync(
          join(directory, String(nodeAfterRestart.response.data.node.mediaPath).replace(/\//g, sep))
        ),
        'F7_LIBRARY_MEDIA_FILE_LOST_AFTER_RESTART'
      )

      receipt.library = {
        resourceId: resource.resourceId,
        revisionId: resource.selectedRevisionId,
        componentId: resourceComponent.componentId,
        blob: { hasBlob: resourceComponent.hasBlob, sizeBytes: resourceComponent.sizeBytes },
        materialize: {
          usageId: materializeData.usageId,
          graphVersion: materializeData.graphVersion,
          nodeId: materializedNode.nodeId,
          mediaId: materializedNode.mediaId,
          mediaPath,
          bytes: diskBytes.byteLength
        },
        restart: { nodeId: materializedNode.nodeId, mediaId: materializedNode.mediaId }
      }
      receipt.checks.push(
        'F7 library: CLI library.resource.create imports a local PNG into the resource library (blob stored, byte size equals the source file)'
      )
      receipt.checks.push(
        'F7 library: library.resource.materialize creates a canvas image node via the authoritative host; graph.get and node.get see it after a formal save'
      )
      receipt.checks.push(
        'F7 library: the materialized node references a project-controlled media copy (projects/<id>/media, readable on disk with identical bytes), not the resource-library blob'
      )
      receipt.checks.push(
        'F7 library: the materialized node and its media file survive an app restart unchanged'
      )
    }

    // ── 6.12 F7 节点库组合与跨画布实例化 ──
    // 在 A 建 2-3 节点 + 连线（含一份 media.import 的图片）→ node.library.compose 保存组合
    // → project.open(B) 后在 B 上 node.library.insert → 比对节点/连线/媒体重映射与幂等重放。
    {
      const fixture = join(appRoot, 'qa-fixtures/media/images/I-A.png')
      const imported = await runCli(directory, ['media', 'import'], {
        input: { projectId: created.A, filePath: fixture, name: 'F7节点库组合素材' },
        idempotencyKey: key()
      })
      check(
        imported.response.status === 'completed',
        `F7_NODE_LIBRARY_MEDIA_IMPORT_FAILED:${JSON.stringify(imported.response.error)}`
      )
      const sourceMediaId = imported.response.data.mediaId

      const composedPatch = await patchWithFreshVersion(
        directory,
        created.A,
        () => [
          {
            action: 'node.create',
            ref: 'lib-img',
            nodeType: 'image',
            x: 120,
            y: 5500,
            title: 'F7 组合图片',
            media: { mediaId: sourceMediaId }
          },
          {
            action: 'node.create',
            ref: 'lib-crop-a',
            nodeType: 'image-crop',
            x: 520,
            y: 5500,
            title: 'F7 组合裁剪甲',
            config: { mode: 'rect', aspectRatio: 'free', rect: { x: 0.1, y: 0.1, width: 0.6, height: 0.6 } }
          },
          {
            action: 'node.create',
            ref: 'lib-crop-b',
            nodeType: 'image-crop',
            x: 920,
            y: 5500,
            title: 'F7 组合裁剪乙',
            config: { mode: 'quad', aspectRatio: 'free', points: [[0, 0], [1, 0], [1, 1], [0, 1]] }
          },
          {
            action: 'edge.create',
            ref: 'lib-e1',
            from: { nodeId: 'lib-img', portId: 'out-image' },
            to: { nodeId: 'lib-crop-a', portId: 'in-image' }
          },
          {
            action: 'edge.create',
            ref: 'lib-e2',
            from: { nodeId: 'lib-crop-a', portId: 'out-image' },
            to: { nodeId: 'lib-crop-b', portId: 'in-image' }
          }
        ],
        'F7_NODE_LIBRARY_SOURCE_PATCH_FAILED'
      )
      const sourceNodeIds = ['lib-img', 'lib-crop-a', 'lib-crop-b'].map((ref) => {
        const mapped = composedPatch.response.data.created.find((item) => item.ref === ref)
        check(Boolean(mapped), `F7_NODE_LIBRARY_SOURCE_MAPPING:${ref}`)
        return mapped.nodeId
      })
      check(
        composedPatch.response.data.applied.nodeCreated === 3 &&
          composedPatch.response.data.applied.edgeCreated === 2,
        `F7_NODE_LIBRARY_SOURCE_COUNTS:${JSON.stringify(composedPatch.response.data.applied)}`
      )

      // 组合保存：条目记录 3 个节点、2 条连线与 1 份媒体引用（外部输入始终只有 mediaId）。
      let composed = null
      let lastComposeError = null
      for (let attempt = 0; attempt < 6 && !composed; attempt++) {
        if (attempt > 0) await sleep(1200)
        const attemptResult = await runCli(directory, ['node', 'library', 'compose'], {
          input: {
            projectId: created.A,
            expectedGraphVersion: await stableProjectVersion(directory, created.A),
            name: 'F7 节点库组合验收',
            nodeIds: sourceNodeIds
          },
          idempotencyKey: key()
        })
        if (attemptResult.response.status === 'completed') composed = attemptResult
        else {
          lastComposeError = attemptResult.response.error
          if (lastComposeError?.code !== 'REVISION_CONFLICT')
            throw new Error(`F7_NODE_LIBRARY_COMPOSE_FAILED:${JSON.stringify(lastComposeError)}`)
        }
      }
      check(Boolean(composed), `F7_NODE_LIBRARY_COMPOSE_FAILED:${JSON.stringify(lastComposeError)}`)
      const entry = composed.response.data
      check(
        Boolean(entry.id) && entry.nodeCount === 3,
        `F7_NODE_LIBRARY_ENTRY_INVALID:${JSON.stringify(entry)}`
      )
      const entryRead = await runCli(directory, ['node', 'library', 'get'], {
        input: { entryId: entry.id }
      })
      check(
        entryRead.response.status === 'completed',
        `F7_NODE_LIBRARY_ENTRY_READ_FAILED:${JSON.stringify(entryRead.response.error)}`
      )
      const entryDetail = entryRead.response.data
      check(
        entryDetail.nodeCount === 3 && entryDetail.impact.edgeCount === 2,
        `F7_NODE_LIBRARY_ENTRY_COUNTS:${JSON.stringify(entryDetail.impact)}`
      )
      check(
        entryDetail.nodes.some(
          (entryNode) => entryNode.nodeType === 'image' && entryNode.mediaId === sourceMediaId
        ),
        'F7_NODE_LIBRARY_ENTRY_MEDIA_REF_MISSING'
      )

      // 目标画布 B：实例化要求目标是当前打开的权威画布。
      const graphBeforeInsert = await runCli(directory, ['graph', 'get'], {
        input: { projectId: created.B, limit: 200 }
      })
      const beforeInsertTotal = graphBeforeInsert.response.data.total
      const beforeInsertEdges = graphBeforeInsert.response.data.edges.length
      const mediaBeforeInsert = (
        await runCli(directory, ['media', 'list'], { input: { projectId: created.B, limit: 200 } })
      ).response.data.total
      const openB = await runCli(directory, ['project', 'open'], {
        input: { projectId: created.B },
        idempotencyKey: key()
      })
      check(
        openB.response.status === 'completed',
        `F7_NODE_LIBRARY_OPEN_B_FAILED:${JSON.stringify(openB.response.error)}`
      )
      await page.locator('.node-palette').waitFor({ timeout: 30000 })

      let inserted = null
      let insertInput = null
      let insertKey = null
      let lastInsertError = null
      for (let attempt = 0; attempt < 6 && !inserted; attempt++) {
        if (attempt > 0) await sleep(1200)
        insertInput = {
          projectId: created.B,
          expectedGraphVersion: await stableProjectVersion(directory, created.B),
          entryId: entry.id,
          x: 100,
          y: 100
        }
        insertKey = key()
        const attemptResult = await runCli(directory, ['node', 'library', 'insert'], {
          input: insertInput,
          idempotencyKey: insertKey
        })
        if (attemptResult.response.status === 'completed') inserted = attemptResult
        else {
          lastInsertError = attemptResult.response.error
          if (lastInsertError?.code !== 'REVISION_CONFLICT')
            throw new Error(`F7_NODE_LIBRARY_INSERT_FAILED:${JSON.stringify(lastInsertError)}`)
        }
      }
      check(Boolean(inserted), `F7_NODE_LIBRARY_INSERT_FAILED:${JSON.stringify(lastInsertError)}`)
      const insertData = inserted.response.data
      check(
        insertData.applied.nodeCreated === 3 &&
          insertData.applied.edgeCreated === 2 &&
          insertData.saved === true,
        `F7_NODE_LIBRARY_INSERT_COUNTS:${JSON.stringify(insertData.applied)}`
      )
      check(
        insertData.skippedEdges === 0,
        `F7_NODE_LIBRARY_INSERT_SKIPPED_EDGES:${insertData.skippedEdges}`
      )
      check(
        insertData.media.length === 1 && insertData.media[0].entryMediaId === sourceMediaId,
        `F7_NODE_LIBRARY_INSERT_MEDIA:${JSON.stringify(insertData.media)}`
      )
      const targetMediaId = insertData.media[0].mediaId
      check(targetMediaId !== sourceMediaId, 'F7_NODE_LIBRARY_MEDIA_ID_NOT_REMAPPED')

      const graphAfterInsert = await runCli(directory, ['graph', 'get'], {
        input: { projectId: created.B, limit: 200 }
      })
      check(
        graphAfterInsert.response.data.total === beforeInsertTotal + 3,
        `F7_NODE_LIBRARY_NODE_COUNT:${beforeInsertTotal}->${graphAfterInsert.response.data.total}`
      )
      check(
        graphAfterInsert.response.data.edges.length === beforeInsertEdges + 2,
        `F7_NODE_LIBRARY_EDGE_COUNT:${beforeInsertEdges}->${graphAfterInsert.response.data.edges.length}`
      )
      const insertedByTitle = {}
      for (const title of ['F7 组合图片', 'F7 组合裁剪甲', 'F7 组合裁剪乙']) {
        const found = graphAfterInsert.response.data.nodes.find(
          (entryNode) => entryNode.title === title
        )
        check(Boolean(found), `F7_NODE_LIBRARY_INSERTED_NODE_MISSING:${title}`)
        insertedByTitle[title] = found.nodeId
      }
      const insertedIdSet = new Set(Object.values(insertedByTitle))
      check(insertedIdSet.size === 3, 'F7_NODE_LIBRARY_INSERTED_IDS_NOT_UNIQUE')
      for (const insertedId of insertedIdSet) {
        check(
          !sourceNodeIds.includes(insertedId),
          `F7_NODE_LIBRARY_ID_NOT_REMAPPED:${insertedId}`
        )
      }
      const insertedEdges = graphAfterInsert.response.data.edges.filter(
        (edge) => insertedIdSet.has(edge.from.nodeId) && insertedIdSet.has(edge.to.nodeId)
      )
      check(insertedEdges.length === 2, `F7_NODE_LIBRARY_INSERTED_EDGES:${insertedEdges.length}`)
      const insertedImage = graphAfterInsert.response.data.nodes.find(
        (entryNode) => entryNode.title === 'F7 组合图片'
      )
      check(
        insertedImage.mediaId === targetMediaId,
        `F7_NODE_LIBRARY_IMAGE_MEDIA:${insertedImage.mediaId}!==${targetMediaId}`
      )

      // 媒体在 B 项目下且与 A 不串用：目标节点引用 B 的受控媒体文件，A 的媒体仍在。
      const insertedImageRead = await runCli(directory, ['node', 'get'], {
        input: { projectId: created.B, nodeId: insertedImage.nodeId }
      })
      const insertedMediaPath = String(insertedImageRead.response.data.node.mediaPath ?? '')
      check(
        insertedMediaPath.startsWith(`projects/${created.B}/media/`),
        `F7_NODE_LIBRARY_MEDIA_NOT_IN_B:${insertedMediaPath}`
      )
      const insertedMediaBytes = await readFile(
        join(directory, insertedMediaPath.replace(/\//g, sep))
      ).catch(() => null)
      check(
        Boolean(insertedMediaBytes) && insertedMediaBytes.byteLength > 0,
        'F7_NODE_LIBRARY_MEDIA_FILE_MISSING'
      )
      const mediaA = await runCli(directory, ['media', 'list'], {
        input: { projectId: created.A, limit: 200 }
      })
      const mediaB = await runCli(directory, ['media', 'list'], {
        input: { projectId: created.B, limit: 200 }
      })
      check(
        mediaA.response.data.items.some((item) => item.mediaId === sourceMediaId),
        'F7_NODE_LIBRARY_SOURCE_MEDIA_MOVED'
      )
      check(
        !mediaA.response.data.items.some((item) => item.mediaId === targetMediaId),
        'F7_NODE_LIBRARY_TARGET_MEDIA_LEAKED_TO_A'
      )
      check(
        mediaB.response.data.items.some((item) => item.mediaId === targetMediaId),
        'F7_NODE_LIBRARY_TARGET_MEDIA_NOT_IN_B'
      )
      check(
        mediaB.response.data.total === mediaBeforeInsert + 1,
        `F7_NODE_LIBRARY_MEDIA_COUNT:${mediaBeforeInsert}->${mediaB.response.data.total}`
      )
      const graphA = await runCli(directory, ['graph', 'get'], {
        input: { projectId: created.A, limit: 200 }
      })
      for (const sourceId of sourceNodeIds) {
        check(
          graphA.response.data.nodes.some((entryNode) => entryNode.nodeId === sourceId),
          `F7_NODE_LIBRARY_SOURCE_NODE_LOST:${sourceId}`
        )
      }

      // 幂等重放：同一幂等键返回原回执，不再产生第二份节点/媒体。
      const replay = await runCli(directory, ['node', 'library', 'insert'], {
        input: insertInput,
        idempotencyKey: insertKey
      })
      check(
        replay.response.status === 'completed' &&
          replay.response.data.graphVersion === insertData.graphVersion,
        `F7_NODE_LIBRARY_REPLAY_DIVERGED:${JSON.stringify(replay.response.error)}`
      )
      const graphAfterReplay = await runCli(directory, ['graph', 'get'], {
        input: { projectId: created.B, limit: 200 }
      })
      check(
        graphAfterReplay.response.data.total === beforeInsertTotal + 3,
        `F7_NODE_LIBRARY_REPLAY_DUPLICATED:${graphAfterReplay.response.data.total}`
      )
      const mediaAfterReplay = await runCli(directory, ['media', 'list'], {
        input: { projectId: created.B, limit: 200 }
      })
      check(
        mediaAfterReplay.response.data.total === mediaBeforeInsert + 1,
        `F7_NODE_LIBRARY_REPLAY_MEDIA_DUPLICATED:${mediaAfterReplay.response.data.total}`
      )

      receipt.nodeLibrary = {
        entryId: entry.id,
        entry: { nodeCount: entryDetail.nodeCount, edgeCount: entryDetail.impact.edgeCount },
        source: { projectId: created.A, nodeIds: sourceNodeIds, mediaId: sourceMediaId },
        insert: {
          projectId: created.B,
          graphVersion: insertData.graphVersion,
          applied: insertData.applied,
          media: insertData.media,
          skippedEdges: insertData.skippedEdges,
          before: { total: beforeInsertTotal, edges: beforeInsertEdges, media: mediaBeforeInsert }
        },
        replay: {
          graphVersion: replay.response.data.graphVersion,
          total: graphAfterReplay.response.data.total,
          media: mediaAfterReplay.response.data.total
        }
      }
      receipt.checks.push(
        'F7 node library: node.library.compose saves three selected nodes and their two connecting edges plus the media reference as one reusable entry'
      )
      receipt.checks.push(
        'F7 node library: node.library.insert instantiates the entry on another opened canvas (3 nodes / 2 edges) with every node and edge id remapped'
      )
      receipt.checks.push(
        'F7 node library: the inserted image node references a fresh project-controlled media copy under the target project; the source project media is untouched and never reused across canvases'
      )
      receipt.checks.push(
        'F7 node library: replaying the same idempotency key returns the original receipt without creating a second copy of nodes or media'
      )
    }

    // ── 6.13 F7 历史快照与恢复：快照 → 改图 → 恢复 → 检查点回退 → 打开中拒绝 ──
    // 恢复只能对未在桌面画布打开的项目执行（打开中返回 RESOURCE_BUSY/desktop-ownership，
    // 见 25 号台账）；恢复前会自动落检查点，供回退到修改后的状态。
    {
      const historyProject = await runCli(directory, ['project', 'create'], {
        input: { name: '历史恢复（里程碑）' },
        idempotencyKey: key()
      })
      check(
        historyProject.response.status === 'completed',
        `F7_HISTORY_PROJECT_CREATE_FAILED:${JSON.stringify(historyProject.response.error)}`
      )
      const historyId = historyProject.response.data.meta.id
      const openHistory = await runCli(directory, ['project', 'open'], {
        input: { projectId: historyId },
        idempotencyKey: key()
      })
      check(
        openHistory.response.status === 'completed',
        `F7_HISTORY_PROJECT_OPEN_FAILED:${JSON.stringify(openHistory.response.error)}`
      )
      await page.locator('.node-palette').waitFor({ timeout: 30000 })

      const snapshotPatch = await patchWithFreshVersion(
        directory,
        historyId,
        () => [
          {
            action: 'node.create',
            ref: 'h-script',
            nodeType: 'text',
            x: 60,
            y: 60,
            title: 'H 剧本',
            text: '历史快照正文'
          },
          {
            action: 'node.create',
            ref: 'h-pass',
            nodeType: 'processor',
            x: 480,
            y: 60,
            title: 'H 透传',
            config: { operation: 'pass' }
          },
          {
            action: 'node.create',
            ref: 'h-merge',
            nodeType: 'text',
            x: 900,
            y: 60,
            title: 'H 合并',
            text: '历史合并前缀'
          },
          {
            action: 'edge.create',
            ref: 'h-e1',
            from: { nodeId: 'h-script', portId: 'out-text' },
            to: { nodeId: 'h-pass', portId: 'in-value' }
          },
          {
            action: 'edge.create',
            ref: 'h-e2',
            from: { nodeId: 'h-pass', portId: 'out-value' },
            to: { nodeId: 'h-merge', portId: 'in-text' }
          }
        ],
        'F7_HISTORY_SOURCE_PATCH_FAILED'
      )
      check(
        snapshotPatch.response.data.applied.nodeCreated === 3 &&
          snapshotPatch.response.data.applied.edgeCreated === 2,
        `F7_HISTORY_SOURCE_COUNTS:${JSON.stringify(snapshotPatch.response.data.applied)}`
      )
      // project.open 后显式保存到稳定版本；快照只捕获已持久化画布。
      const saveStable = async (projectId) => {
        for (let attempt = 0; attempt < 6; attempt++) {
          if (attempt > 0) await sleep(1200)
          const saved = await runCli(directory, ['project', 'save'], {
            input: {
              projectId,
              expectedGraphVersion: await stableProjectVersion(directory, projectId)
            },
            idempotencyKey: key()
          })
          if (saved.response.status === 'completed') return saved.response.data.graphVersion
          if (saved.response.error?.code !== 'REVISION_CONFLICT')
            throw new Error(`F7_HISTORY_SAVE_FAILED:${JSON.stringify(saved.response.error)}`)
        }
        throw new Error('F7_HISTORY_SAVE_FAILED:REVISION_CONFLICT')
      }
      const captureGraph = async (projectId, label) => {
        const view = await runCli(directory, ['graph', 'get'], {
          input: { projectId, limit: 200 }
        })
        check(
          view.response.status === 'completed',
          `F7_HISTORY_${label}_GRAPH_READ_FAILED:${JSON.stringify(view.response.error)}`
        )
        const nodes = view.response.data.nodes.map((entryNode) => ({
          nodeId: entryNode.nodeId,
          type: entryNode.type,
          title: entryNode.title
        }))
        const contents = {}
        for (const entryNode of view.response.data.nodes) {
          const read = await runCli(directory, ['node', 'get'], {
            input: { projectId, nodeId: entryNode.nodeId }
          })
          check(
            read.response.status === 'completed',
            `F7_HISTORY_${label}_NODE_READ_FAILED:${entryNode.nodeId}`
          )
          contents[entryNode.nodeId] = {
            text: String(read.response.data.node.text ?? ''),
            config: JSON.stringify(read.response.data.node.config ?? null)
          }
        }
        return {
          nodes,
          contents,
          nodeCount: view.response.data.total,
          edgeCount: view.response.data.edges.length,
          graphVersion: view.response.data.graphVersion
        }
      }
      await saveStable(historyId)
      const snapshotBase = await captureGraph(historyId, 'BASE')

      let createdSnapshot = null
      let lastSnapshotError = null
      for (let attempt = 0; attempt < 6 && !createdSnapshot; attempt++) {
        if (attempt > 0) await sleep(1200)
        const attemptResult = await runCli(directory, ['history', 'snapshot', 'create'], {
          input: {
            projectId: historyId,
            expectedGraphVersion: await stableProjectVersion(directory, historyId),
            label: 'F7 历史快照验收'
          },
          idempotencyKey: key()
        })
        if (attemptResult.response.status === 'completed') createdSnapshot = attemptResult
        else {
          lastSnapshotError = attemptResult.response.error
          if (lastSnapshotError?.code !== 'REVISION_CONFLICT')
            throw new Error(`F7_HISTORY_SNAPSHOT_FAILED:${JSON.stringify(lastSnapshotError)}`)
        }
      }
      check(
        Boolean(createdSnapshot),
        `F7_HISTORY_SNAPSHOT_FAILED:${JSON.stringify(lastSnapshotError)}`
      )
      const snapshotData = createdSnapshot.response.data
      check(
        snapshotData.restorable === true && snapshotData.nodeCount === snapshotBase.nodeCount,
        `F7_HISTORY_SNAPSHOT_INVALID:${JSON.stringify(snapshotData)}`
      )
      const snapshotId = snapshotData.snapshotId

      // 改图（新增节点）并保存：这是恢复应被替换掉的状态。
      const modifiedPatch = await patchWithFreshVersion(
        directory,
        historyId,
        () => [
          {
            action: 'node.create',
            ref: 'h-extra',
            nodeType: 'text',
            x: 60,
            y: 460,
            title: 'H 恢复前新增',
            text: '恢复前的修改'
          }
        ],
        'F7_HISTORY_MODIFY_PATCH_FAILED'
      )
      await saveStable(historyId)
      const modifiedState = await captureGraph(historyId, 'MODIFIED')
      check(
        modifiedState.nodeCount === snapshotBase.nodeCount + 1,
        `F7_HISTORY_MODIFIED_COUNT:${modifiedState.nodeCount}`
      )
      const addedNodeId = modifiedPatch.response.data.created.find(
        (item) => item.ref === 'h-extra'
      ).nodeId

      // 切到另一个项目：打开中的画布才拥有权威内容，外部恢复只对未打开项目执行。
      const openOther = await runCli(directory, ['project', 'open'], {
        input: { projectId: created.B },
        idempotencyKey: key()
      })
      check(
        openOther.response.status === 'completed',
        `F7_HISTORY_OPEN_OTHER_FAILED:${JSON.stringify(openOther.response.error)}`
      )
      await page.locator('.node-palette').waitFor({ timeout: 30000 })

      // 无令牌 → 必须明确要求先预检（令牌绑定实例/项目/版本/影响事实）。
      const noToken = await runCli(directory, ['history', 'restore'], {
        input: {
          projectId: historyId,
          snapshotId
        },
        idempotencyKey: key()
      })
      check(
        noToken.response.status === 'failed' &&
          noToken.response.error?.code === 'IMPACT_CONFIRM_REQUIRED',
        `F7_HISTORY_TOKEN_NOT_REQUIRED:${JSON.stringify(noToken.response.error)}`
      )

      const precheck = await runCli(directory, ['history', 'restore', 'precheck'], {
        input: { projectId: historyId, snapshotId }
      })
      check(
        precheck.response.status === 'completed',
        `F7_HISTORY_PRECHECK_FAILED:${JSON.stringify(precheck.response.error)}`
      )
      const precheckData = precheck.response.data
      check(
        !precheckData.blockers.includes('ACTIVE_PROJECT'),
        `F7_HISTORY_PRECHECK_BLOCKED:${JSON.stringify(precheckData.blockers)}`
      )
      check(
        typeof precheckData.impactToken === 'string' && precheckData.impactToken.length > 0,
        'F7_HISTORY_PRECHECK_NO_TOKEN'
      )
      check(
        precheckData.target.nodeCount === snapshotBase.nodeCount &&
          precheckData.current.nodeCount === modifiedState.nodeCount,
        `F7_HISTORY_PRECHECK_IMPACT:${JSON.stringify({
          current: precheckData.current,
          target: precheckData.target
        })}`
      )

      const restored = await runCli(directory, ['history', 'restore'], {
        input: {
          projectId: historyId,
          snapshotId,
          impactToken: precheckData.impactToken
        },
        idempotencyKey: key()
      })
      check(
        restored.response.status === 'completed',
        `F7_HISTORY_RESTORE_FAILED:${JSON.stringify(restored.response.error)}`
      )
      const restoreData = restored.response.data
      check(
        restoreData.restored === true &&
          restoreData.nodeCount === snapshotBase.nodeCount &&
          restoreData.edgeCount === snapshotBase.edgeCount,
        `F7_HISTORY_RESTORE_RECEIPT:${JSON.stringify(restoreData)}`
      )
      const restoredState = await captureGraph(historyId, 'RESTORED')
      check(
        JSON.stringify(restoredState.nodes) === JSON.stringify(snapshotBase.nodes),
        'F7_HISTORY_RESTORE_NODES_MISMATCH'
      )
      check(
        JSON.stringify(restoredState.contents) === JSON.stringify(snapshotBase.contents),
        'F7_HISTORY_RESTORE_CONTENT_MISMATCH'
      )
      check(
        restoredState.edgeCount === snapshotBase.edgeCount,
        `F7_HISTORY_RESTORE_EDGES:${restoredState.edgeCount}`
      )

      // 恢复前自动检查点：存在、可恢复；再恢复它可回到“修改后的状态”。
      const checkpointId = restoreData.checkpointSnapshotId
      check(typeof checkpointId === 'string' && checkpointId.length > 0, 'F7_HISTORY_CHECKPOINT_MISSING')
      const historyList = await runCli(directory, ['history', 'list'], {
        input: { projectId: historyId, limit: 100 }
      })
      const checkpointEntry = historyList.response.data.items.find(
        (item) => item.snapshotId === checkpointId
      )
      check(
        Boolean(checkpointEntry) && checkpointEntry.restorable === true,
        `F7_HISTORY_CHECKPOINT_NOT_LISTED:${JSON.stringify(historyList.response.data.items)}`
      )
      const checkpointPrecheck = await runCli(directory, ['history', 'restore', 'precheck'], {
        input: { projectId: historyId, snapshotId: checkpointId }
      })
      check(
        checkpointPrecheck.response.status === 'completed' &&
          checkpointPrecheck.response.data.target.nodeCount === modifiedState.nodeCount,
        `F7_HISTORY_CHECKPOINT_PRECHECK:${JSON.stringify(
          checkpointPrecheck.response.error ?? checkpointPrecheck.response.data
        )}`
      )
      const checkpointRestore = await runCli(directory, ['history', 'restore'], {
        input: {
          projectId: historyId,
          snapshotId: checkpointId,
          impactToken: checkpointPrecheck.response.data.impactToken
        },
        idempotencyKey: key()
      })
      check(
        checkpointRestore.response.status === 'completed',
        `F7_HISTORY_CHECKPOINT_RESTORE_FAILED:${JSON.stringify(checkpointRestore.response.error)}`
      )
      const checkpointState = await captureGraph(historyId, 'CHECKPOINT')
      check(
        JSON.stringify(checkpointState.nodes) === JSON.stringify(modifiedState.nodes),
        'F7_HISTORY_CHECKPOINT_NODES_MISMATCH'
      )
      check(
        checkpointState.nodes.some((entryNode) => entryNode.nodeId === addedNodeId),
        'F7_HISTORY_CHECKPOINT_LOST_ADDED_NODE'
      )
      check(
        JSON.stringify(checkpointState.contents) === JSON.stringify(modifiedState.contents),
        'F7_HISTORY_CHECKPOINT_CONTENT_MISMATCH'
      )

      // 打开中的项目：precheck 报 ACTIVE_PROJECT 且不签发令牌；执行明确 RESOURCE_BUSY，版本不变。
      const openHistoryAgain = await runCli(directory, ['project', 'open'], {
        input: { projectId: historyId },
        idempotencyKey: key()
      })
      check(
        openHistoryAgain.response.status === 'completed',
        `F7_HISTORY_REOPEN_FAILED:${JSON.stringify(openHistoryAgain.response.error)}`
      )
      await page.locator('.node-palette').waitFor({ timeout: 30000 })
      const activePrecheck = await runCli(directory, ['history', 'restore', 'precheck'], {
        input: { projectId: historyId, snapshotId }
      })
      check(
        activePrecheck.response.status === 'completed' &&
          activePrecheck.response.data.blockers.includes('ACTIVE_PROJECT') &&
          activePrecheck.response.data.impactToken === undefined,
        `F7_HISTORY_ACTIVE_PRECHECK:${JSON.stringify(
          activePrecheck.response.data?.blockers
        )}`
      )
      const activeRestore = await runCli(directory, ['history', 'restore'], {
        input: {
          projectId: historyId,
          snapshotId
        },
        idempotencyKey: key()
      })
      check(
        activeRestore.response.status === 'failed' &&
          activeRestore.response.error?.code === 'RESOURCE_BUSY',
        `F7_HISTORY_ACTIVE_RESTORE_NOT_BUSY:${JSON.stringify(activeRestore.response.error)}`
      )
      const afterBusy = await runCli(directory, ['project', 'get'], {
        input: { projectId: historyId }
      })
      check(
        afterBusy.response.data.meta.graphVersion === activePrecheck.response.data.graphVersion,
        'F7_HISTORY_ACTIVE_RESTORE_CHANGED_VERSION'
      )

      receipt.history = {
        projectId: historyId,
        snapshotId,
        checkpointSnapshotId: checkpointId,
        base: {
          nodeCount: snapshotBase.nodeCount,
          edgeCount: snapshotBase.edgeCount,
          graphVersion: snapshotBase.graphVersion
        },
        modified: {
          nodeCount: modifiedState.nodeCount,
          edgeCount: modifiedState.edgeCount,
          graphVersion: modifiedState.graphVersion,
          addedNodeId
        },
        restore: {
          graphVersion: restoreData.graphVersion,
          previousGraphVersion: restoreData.previousGraphVersion,
          nodeCount: restoreData.nodeCount,
          edgeCount: restoreData.edgeCount
        },
        checkpointRestore: {
          nodeCount: checkpointState.nodeCount,
          edgeCount: checkpointState.edgeCount
        },
        tokenRequired: noToken.response.error?.code,
        activeRestore: {
          code: activeRestore.response.error?.code,
          detail: activeRestore.response.error?.detail,
          blockers: activePrecheck.response.data?.blockers
        }
      }
      receipt.checks.push(
        'F7 history: after project.open and an explicit stable save, history.snapshot.create captures the persisted graph as a restorable snapshot with the expected node count'
      )
      receipt.checks.push(
        'F7 history: history.restore.precheck issues a bound token and history.restore returns the persisted graph to the snapshot state — node ids/types/titles, node text/config and edge count all match, not just the version'
      )
      receipt.checks.push(
        'F7 history: the pre-restore checkpoint is listed as restorable and restoring it returns the canvas to the modified state including the newly added node'
      )
      receipt.checks.push(
        'F7 history: history.restore without the precheck token is rejected with IMPACT_CONFIRM_REQUIRED before touching the project'
      )
      receipt.checks.push(
        'F7 history: restoring a project that is open in the desktop is refused with RESOURCE_BUSY (desktop-ownership) and does not change its graph version'
      )
    }

    // ── 6.14 F8 收官：Flow 建图/审核外部接入（真实画布 + 隔离数据目录无模型）──
    // 没有已验证模型连接时，propose/review 必须在任何模型请求之前如实失败；
    // commit 只按 buildId 提交且缺预览时不得触发桌面写入；未开放的 cooperate/publication
    // 必须明确 UNSUPPORTED_OPERATION，而不是悄悄出现一个外部替身。
    {
      const opened = await runCli(directory, ['project', 'open'], {
        input: { projectId: created.A },
        idempotencyKey: key()
      })
      check(
        opened.response.status === 'completed',
        `F8_FLOW_OPEN_A_FAILED:${JSON.stringify(opened.response.error)}`
      )
      await page.locator('.node-palette').waitFor({ timeout: 30000 })
      const flowCall = async (command, input) =>
        await runCli(directory, command, { input, idempotencyKey: key() })
      const sourcePatch = await patchWithFreshVersion(directory, created.A, () => [
        {
          action: 'node.create',
          ref: 'f8-source',
          nodeType: 'text',
          x: 60,
          y: 6000,
          title: 'F8 建图源文本',
          text: 'F8 建图目标：把这句话模板化。'
        }
      ], 'F8_FLOW_SOURCE_PATCH_FAILED')
      const sourceId = sourcePatch.response.data.created.find((item) => item.ref === 'f8-source').nodeId
      const builderConfig = {
        schemaVersion: 1,
        role: 'builder',
        interactionMode: 'autonomous',
        modelDefinitionId: 'missing-model-f8',
        skills: [],
        tools: [{ id: 'graph.preview', version: '1' }],
        allowedNodeIds: [sourceId],
        maxSteps: 4,
        relations: []
      }
      const reviewConfig = {
        schemaVersion: 1,
        rulesVersion: 'builder-review-v1',
        reviewMode: 'text-json',
        modelDefinitionId: 'missing-model-f8',
        rejectPolicy: 'rework',
        maxReworks: 1,
        subjectSources: [{ nodeId: sourceId, portId: 'out-text' }],
        gatedNodeIds: [],
        relations: []
      }
      const nodesPatch = await patchWithFreshVersion(directory, created.A, () => [
        {
          action: 'node.create',
          ref: 'f8-builder',
          nodeType: 'agent',
          x: 60,
          y: 6400,
          title: 'F8 建图 Agent',
          text: 'F8 建图目标：把这句话模板化。',
          config: builderConfig
        },
        {
          action: 'node.create',
          ref: 'f8-review',
          nodeType: 'ai-review',
          x: 480,
          y: 6400,
          title: 'F8 审核节点',
          text: '审核标准：输出必须完整。',
          config: reviewConfig
        }
      ], 'F8_FLOW_NODES_PATCH_FAILED')
      const builderId = nodesPatch.response.data.created.find((item) => item.ref === 'f8-builder').nodeId
      const reviewId = nodesPatch.response.data.created.find((item) => item.ref === 'f8-review').nodeId

      // (a) build.inspect 真实画布只读：propose 前没有预览
      const inspectEmpty = await flowCall(
        ['flowAgent', 'build', 'inspect'],
        { projectId: created.A, nodeId: builderId }
      )
      check(
        inspectEmpty.response.status === 'completed' && inspectEmpty.response.data.build === null,
        `F8_BUILD_INSPECT_EMPTY_INVALID:${JSON.stringify(inspectEmpty.response)}`
      )
      // (b) 无已验证模型：propose 在模型预检处失败，不产生预览、不落画布
      const propose = await flowCall(
        ['flowAgent', 'build', 'propose'],
        { projectId: created.A, nodeId: builderId }
      )
      check(
        propose.response.status === 'failed' && propose.response.error?.code === 'AGENT_MODEL_UNAVAILABLE',
        `F8_BUILD_PROPOSE_NOT_REFUSED:${JSON.stringify(propose.response)}`
      )
      const inspectAfterPropose = await flowCall(
        ['flowAgent', 'build', 'inspect'],
        { projectId: created.A, nodeId: builderId }
      )
      check(
        inspectAfterPropose.response.status === 'completed' &&
          inspectAfterPropose.response.data.build === null,
        `F8_BUILD_PROPOSE_PERSISTED_PREVIEW:${JSON.stringify(inspectAfterPropose.response.data)}`
      )
      // 外部不能自造运行身份：requestId 由 main 生成，输入里带它会被 strict Schema 拒绝
      // （CLI 在本地就拒绝，不会到达业务层）。
      let forgedIdentityRejected = false
      try {
        await flowCall(['flowAgent', 'build', 'propose'], {
          projectId: created.A,
          nodeId: builderId,
          requestId: 'evil-request-1'
        })
      } catch (error) {
        forgedIdentityRejected = /CLI_INVALID_RESULT:2/.test(String(error && error.message))
      }
      check(forgedIdentityRejected, 'F8_BUILD_FORGED_IDENTITY_ACCEPTED')
      // (c) commit：没有持久化预览 → 明确 FLOW_BUILD_MISSING（不触发桌面写入）
      const commitMissing = await flowCall(
        ['flowAgent', 'build', 'commit'],
        { projectId: created.A, nodeId: builderId, buildId: 'build-000000000000000000000000' }
      )
      check(
        commitMissing.response.status === 'failed' &&
          commitMissing.response.error?.code === 'FLOW_BUILD_MISSING',
        `F8_BUILD_COMMIT_MISSING_NOT_REFUSED:${JSON.stringify(commitMissing.response)}`
      )
      // 非活动画布上的 build 也必须在宿主调用前拒绝
      const inactiveInspect = await flowCall(
        ['flowAgent', 'build', 'inspect'],
        { projectId: created.B, nodeId: builderId }
      )
      check(
        inactiveInspect.response.status === 'failed' &&
          inactiveInspect.response.error?.code === 'ACTIVE_PROJECT_REQUIRED',
        `F8_BUILD_INACTIVE_NOT_REFUSED:${JSON.stringify(inactiveInspect.response)}`
      )
      receipt.checks.push(
        'F8 flowAgent.build: inspect reads a real canvas builder node preview (null before propose); propose without a verified tool-calling model is refused at the model gate with AGENT_MODEL_UNAVAILABLE and persists no preview; external-sent request identity is rejected by the strict input schema'
      )
      receipt.checks.push(
        'F8 flowAgent.build.commit: without a persisted preview it is refused with FLOW_BUILD_MISSING before any desktop write; build operations on a non-active canvas are refused with ACTIVE_PROJECT_REQUIRED'
      )

      // (d) review：真实 ai-review 节点在模型预检处如实失败；非审核节点明确配置错误
      const reviewCall = await flowCall(
        ['flowAgent', 'review'],
        { projectId: created.A, nodeId: reviewId }
      )
      check(
        reviewCall.response.status === 'failed' &&
          reviewCall.response.error?.code === 'AGENT_MODEL_UNAVAILABLE',
        `F8_REVIEW_NOT_REFUSED:${JSON.stringify(reviewCall.response)}`
      )
      const reviewWrongNode = await flowCall(
        ['flowAgent', 'review'],
        { projectId: created.A, nodeId: builderId }
      )
      check(
        reviewWrongNode.response.status === 'failed' &&
          reviewWrongNode.response.error?.code === 'FLOW_REVIEW_CONFIG_INVALID',
        `F8_REVIEW_WRONG_NODE:${JSON.stringify(reviewWrongNode.response)}`
      )
      // 外部不能把审核结论改成通过：输入 schema 没有 passed/decision 字段（strict 拒绝，
      // CLI 在本地就拒绝）。
      let forgedVerdictRejected = false
      try {
        await flowCall(['flowAgent', 'review'], {
          projectId: created.A,
          nodeId: reviewId,
          passed: true
        })
      } catch (error) {
        forgedVerdictRejected = /CLI_INVALID_RESULT:2/.test(String(error && error.message))
      }
      check(forgedVerdictRejected, 'F8_REVIEW_FORGED_VERDICT_ACCEPTED')
      receipt.checks.push(
        'F8 flowAgent.review: a real ai-review node is refused at the model gate with AGENT_MODEL_UNAVAILABLE before any model request; a non-review node is refused with FLOW_REVIEW_CONFIG_INVALID; external input cannot carry a verdict (strict schema rejects the extra field)'
      )

      // (e) 未开放项必须诚实不可用：CLI 在本地就不接受未登记操作（不会出现外部替身）。
      for (const command of [['flowAgent', 'cooperate'], ['flowAgent', 'publication']]) {
        let rejected = false
        try {
          await flowCall(command, { projectId: created.A, nodeId: builderId })
        } catch (error) {
          rejected = /CLI_INVALID_RESULT:2/.test(String(error && error.message))
        }
        check(rejected, `F8_UNREGISTERED_NOT_REFUSED:${command.join('.')}`)
      }
      receipt.checks.push(
        'F8 honest boundary: flowAgent.cooperate / flowAgent.publication are not registered and the CLI refuses them locally (CLI_INVALID_RESULT:2; no external substitute for human decisions or internal publication)'
      )
      receipt.flowAgent = {
        builderNodeId: builderId,
        reviewNodeId: reviewId,
        buildInspect: 'null-preview',
        buildPropose: propose.response.error?.code,
        buildCommitMissing: commitMissing.response.error?.code,
        buildInactive: inactiveInspect.response.error?.code,
        forgedIdentity: forgedIdentityRejected ? 'CLI_LOCAL_REJECTED' : 'ACCEPTED',
        review: reviewCall.response.error?.code,
        reviewWrongNode: reviewWrongNode.response.error?.code,
        forgedVerdict: forgedVerdictRejected ? 'CLI_LOCAL_REJECTED' : 'ACCEPTED'
      }
    }

    // ── 7. 保存、关闭并重启；重启后图与任务账本一致 ──
    // 运行后的节点状态写入有 800ms 防抖：等版本连续两次读数稳定后再保存。
    const stableVersion = (projectId) => stableProjectVersion(directory, projectId)
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
      // F8 段新建的 Agent 节点也会渲染 textarea.node-textarea（任务目标），
      // 不能再取全局第一个 textarea；双击后只填当前可见的正文编辑框。
      await page.locator('textarea.node-textarea:visible').first().fill('人在GUI继续编辑的新正文')
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
      // F6 对话正文/会话标题/附件名同样不得进入诊断（复用 agent.access 生命周期，无新增正文事件）。
      check(!JSON.stringify(events).includes('F6 外部追加'), 'LOG_CONTENT_LEAK_F6_CHAT_BODY')
      check(!JSON.stringify(events).includes('外部会话 F6'), 'LOG_CONTENT_LEAK_F6_SESSION_TITLE')
      check(!JSON.stringify(events).includes('不应写入的跨项目附件消息'), 'LOG_CONTENT_LEAK_F6_REJECTED_CHAT')
      check(!JSON.stringify(events).includes('不应写入的混批消息'), 'LOG_CONTENT_LEAK_F6_MIXED_CHAT')
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
      await cp(join(directory, 'lifecycle.log'), join(evidence, 'failed-lifecycle.log'), { force: true }).catch(() => {})
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
