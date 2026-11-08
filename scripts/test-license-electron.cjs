/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars */
/**
 * 授权门禁 electron 端到端验收（方案 §6.1 对应场景）。
 *
 * 场景：
 *  A. 未授权启动 → 只有授权窗可用，不打开项目数据库，无业务窗口；
 *  B. 授权窗 UI 全流程激活（导出申请 → CLI 挑战 → 导入挑战/导出证明 →
 *     CLI 发证 → 导入授权）→ 进入业务主窗，app.db 建立；
 *  C. 重启免输入：同一数据目录直接进入业务；
 *  D. 无授权的 --model-smoke-test 被门禁封闭（LICENSE_REQUIRED，exit 1）。
 *
 * 真机路径：本机 TPM/PCP 可用时全程使用硬件设备密钥；否则以
 * CANVAS_LICENSE_ALLOW_SOFTWARE_DEVICE=1 走软件适配器（仅开发构建）。
 * 原生文件对话框由 bootstrap 注入桩替换（沿用 test-diagnostics-window-close 模式）。
 *
 * 运行：先 npm run build，再 node scripts/test-license-electron.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { _electron: electron } = require('playwright')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const outRendererLicense = path.join(repoRoot, 'out', 'renderer', 'license.html')

function fail(message) {
  console.error(`[test-license-electron] ${message}`)
  process.exit(1)
}

if (!fs.existsSync(outMain)) fail('缺少 out/main/index.js，请先执行 npm run build')
if (!fs.existsSync(outRendererLicense)) fail('缺少 out/renderer/license.html（renderer 第二入口未构建）')

async function probePcpAvailable() {
  // 直接复用构建产物：临时脚本输出 JSON {available:boolean}
  const probeScript = path.join(os.tmpdir(), `cs-pcp-probe-${process.pid}.cjs`)
  await fsp.writeFile(
    probeScript,
    `
try {
  const { execFileSync } = require('node:child_process');
  const script = \`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $provider = New-Object System.Security.Cryptography.CngProvider('Microsoft Platform Crypto Provider')
    $e = [System.Security.Cryptography.CngKey]::Exists('CS-STUDIO-SIGN-K1', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
    Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; exists = $e })
  \`
  const out = execFileSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', script], { encoding: 'utf8', timeout: 30000 });
  const line = out.split(/\\r?\\n/).reverse().find(l => l.trim().startsWith('{'));
  const parsed = JSON.parse(line);
  console.log(JSON.stringify({ available: parsed.ok === true }));
} catch (error) {
  console.log(JSON.stringify({ available: false, detail: String(error.message).slice(0, 120) }));
}
`
  )
  const out = execFileSync(process.execPath, [probeScript], { encoding: 'utf8', timeout: 60000 })
  const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'))
  return JSON.parse(line)
}

function runIssuer(args) {
  return execFileSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', path.join(repoRoot, 'tools', 'cs-issuer', 'cli.ts'), ...args, '--store', path.join(repoRoot, 'qa', 'security-dev-root')],
    { encoding: 'utf8', timeout: 120_000, cwd: repoRoot }
  )
}

/** 写入对话框桩配置（bootstrap 每次弹窗时读取）。 */
async function writeDialogConfig(configPath, savePaths, openPaths) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, JSON.stringify({ savePaths, openPaths }), 'utf8')
}

function makeBootstrap(directory) {
  const bootstrap = path.join(directory, 'bootstrap.cjs')
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
require(${JSON.stringify(outMain)});
`
  return { bootstrap, contents }
}

async function launchApp(dataDir, extraEnv) {
  const { bootstrap, contents } = makeBootstrap(dataDir)
  await fsp.writeFile(bootstrap, contents, 'utf8')
  const env = { ...process.env, CANVAS_DATA_DIR: path.join(dataDir, 'data'), CS_LICENSE_QA_CFG: path.join(dataDir, 'dialog-config.json') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const [key, value] of Object.entries(extraEnv ?? {})) env[key] = value
  return electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 45000 })
}

;(async () => {
  const startedAt = Date.now()
  const parent = path.join(repoRoot, 'qa', 'license-electron')
  await fsp.mkdir(parent, { recursive: true })
  const evidence = await fsp.mkdtemp(path.join(parent, 'run-'))
  const results = []
  const record = (scenario, ok, detail) => {
    results.push({ scenario, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${scenario} — ${detail}`)
    if (!ok) process.exitCode = 1
  }

  const pcp = await probePcpAvailable()
  const useSoftware = !pcp.available
  const extraEnv = useSoftware ? { CANVAS_LICENSE_ALLOW_SOFTWARE_DEVICE: '1' } : {}
  console.log(`设备适配器：${useSoftware ? 'software-dev（本机无 PCP）' : 'tpm-pcp（真实硬件）'}`)

  // ── 场景 A：未授权启动 ────────────────────────────────────────────────
  {
    const directory = path.join(evidence, 'A-unlicensed')
    const dataDir = path.join(directory, 'data')
    await writeDialogConfig(path.join(directory, 'dialog-config.json'), {}, {})
    const app = await launchApp(directory, extraEnv)
    try {
      const window = await app.firstWindow()
      await window.waitForLoadState('load', { timeout: 30000 })
      const content = await window.textContent('body')
      assert.ok(content.includes('导出设备申请'), '授权窗应包含导出申请入口')
      // 数据库未建立、无业务 IPC（window.api 不存在）。
      await window.waitForFunction(() => typeof window.api === 'undefined', null, { timeout: 5000 }).catch(() => {
        throw new Error('未授权状态下不应暴露业务 api')
      })
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const dbExists = fs.existsSync(path.join(dataDir, 'app.db'))
      assert.ok(!dbExists, '未授权状态下不应打开项目数据库')
      record('A-未授权启动仅授权窗', true, '授权窗展示，无 app.db，无业务 api')
      await app.close()
    } catch (error) {
      record('A-未授权启动仅授权窗', false, String(error.message || error))
      await app.close().catch(() => {})
    }
  }

  // ── 场景 B：授权窗 UI 全流程激活（真机设备密钥）─────────────────────────
  let activatedDataRoot = null
  {
    const directory = path.join(evidence, 'B-activation')
    const dataDir = path.join(directory, 'data')
    activatedDataRoot = dataDir
    const cfgPath = path.join(directory, 'dialog-config.json')
    await writeDialogConfig(cfgPath, {}, {})
    const app = await launchApp(directory, extraEnv)
    try {
      const licenseWindow = await app.firstWindow()
      const pageErrors = []
      licenseWindow.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
      licenseWindow.on('console', (message) => {
        if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`)
      })
      await licenseWindow.waitForLoadState('load', { timeout: 30000 })
      const probe = await licenseWindow
        .evaluate(() => ({ hasLicenseApi: typeof window.licenseApi, readyState: document.readyState }))
        .catch((error) => ({ evaluateFailed: error.message }))
      console.log(`[debug] license window 状态: ${JSON.stringify(probe)}`)
      assert.ok(
        (await licenseWindow.textContent('body')).includes('导出设备申请'),
        '第一窗口应为授权窗'
      )

      // ① 导出设备申请。
      await writeDialogConfig(cfgPath, { 'device.csreq': path.join(directory, 'device.csreq') }, {})
      await licenseWindow.click('#btn-export-request')
      try {
        await licenseWindow.waitForFunction(
          () => document.getElementById('diagnostic') && !document.getElementById('diagnostic').hidden &&
                document.getElementById('diagnostic').textContent.includes('导出申请完成'),
          null, { timeout: 90000 }
        )
      } catch (error) {
        const diag = await licenseWindow
          .evaluate(() => document.getElementById('diagnostic')?.textContent ?? '(无诊断输出)')
          .catch((e) => `(evaluate 失败: ${e.message})`)
        throw new Error(`导出申请未完成。授权窗诊断: ${diag} 页面错误: ${pageErrors.slice(0, 5).join(' | ') || '无'}`)
      }
      assert.ok(fs.existsSync(path.join(directory, 'device.csreq')), '.csreq 应已导出')

      // ② CLI：登记 + 挑战。
      runIssuer(['enroll-ek', '--request', path.join(directory, 'device.csreq'), '--note', 'electron-e2e'])
      runIssuer(['challenge', '--request', path.join(directory, 'device.csreq'), '--out', path.join(directory, 'device.cschallenge')])

      // ③ 导入挑战 → 导出证明。
      await writeDialogConfig(cfgPath, {}, { challenge: path.join(directory, 'device.cschallenge') })
      await licenseWindow.click('#btn-import-challenge')
      await licenseWindow.waitForFunction(
        () => document.getElementById('diagnostic').textContent.includes('导入挑战完成'),
        null, { timeout: 60000 }
      )
      await writeDialogConfig(cfgPath, { 'device.csproof': path.join(directory, 'device.csproof') }, {})
      await licenseWindow.click('#btn-export-proof')
      await licenseWindow.waitForFunction(
        () => document.getElementById('diagnostic').textContent.includes('导出证明完成'),
        null, { timeout: 60000 }
      )
      assert.ok(fs.existsSync(path.join(directory, 'device.csproof')), '.csproof 应已导出')

      // ④ CLI：发证（永久；角色可由 CS_LICENSE_ISSUE_ROLE 参数化，默认使用者）。
      const issueRole = process.env.CS_LICENSE_ISSUE_ROLE === 'key-issuer' ? 'key-issuer' : 'recipient'
      runIssuer(['issue', '--proof', path.join(directory, 'device.csproof'), '--permanent', '--role', issueRole, '--operator', 'electron-e2e', '--out', path.join(directory, 'device.cslicense')])

      // ⑤ 导入授权 → 门禁放行 → 业务主窗。
      await writeDialogConfig(cfgPath, {}, { license: path.join(directory, 'device.cslicense') })
      await licenseWindow.click('#btn-import-license')
      // 轮询窗口列表（事件时序在 IPC 返回前后皆有可能）。
      let businessWindow = null
      const deadline = Date.now() + 45000
      while (Date.now() < deadline && !businessWindow) {
        businessWindow = app.windows().find((w) => w !== licenseWindow) ?? null
        if (!businessWindow) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      assert.ok(businessWindow, '激活后应创建业务主窗')
      if (businessWindow) {
        await businessWindow.waitForLoadState('load', { timeout: 60000 })
        await businessWindow.waitForFunction(() => typeof window.api?.createProject === 'function', null, { timeout: 30000 })
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.ok(fs.existsSync(path.join(dataDir, 'app.db')), '激活后应建立项目数据库')
      // 激活产物固化：license 文件与安全目录供密钥包 e2e 复用（同机设备密钥有效）。
      const latest = path.join(repoRoot, 'qa', 'license-electron', 'latest-activation')
      fs.mkdirSync(path.join(latest, 'security'), { recursive: true })
      fs.copyFileSync(path.join(directory, 'device.cslicense'), path.join(latest, 'device.cslicense'))
      fs.copyFileSync(path.join(dataDir, 'security', 'license-current.json'), path.join(latest, 'security', 'license-current.json'))
      fs.copyFileSync(path.join(dataDir, 'security', 'license-state.json'), path.join(latest, 'security', 'license-state.json'))
      record('B-授权窗全流程激活', true, `激活进入业务主窗（${useSoftware ? '软件设备' : 'TPM 设备'}，角色=${issueRole}）`)
      await app.close()
    } catch (error) {
      record('B-授权窗全流程激活', false, String(error.message || error))
      await app.close().catch(() => {})
    }
  }

  // ── 场景 C：重启免输入 ────────────────────────────────────────────────
  if (activatedDataRoot) {
    const directory = path.join(evidence, 'C-restart')
    await fsp.mkdir(directory, { recursive: true })
    // 复用场景 B 的数据目录（复制或直接指向）。
    const symlinkOk = await fsp
      .symlink(activatedDataRoot, path.join(directory, 'data'), 'junction')
      .then(() => true)
      .catch(() => false)
    if (!symlinkOk) {
      await fsp.cp(activatedDataRoot, path.join(directory, 'data'), { recursive: true })
    }
    await writeDialogConfig(path.join(directory, 'dialog-config.json'), {}, {})
    const app = await launchApp(directory, extraEnv)
    try {
      const window = await app.firstWindow()
      await window.waitForLoadState('load', { timeout: 30000 })
      await window.waitForFunction(() => typeof window.api?.createProject === 'function', null, { timeout: 30000 })
      const windowCount = app.windows().length
      assert.equal(windowCount, 1, '重启应直接进入业务窗（无授权窗）')
      record('C-重启免输入', true, '授权持久化生效，直接进入业务')
      await app.close()
    } catch (error) {
      record('C-重启免输入', false, String(error.message || error))
      await app.close().catch(() => {})
    }
  }

  // ── 场景 D：无授权冒烟被门禁封闭 ──────────────────────────────────────
  {
    const directory = path.join(evidence, 'D-smoke-gate')
    const dataDir = path.join(directory, 'data')
    await fsp.mkdir(dataDir, { recursive: true })
    const env = { ...process.env, CANVAS_DATA_DIR: dataDir }
    delete env.ELECTRON_RUN_AS_NODE
    for (const [key, value] of Object.entries(extraEnv)) env[key] = value
    const child = spawn(require('electron'), [outMain, '--model-smoke-test'], { env, windowsHide: true })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    const code = await new Promise((resolve) => child.on('close', resolve))
    const dbExists = fs.existsSync(path.join(dataDir, 'app.db'))
    const gateBlocked = stdout.includes('LICENSE_REQUIRED') && code === 1 && !dbExists
    record('D-冒烟被门禁封闭', gateBlocked, `exit=${code} stdout=${stdout.trim().slice(0, 120)} dbExists=${dbExists}`)
  }

  await fsp.writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify({ finishedAt: new Date().toISOString(), adapter: useSoftware ? 'software-dev' : 'tpm-pcp', results }, null, 2),
    'utf8'
  )
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n完成：${results.length - failed}/${results.length} 通过（证据目录 ${evidence}，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`)
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  fail(String(error && error.stack ? error.stack : error))
})
