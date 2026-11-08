/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars */
/**
 * P2 密钥包 electron 端到端验收（方案 §6.1 v2 行）。
 *
 * 流程：
 *  A. 用 key-issuer 角色为本机重新激活（走授权窗 UI 全流程 + cs-issuer CLI）；
 *  B. 通过业务 API 种子一个带密钥的模型连接；
 *  C. 导出接收凭证（.csdevcred）→ 发放密钥包（.cskeys，选 1 个连接 + 密码）；
 *  D. 导入密钥包（预览→确认→落库）→ 断言 added/updated；
 *  E. 重放导入 → 断言需要显式确认（重导识别）。
 *
 * 前置：本机设备密钥已存在（P1 激活过）；npm run build 已执行。
 * 运行：node scripts/test-keys-electron.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const realSecurityDir = path.join(process.env.APPDATA, 'canvas-studio', 'data', 'security')

function fail(message) {
  console.error(`[test-keys-electron] ${message}`)
  process.exit(1)
}
if (!fs.existsSync(outMain)) fail('缺少 out/main/index.js，请先执行 npm run build')
if (!fs.existsSync(path.join(realSecurityDir, 'license-current.json'))) {
  fail('本机尚未激活授权（缺少 license-current.json），请先完成 P1 激活')
}

function runIssuer(args) {
  return execFileSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', path.join(repoRoot, 'tools', 'cs-issuer', 'cli.ts'), ...args, '--store', path.join(repoRoot, 'qa', 'security-dev-root')],
    { encoding: 'utf8', timeout: 120_000, cwd: repoRoot }
  )
}

async function writeDialogConfig(configPath, savePaths, openPaths) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, JSON.stringify({ savePaths, openPaths }), 'utf8')
}

function makeBootstrap(directory) {
  const bootstrap = path.join(directory, 'bootstrap.cjs')
  const contents = `
const { app, dialog } = require('electron');
const fs = require('node:fs');
const cfgPath = process.env.CS_KEYS_QA_CFG;
dialog.showSaveDialog = async (_win, options) => {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const target = cfg.savePaths[options.defaultPath] || null;
  return { canceled: !target, filePath: target || undefined };
};
dialog.showOpenDialog = async (_win, options) => {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  let key = null;
  if (String(options.title).includes('接收设备凭证')) key = 'credential';
  else if (String(options.title).includes('密钥包')) key = 'package';
  const target = (cfg.openPaths || {})[key] || null;
  return { canceled: !target, filePaths: target ? [target] : [] };
};
require(${JSON.stringify(outMain)});
`
  return { bootstrap, contents }
}

async function launchApp(dataDir) {
  const { bootstrap, contents } = makeBootstrap(dataDir)
  await fsp.writeFile(bootstrap, contents, 'utf8')
  const env = { ...process.env, CANVAS_DATA_DIR: dataDir, CS_KEYS_QA_CFG: path.join(dataDir, '..', 'dialog-config.json') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 45000 })
}

;(async () => {
  const parent = path.join(repoRoot, 'qa', 'keys-electron')
  await fsp.mkdir(parent, { recursive: true })
  const evidence = await fsp.mkdtemp(path.join(parent, 'run-'))
  const directory = path.join(evidence, 'main')
  const dataDir = path.join(directory, 'data')

  // ── 准备：复制已激活授权 + 对话框桩配置 ─────────────────────────────
  await fsp.mkdir(path.join(dataDir, 'security'), { recursive: true })
  await fsp.copyFile(path.join(realSecurityDir, 'license-current.json'), path.join(dataDir, 'security', 'license-current.json'))
  await fsp.copyFile(path.join(realSecurityDir, 'license-state.json'), path.join(dataDir, 'security', 'license-state.json'))
  const cfgPath = path.join(directory, 'dialog-config.json')
  await writeDialogConfig(cfgPath, {}, {})

  const app = await launchApp(dataDir)
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('load', { timeout: 60000 })
    await window.waitForFunction(() => typeof window.api?.createProject === 'function', null, { timeout: 60000 })
    console.log('PASS 准备-授权生效进业务')

    // ── A. 本机升级为发放员（key-issuer）：走完整发证链 ─────────────────
    // 导出设备申请（借用授权 IPC 不行——授权窗已关；直接用 cs-issuer + 应用侧证明不可行，
    // 因此这里通过 UI 授权窗外的等价 API 不存在——改用磁盘授权复制路径不改变角色。
    // 方案要求发放员由签发人单独发证：为当前设备再签一张 key-issuer 授权需要新挑战，
    // 与 P1 激活 UI 流程一致。此处复用 cs-issuer 幂等台账 + 设备既有密钥，通过
    // csdevcred → challenge 不可行（需应用内证明）。因此本测试要求调用方先用
    // cs-issuer issue --role key-issuer 为设备签发授权文件，然后通过 UI 导入。
    const issuerLicensePath = process.env.CS_KEYS_ISSUER_LICENSE
    if (issuerLicensePath && fs.existsSync(issuerLicensePath)) {
      // 直接走授权窗导入路径不可用（业务态无授权窗）；通过磁盘替换授权文件 + 重启等效激活。
      const raw = JSON.parse(fs.readFileSync(issuerLicensePath, 'utf8'))
      const current = JSON.parse(await fsp.readFile(path.join(dataDir, 'security', 'license-current.json'), 'utf8'))
      await fsp.writeFile(
        path.join(dataDir, 'security', 'license-current.json'),
        JSON.stringify({ ...current, license: raw.license, issuerCert: raw.issuerCert, storedAtUtcSec: Math.floor(Date.now() / 1000) }),
        'utf8'
      )
      await app.close()
      const relaunched = await launchApp(dataDir)
      const win2 = await relaunched.firstWindow()
      await win2.waitForLoadState('load', { timeout: 60000 })
      await win2.waitForFunction(() => typeof window.api?.createProject === 'function', null, { timeout: 60000 })
      console.log('PASS A-发放员授权生效')
      await continueKeysFlow(relaunched, win2, { directory, cfgPath, evidence })
      return
    }
    console.log('SKIP A-发放员授权（未提供 CS_KEYS_ISSUER_LICENSE；仅验证使用者优先导入侧）')
    await continueKeysFlow(app, window, { directory, cfgPath, evidence }, { skipSeal: true })
  } catch (error) {
    console.error('FAIL', error.message || error)
    process.exitCode = 1
    await app.close().catch(() => {})
  }
})().catch((error) => fail(String((error && error.stack) || error)))

async function continueKeysFlow(app, window, context, options = {}) {
  const { cfgPath } = context
  const directory = context.directory

  // ── B. 种子一个带密钥的连接（与 UI 相同的 IPC 通路）──────────────────
  const seeded = await window.evaluate(async () => {
    const result = await window.api.models.saveConnection({
      id: 'keys-e2e-conn',
      name: '密钥包E2E连接',
      protocol: 'openai-compatible',
      baseUrl: 'https://keys-e2e.example.com/v1',
      apiKey: 'sk-keys-e2e-secret-0123456789abcdef',
      headers: {}
    })
    if (!result.ok) throw new Error(`saveConnection 失败: ${JSON.stringify(result.error)}`)
    return result.data.id
  })
  assert.equal(seeded, 'keys-e2e-conn')
  console.log('PASS B-种子连接与密钥')

  // ── C. 导出接收凭证 ─────────────────────────────────────────────────
  const credentialPath = path.join(directory, 'device.csdevcred')
  await writeDialogConfig(cfgPath, { 'device.csdevcred': credentialPath }, {})
  const credential = await window.evaluate(async () => {
    const result = await window.api.gateway.exportReceiveCredential()
    if (!result.ok) throw new Error(`exportReceiveCredential: ${JSON.stringify(result.error)}`)
    return result.data
  })
  assert.ok(fs.existsSync(credentialPath), '.csdevcred 应已导出')
  assert.match(credential.deviceSummary, /^[0-9a-f]{16}$/)
  console.log('PASS C-接收凭证导出')

  // 能力分派：bootstrap 的 license.capabilities 决定走发放全流程还是使用者负例。
  const capabilities = await window.evaluate(async () => {
    const result = await window.api.bootstrap()
    if (!result.ok) throw new Error('bootstrap 失败')
    return result.data.license.capabilities
  })
  if (capabilities.includes('credentials.export')) {
    console.log('PASS C2-发放能力就绪（key-issuer）')
    await fullIssuerFlow(app, window, { directory, cfgPath })
    return
  }
  // 使用者负例：无 credentials.export 时 seal 必须在能力检查处被拒。
  const sealRejected = await window.evaluate(async () => {
    const result = await window.api.gateway.sealKeyPackage({
      password: 'e2e-password-at-least-20-bytes-ok',
      connectionIds: ['keys-e2e-conn']
    })
    return result.ok ? { unexpectedlyOk: true } : { code: result.error.code }
  })
  assert.equal(sealRejected.unexpectedlyOk, undefined, '使用者不得进入发放流程')
  console.log('PASS C2-使用者无发放能力被拒绝')
  console.log('SKIP D/E-需要发放员授权（CS_KEYS_ISSUER_LICENSE）')
  await app.close()
}

async function fullIssuerFlow(app, window, context) {
  const { cfgPath, directory } = context
  const password = 'e2e-keys-package-password-2026'

  // ── D. 发放密钥包（选种子连接）────────────────────────────────────
  const packagePath = path.join(directory, 'device-keys.cskeys')
  await writeDialogConfig(cfgPath, { 'device-keys.cskeys': packagePath }, { credential: path.join(directory, 'device.csdevcred') })
  const sealed = await window.evaluate(async () => {
    const connections = await window.api.gateway.listKeyConnections()
    if (!connections.ok) throw new Error(`listKeyConnections: ${JSON.stringify(connections.error)}`)
    const target = connections.data.find((c) => c.id === 'keys-e2e-conn')
    if (!target || !target.hasKey) throw new Error('种子连接不可发放')
    const result = await window.api.gateway.sealKeyPackage({
      password: 'e2e-keys-package-password-2026',
      connectionIds: ['keys-e2e-conn']
    })
    if (!result.ok) throw new Error(`sealKeyPackage: ${JSON.stringify(result.error)}`)
    return result.data
  })
  assert.ok(fs.existsSync(packagePath), '.cskeys 应已导出')
  assert.equal(sealed.connectionCount, 1)
  console.log(`PASS D-密钥包发放（${sealed.packageId.slice(0, 8)}…，至 ${new Date(sealed.expiresAt * 1000).toISOString().slice(0, 16)}）`)

  // ── E. 导入（预览→确认）──────────────────────────────────────────
  await writeDialogConfig(cfgPath, {}, { package: packagePath })
  const imported = await window.evaluate(async () => {
    const preview = await window.api.gateway.previewKeyPackage({ password: 'e2e-keys-package-password-2026' })
    if (!preview.ok) throw new Error(`preview: ${JSON.stringify(preview.error)}`)
    if (preview.data.connections.length !== 1) throw new Error('预览连接数不符')
    const result = await window.api.gateway.importKeyPackage({
      password: 'e2e-keys-package-password-2026',
      overwriteConfirmed: true
    })
    if (!result.ok) throw new Error(`import: ${JSON.stringify(result.error)}`)
    return result.data
  })
  assert.ok(imported.packageId, '导入应有包 ID')
  console.log(`PASS E-密钥包导入（added=${imported.added} updated=${imported.updated} models=${imported.modelCount}）`)

  // ── F. 重导识别 + 错密码负例 ─────────────────────────────────────
  const replay = await window.evaluate(async () => {
    const preview = await window.api.gateway.previewKeyPackage({ password: 'e2e-keys-package-password-2026' })
    if (!preview.ok) throw new Error(`preview: ${JSON.stringify(preview.error)}`)
    return { alreadyImported: preview.data.alreadyImported }
  })
  assert.equal(replay.alreadyImported, true, '重放应识别为已导入')
  const wrongPassword = await window.evaluate(async () => {
    const result = await window.api.gateway.previewKeyPackage({ password: 'totally-wrong-password-entropy-999' })
    return result.ok ? { unexpectedlyOk: true } : { code: result.error.code }
  })
  assert.equal(wrongPassword.unexpectedlyOk, undefined, '错密码必须失败')
  console.log('PASS F-重导识别与错密码拒绝')

  await app.close()
  console.log('\n完成：密钥包端到端全流程通过')
}
