/**
 * 本机授权工具：诊断 / 备份 / 恢复 / 一键修复。
 *
 * 为什么需要它：授权是"设备 + 信任根"双绑定。开发根一旦被重新 init-root，旧根签发的授权
 * 立刻作废，本机就会反复被要求授权；而新根的私钥往往只在生成它的那台机器上。
 * 这个工具把"排查 + 修复"收敛成几条命令，不需要人反复点授权界面。
 *
 * 子命令：
 *   check     诊断：构建信任根 kid、本机 store kid、已存授权 kid 是否一致；数据目录与授权状态
 *   backup    把本机开发根（qa/security-dev-root）复制到 %USERPROFILE%\.canvas-studio-license-root
 *   restore   从上述备份恢复开发根（换机器/重装后先做这一步，别急着 init-root）
 *   repair    一键修复：用本机可用的开发根重新签发并导入授权（约 20 秒，无需手点界面）
 *
 * 用法：
 *   node scripts/license-tool.cjs check
 *   node scripts/license-tool.cjs repair            # 用默认 store
 *   node scripts/license-tool.cjs repair --store qa/security-dev-root
 *   node scripts/license-tool.cjs backup / restore
 */
const { spawnSync } = require('node:child_process')
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, resolve } = require('node:path')

const root = process.cwd()
const DEFAULT_STORE = join(root, 'qa', 'security-dev-root')
const BACKUP_STORE = join(homedir(), '.canvas-studio-license-root')
const DATA_DIR = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'canvas-studio', 'data')

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}
const store = resolve(arg('--store', DEFAULT_STORE))

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 构建内固定的信任根（从生成文件里读 kid）。 */
function buildTrustedRootKid() {
  const file = join(root, 'src', 'main', 'security', 'license', 'trusted-root.generated.ts')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const kid = /kid:\s*'([^']+)'/.exec(text)
  return kid ? kid[1] : null
}

function storedLicenseKid() {
  const file = join(DATA_DIR, 'security', 'license-current.json')
  const json = readJson(file)
  if (!json) return { exists: false }
  const cert = json.issuerCert?.payload
  return {
    exists: true,
    issuerKid: cert?.certId ? undefined : undefined,
    issuerSubject: cert?.subject,
    storedAt: json.storedAtUtcSec,
    // 授权本身不带根 kid；这里只报告存在与否与签发人主体
    raw: json
  }
}

function check() {
  const buildKid = buildTrustedRootKid()
  const storeRoot = readJson(join(store, 'root.public.json'))
  const storeIssuer = readJson(join(store, 'issuer-cert.json'))
  const license = storedLicenseKid()
  console.log('— 授权诊断 —')
  console.log('数据目录        : ' + DATA_DIR + (existsSync(DATA_DIR) ? '' : '（不存在）'))
  console.log('构建信任根 kid  : ' + (buildKid ?? '（未找到生成文件）'))
  console.log('本机 store      : ' + store + (existsSync(store) ? '' : '（不存在）'))
  console.log('store 根 kid    : ' + (storeRoot?.kid ?? '（缺失）'))
  console.log('store 签发人    : ' + (storeIssuer?.payload?.subject ?? '（缺失）'))
  console.log('已存授权        : ' + (license.exists ? '有（签发人 ' + license.issuerSubject + '）' : '无'))
  console.log('备份位置        : ' + BACKUP_STORE + (existsSync(BACKUP_STORE) ? '' : '（尚未备份）'))

  const rootMismatch = Boolean(buildKid && storeRoot?.kid && buildKid !== storeRoot.kid)
  if (rootMismatch) {
    console.log('\n⚠ 构建信任根与本机 store 的根**不一致**：本机无法为当前构建签发有效授权。')
    console.log('  这正是"反复要求授权"的根因：换根了，但新根私钥不在本机。')
    console.log('  解决（二选一）：')
    console.log('    1) 用本机根的构建：CANVAS_LICENSE_TRUSTED_ROOT_STORE=' + store + '（须未打包构建）')
    console.log('    2) 从生成新根的那台机器把 root 私钥 store 拷到本机，再跑 license:repair')
  } else if (!license.exists) {
    console.log('\n→ 根一致但没有授权：跑 npm run license:repair 一键签发。')
  } else {
    console.log('\n→ 根与授权看起来匹配；若界面仍要求授权，先看 %APPDATA%\\canvas-studio\\logs\\main.log 的 license 行。')
  }
  return rootMismatch ? 2 : 0
}

function backup() {
  if (!existsSync(join(store, 'root.public.json'))) {
    console.error('本机 store 不存在：' + store)
    return 1
  }
  mkdirSync(BACKUP_STORE, { recursive: true })
  cpSync(store, BACKUP_STORE, { recursive: true, force: true })
  console.log('已备份开发根到：' + BACKUP_STORE)
  console.log('提示：换电脑/重装系统后先跑 license:restore，不要重新 init-root（那会让旧授权全部作废）。')
  return 0
}

function restore() {
  if (!existsSync(join(BACKUP_STORE, 'root.public.json'))) {
    console.error('备份不存在：' + BACKUP_STORE)
    return 1
  }
  cpSync(BACKUP_STORE, store, { recursive: true, force: true })
  console.log('已从备份恢复开发根到：' + store)
  return 0
}

function repair() {
  if (!existsSync(join(store, 'root.public.json'))) {
    console.error('本机 store 不存在，无法签发：' + store)
    console.error('先跑 license:restore，或从生成根的机器拷贝 store。')
    return 1
  }
  // 优先用入库版本（qa/ 被 gitignore，换机后可能不存在，而修复必须能跑）。
  const activateCandidates = [
    join(root, 'scripts', 'activate-dev-license.cjs'),
    join(root, 'qa', 'activate-dev-license.cjs')
  ]
  const activate = activateCandidates.find((candidate) => existsSync(candidate))
  if (!activate) {
    console.error('缺少激活脚本 scripts/activate-dev-license.cjs')
    return 1
  }
  // 关键：让**未打包构建**信任本机 store 的根，否则签出来的授权不会被接受。
  const env = {
    ...process.env,
    CANVAS_LICENSE_TRUSTED_ROOT_STORE: store,
    CS_LICENSE_STORE: store
  }
  delete env.ELECTRON_RUN_AS_NODE
  console.log('正在用本机根重新签发并导入授权（store=' + store + '）…')
  const result = spawnSync(process.execPath, [activate, '--store', store], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 10 * 60_000
  })
  if (result.status !== 0) {
    console.error('修复失败（exit ' + result.status + '）。可先用 license:check 看根是否匹配。')
    return result.status ?? 1
  }
  console.log('修复完成：重新打开应用应该不再要求授权。')
  return 0
}

const command = process.argv[2] ?? 'check'
const handlers = { check, backup, restore, repair }
const handler = handlers[command]
if (!handler) {
  console.error('未知子命令：' + command + '（可用：check / backup / restore / repair）')
  process.exit(2)
}
process.exit(handler())
