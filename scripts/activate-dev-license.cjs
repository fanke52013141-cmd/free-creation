/**
 * 开发机一次性激活工具（仅本机开发/自测使用，不进入产品运行时）。
 *
 * 背景：当前源码构建开启了强制授权门禁（未激活停在授权窗），而本机此前从未保存过
 * 授权凭证（数据目录下没有 security/）。本脚本走与 `test-agent-graph-milestone.cjs`
 * **完全相同**的合法协作激活流程：
 *   导出设备申请 → issuer 登记 EK + 签发挑战 → 导入挑战 → 导出证明 → issuer 签发授权 → 导入
 * 区别只是目标是**默认数据目录**（用户真实使用的位置），且签发 permanent 授权。
 *
 * 用法：node qa/activate-dev-license.cjs
 * 说明：不会伪造签名、不会绕过校验——用的是仓库自带的 issuer 与 trusted root。
 */
const { _electron: electron } = require('playwright')
const { execFileSync } = require('node:child_process')
const { writeFileSync, existsSync, mkdtempSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const appRoot = resolve('.')
// 允许指定开发根 store（换根/换机后用参数指定本机实际持有的根）。
const storeIndex = process.argv.indexOf('--store')
const storeDir =
  storeIndex >= 0 && process.argv[storeIndex + 1]
    ? resolve(process.argv[storeIndex + 1])
    : join(appRoot, 'qa', 'security-dev-root')
const work = mkdtempSync(join(tmpdir(), 'canvas-dev-activate-'))
const dialogCfg = join(work, 'dialog-config.json')
const reqPath = join(work, 'device.csreq')
const challengePath = join(work, 'device.cschallenge')
const proofPath = join(work, 'device.csproof')
const licensePath = join(work, 'device.cslicense')

function setDialogs(savePaths, openPaths) {
  writeFileSync(dialogCfg, JSON.stringify({ savePaths, openPaths }), 'utf8')
}

function runIssuer(args) {
  return execFileSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      join(appRoot, 'tools/cs-issuer/cli.ts'),
      ...args,
      '--store',
      storeDir
    ],
    { encoding: 'utf8', timeout: 180000, cwd: appRoot }
  )
}

/** 覆盖文件对话框 + 注入 lifecycle 记录，然后加载真实 main 入口。 */
function makeBootstrap() {
  const file = join(work, 'bootstrap.cjs')
  writeFileSync(
    file,
    `
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
`,
    'utf8'
  )
  return file
}

async function main() {
  if (!existsSync(join(appRoot, 'out/main/index.js'))) {
    console.log('缺少构建产物 out/main/index.js，请先 npm run build')
    return
  }
  const bootstrap = makeBootstrap()
  setDialogs({}, {})
  // 关键：从 shell 继承的 ELECTRON_RUN_AS_NODE=1 会让 electron 以纯 Node 模式启动
  // （electron.app 为 undefined → @electron-toolkit/utils 直接抛错），必须剔除。
  // 让未打包构建信任这个 store 的根：否则本机根与仓库固定根不一致时，
  // 签出来的授权不会被应用接受（这是"反复要求授权"的典型成因）。
  const env = {
    ...process.env,
    CS_LICENSE_QA_CFG: dialogCfg,
    CANVAS_LICENSE_TRUSTED_ROOT_STORE: storeDir
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.CANVAS_DATA_DIR
  // 关键 2：本脚本用 bootstrap 文件作为 app 入口，Electron 找不到 package.json，
  // app name 会退化成 "Electron"，userData 变成 %APPDATA%\Electron —— 授权就写到那里，
  // 真正的应用（name=canvas-studio）读不到。显式用 --user-data-dir 钉死到真实 userData。
  const realUserData = join(process.env.APPDATA || '', 'canvas-studio')
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [bootstrap, '--user-data-dir=' + realUserData],
    env,
    timeout: 60000
  })
  let win = await app.firstWindow()
  await win.waitForLoadState('load', { timeout: 30000 }).catch(() => undefined)
  const body = await win.textContent('body').catch(() => '')
  if (!body.includes('导出设备申请')) {
    console.log('当前已是激活状态（或未出现授权窗），无需处理。')
    await app.close().catch(() => undefined)
    return
  }
  console.log('检测到授权窗，开始协作激活…')

  // 1) 导出设备申请
  setDialogs({ 'device.csreq': reqPath }, {})
  await win.click('#btn-export-request')
  await win.waitForFunction(
    () => {
      const node = document.getElementById('diagnostic')
      return node && !node.hidden && node.textContent.includes('导出申请完成')
    },
    null,
    { timeout: 120000 }
  )
  if (!existsSync(reqPath)) throw new Error('设备申请导出失败')

  // 2) issuer 登记 EK + 签发挑战
  runIssuer(['enroll-ek', '--request', reqPath, '--note', 'local-dev-activation'])
  runIssuer(['challenge', '--request', reqPath, '--out', challengePath])

  // 3) 导入挑战
  setDialogs({}, { challenge: challengePath })
  await win.click('#btn-import-challenge')
  await win.waitForFunction(
    () => document.getElementById('diagnostic').textContent.includes('导入挑战完成'),
    null,
    { timeout: 90000 }
  )

  // 4) 导出证明
  setDialogs({ 'device.csproof': proofPath }, {})
  await win.click('#btn-export-proof')
  await win.waitForFunction(
    () => document.getElementById('diagnostic').textContent.includes('导出证明完成'),
    null,
    { timeout: 90000 }
  )
  if (!existsSync(proofPath)) throw new Error('设备证明导出失败')

  // 5) issuer 签发授权（永久、recipient 角色）
  runIssuer([
    'issue',
    '--proof',
    proofPath,
    '--permanent',
    '--role',
    'recipient',
    '--operator',
    'local-dev-activation',
    '--out',
    licensePath
  ])

  // 6) 导入授权 → 应进入业务窗
  setDialogs({}, { license: licensePath })
  await win.click('#btn-import-license')
  let business = null
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !business) {
    business = app.windows().find((candidate) => candidate !== win) ?? null
    if (!business) await new Promise((done) => setTimeout(done, 500))
  }
  if (!business) throw new Error('导入授权后未出现业务窗口')
  await business.waitForLoadState('load', { timeout: 60000 }).catch(() => undefined)
  const titles = await business.evaluate(() => document.title).catch(() => '')
  console.log('激活成功，业务窗口标题: ' + titles)
  console.log('数据目录: ' + join(process.env.APPDATA, 'canvas-studio', 'data'))
  await app.close().catch(() => undefined)
}

main().catch((error) => {
  console.log('ACTIVATION_FAILED: ' + (error && error.message ? error.message : String(error)))
})
