import { app, clipboard, shell, BrowserWindow, protocol, Menu, net, powerMonitor } from 'electron'
import { setImageNetworkFetch } from './gateway/image'
import { join, extname, isAbsolute } from 'path'
import { createReadStream, existsSync, readFileSync } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import icon from '../../resources/icon.png?asset'
import { registerProjectIpc } from './ipc/project.ipc'
import { startLocalAccessServer, type LocalAccessServer } from './agent-access/server'
import { createAccessDesktop } from './agent-access/desktop'
import { registerLocalAgentTaskReports } from './agent-access/reports'
import { publishKeysPackageAccessPort } from './agent-access/keys-bridge'
import { emitDomainEvent } from './diagnostics/ipc-domain-events'
import { registerFlowAssetsIpc } from './ipc/flow-assets.ipc'
import { registerFlowCommandsIpc } from './ipc/flow-commands.ipc'
import { registerFlowAgentsIpc } from './ipc/flow-agents.ipc'
import { ProjectFileWatcher } from './ipc/project-watcher'
import { registerMediaIpc } from './ipc/media.ipc'
import { registerGatewayIpc } from './ipc/gateway.ipc'
import { registerWorkspaceStateIpc } from './ipc/workspace-state.ipc'
import { registerModelIpc } from './ipc/models.ipc'
import { registerDiagnosticsIpc, setDiagnosticsService } from './ipc/diagnostics.ipc'
import {
  initDiagnosticsService,
  checkPreviousSession,
  type DiagnosticsService
} from './diagnostics/service'
import { nodeFsStore } from './diagnostics/fs-types'
import { setGatewayEventSink } from './diagnostics/gateway-events'
import {
  DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS,
  DiagnosticsProducer,
  newProducerId
} from '../shared/observability'
import { drainRendererDiagnostics } from './diagnostics/renderer-shutdown'
import { registerLibraryIpc } from './ipc/library.ipc'
import { SqliteModelHost } from './model-host/sqlite-model-host'
import { createDesktopModelRuntime } from './model-host/runtime'
import { closeDb, getDataDir, getDb, getProjectsDir } from './store/db'
import { acquireProcessLock, type ProcessLock } from './store/process-lock'
import { checkWorkspaceHealth, sweepStaleVideoTempFiles } from './store/workspace-health'
import { bootstrapLegacyProvidersToCatalog, saveProvider } from './gateway/providers.repo'
import { DREAMINA_IMAGE_MODELS, DREAMINA_VIDEO_MODELS } from '../shared/dreamina-models'
import { DISTRIBUTION_EDITION } from '../shared/edition'
import { SecretVault, setActiveVault } from './security/keystore/vault'
import { migrateSecretsToVault } from './security/keystore/migrate'
import type { DeviceKeyAdapter } from './security/license/device/adapter'
import { getMediaAbsPath } from './store/media.repo'
import { mimeForExtension } from '../shared/mime'
import { runModelSmokeTest, printSmokeGateBlocked } from './model-smoke'
import { LicenseService, type LicenseSnapshot } from './security/license/service'
import { markLicenseGateRequired } from './security/license/gate'
import { registerLicenseIpc, setLicenseServiceForIpc } from './ipc/license.ipc'
import { createLicenseWindow, closeLicenseWindow, getLicenseWindow } from './security/license/license-window'
import { selectDeviceAdapter, setGateAdapter } from './security/license/device/select'
import { KeyPackageService, type KeyPackageDatabase } from './security/keystore/keypackage-service'
import { TRUSTED_ROOT } from './security/license/trusted-root.generated'

log.initialize()
log.info('main process starting', {
  appVersion: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  node: process.versions.node
})

// ── 统一诊断事件底座（L01/L02）──────────────────────────────────────────────
// main 侧生产者：app.* 生命周期与网关边界事件的唯一来源；sessionId 由服务分配，
// 环境/版本信息随服务写入 session 状态文件，诊断包据此携带。
let diagnostics: DiagnosticsService | null = null
let quitting = false
let localAccessServer: LocalAccessServer | null = null
let desktopDataOwnership: ProcessLock | null = null
let rendererDiagnosticsComplete = true
let shutdownDeadlineAt: number | null = null
const rendererDrainPromises = new Map<BrowserWindow, Promise<boolean>>()
const mainProducer = new DiagnosticsProducer({
  process: 'main',
  producerId: newProducerId('main')
})

function remainingShutdownTimeMs(): number {
  if (shutdownDeadlineAt === null) return DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS
  return Math.max(0, shutdownDeadlineAt - Date.now())
}

function drainWindowDiagnostics(window: BrowserWindow, timeoutMs: number): Promise<boolean> {
  const existing = rendererDrainPromises.get(window)
  if (existing) return existing
  const draining = drainRendererDiagnostics(window, timeoutMs).finally(() => {
    if (rendererDrainPromises.get(window) === draining) rendererDrainPromises.delete(window)
  })
  rendererDrainPromises.set(window, draining)
  return draining
}

async function initDiagnostics(): Promise<DiagnosticsService | null> {
  try {
    const service = await initDiagnosticsService({
      dataDir: getDataDir(),
      producer: mainProducer,
      env: {
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? '',
        chromium: process.versions.chrome ?? '',
        node: process.versions.node ?? ''
      }
    })
    setDiagnosticsService(service)
    setGatewayEventSink(service)
    diagnostics = service
    service.emit(mainProducer.build('app.session_started', undefined, '主进程会话开始', {}))
    const sessionsDir = join(getDataDir(), 'diagnostics', 'sessions')
    if (await checkPreviousSession(nodeFsStore(), sessionsDir, service.sessionId)) {
      service.emit(
        mainProducer.build('app.previous_session_unclean', undefined, '上次会话未正常结束', {})
      )
      log.warn('[diagnostics] previous session did not end cleanly')
    }
    return service
  } catch (error) {
    // 日志底座失败不阻断启动：降级为 electron-log 摘要。
    log.warn(
      '[diagnostics] structured event storage unavailable:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

// media:// 协议：渲染进程加载本地媒体（stream 支持 <video> 播放）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    // <video> 需要的不只是 stream：标准/安全来源和 Fetch 支持让 Chromium 能建立
    // Range 请求、读取元数据并在预览浮层里播放本地 MP4/WebM。
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url)
    // privileges.standard=true 时 Chromium 按标准 URL 解析 media:///a/b/c：
    // 首段路径会被当作主机名（host='a'，pathname='/b/c'）。因此 relPath 必须
    // 由 host + pathname 拼接还原，否则 `projects/` 前缀丢失，所有媒体 404 破图。
    // 约定：所有媒体相对路径都以字面量 `projects/` 开头（全小写，见 media.repo），
    // 它成为 host 时不会被 Chromium 的小写化破坏；plain 模式下 host 为空，拼接同样成立。
    const relPath = decodeURIComponent(`${url.host}${url.pathname}`).replace(/^\/+/, '')
    const abs = getMediaAbsPath(relPath)
    if (!abs) {
      return new Response(null, { status: 403 })
    }

    const ext = extname(abs).toLowerCase()
    const contentType = mimeForExtension(ext)

    // 异步 stat：避免在主进程事件循环同步阻塞（慢盘 / 网络盘会卡住整个主进程）。
    let fileSize: number
    try {
      fileSize = (await stat(abs)).size
    } catch {
      // 文件不存在或不可读：返回 404，不抛错（协议处理器抛错会被吞）
      return new Response(null, { status: 404 })
    }

    // 解析 Range 头（<video> 拖进度条时浏览器发送）
    const range = request.headers.get('range') ?? request.headers.get('Range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0
        let end = m[2] ? parseInt(m[2], 10) : fileSize - 1
        // 边界钳制：畸形 Range 不能产生错误的 Content-Range / Content-Length
        if (start < 0) start = 0
        if (end > fileSize - 1) end = fileSize - 1
        if (start >= fileSize) {
          // 起点越过文件尾：标准要求 416 + Content-Range: bytes */<size>
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` }
          })
        }
        if (end < start) end = start
        const chunkSize = end - start + 1
        const stream = createReadStream(abs, { start, end })
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize),
            'Content-Type': contentType
          }
        })
      }
    }

    // 无 Range 或格式异常 → 返回完整文件
    const stream = createReadStream(abs)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Length': String(fileSize),
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      }
    })
  })
}

function createWindow(): BrowserWindow {
  // 2026-10-31 修复「选中文本无法复制」：应用菜单置空会让 role 快捷键（Ctrl+C/X/V/A）
  // 全部失效，且右键无菜单。改为安装仅含编辑角色的应用菜单，窗口菜单栏仍保持隐藏
  // （mainWindow.setMenu(null) 只隐藏菜单栏，不动 accelerators）。
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      }
    ])
  )
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        color: '#0d0d0d',
        symbolColor: '#aeb5c0',
        height: 46
      }
    } : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.setMenu(null)

  // 右键上下文菜单：可编辑区给剪切/复制/粘贴，有选区给复制，链接/图片给对应复制项。
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      template.push(
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      )
    } else if (params.selectionText.trim()) {
      template.push({ role: 'copy' })
    } else if (params.mediaType === 'image' && params.srcURL) {
      template.push({
        label: '复制图片链接',
        click: () => clipboard.writeText(params.srcURL)
      })
    } else if (params.linkURL) {
      template.push({
        label: '复制链接地址',
        click: () => clipboard.writeText(params.linkURL)
      })
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: mainWindow })
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  let closeDrainPending = false
  let closeAfterDiagnosticsDrain = false
  mainWindow.on('close', (event) => {
    if (quitting || closeAfterDiagnosticsDrain || !diagnostics) return
    event.preventDefault()
    if (closeDrainPending) return
    closeDrainPending = true
    // On platforms that quit after the last window closes, the renderer and main
    // queues share one deadline. macOS may keep the session alive after window close.
    const isLastWindow = BrowserWindow.getAllWindows().length <= 1
    if (process.platform !== 'darwin' && isLastWindow && shutdownDeadlineAt === null) {
      shutdownDeadlineAt = Date.now() + DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS
    }
    const timeoutMs =
      process.platform === 'darwin' || !isLastWindow
        ? DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS
        : remainingShutdownTimeMs()
    void drainWindowDiagnostics(mainWindow, timeoutMs)
      .then((complete) => {
        rendererDiagnosticsComplete = rendererDiagnosticsComplete && complete
      })
      .catch(() => {
        rendererDiagnosticsComplete = false
      })
      .finally(() => {
        closeDrainPending = false
        closeAfterDiagnosticsDrain = true
        if (!mainWindow.isDestroyed()) mainWindow.close()
      })
  })

  // 渲染进程崩溃/被杀：记录可用退出码，异常后仍执行原有窗口策略（不吞异常继续）。
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    rendererDiagnosticsComplete = false
    diagnostics?.emit(
      mainProducer.build(
        'app.process_exited',
        undefined,
        '渲染进程异常退出',
        {},
        {
          error: { code: 'PROCESS_EXITED', category: 'process', retryable: false },
          attributes: { reason: details.reason, exitCode: details.exitCode ?? 0 }
        }
      )
    )
    log.error('[diagnostics] renderer process gone', details.reason, details.exitCode ?? '')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const url = new URL(details.url)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

const isModelSmokeTest = process.argv.includes('--model-smoke-test')

// ── 授权门禁实现（方案 §3.3 / §6 P1）────────────────────────────────────────

interface LicenseGateOutcome {
  service: LicenseService
  adapter: DeviceKeyAdapter
}

/**
 * 开发构建的授权便利开关（**仅未打包构建生效**，发布包一律忽略）：
 *
 * 背景：授权是"设备 + 信任根"双绑定的。开发根一旦被重新 init-root，旧根签发的授权
 * 立刻作废，本机就会反复被要求授权；而新根的私钥往往只在生成它的那台机器上。
 *
 * 两个环境变量只服务于本机开发/自测：
 * - `CANVAS_LICENSE_TRUSTED_ROOT_STORE=<dir>`：用该目录的 `root.public.json` 作为信任根。
 *   本机只有旧根私钥时，用它就能继续用旧根签发/校验，不被仓库里的新根阻断。
 * - `CANVAS_LICENSE_DEV_BYPASS=1`：完全跳过授权门禁（调试用，日志会留痕）。
 *
 * 发布包（`app.isPackaged`）不读这两个变量，因此不影响发行版安全。
 */
function resolveDevelopmentTrustedRoot(): typeof TRUSTED_ROOT {
  if (app.isPackaged) return TRUSTED_ROOT
  // 优先读"本机开发配置"（gitignored，一次写好就不用再管）：
  //   <repo>/.canvas-license-dev.json  →  { "trustedRootStore": "qa/security-dev-root" }
  let storeDir = process.env.CANVAS_LICENSE_TRUSTED_ROOT_STORE
  if (!storeDir) {
    try {
      const configPath = join(app.getAppPath(), '.canvas-license-dev.json')
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
          trustedRootStore?: unknown
        }
        if (typeof config.trustedRootStore === 'string' && config.trustedRootStore.trim())
          storeDir = config.trustedRootStore.trim()
      }
    } catch {
      // 配置损坏不阻断启动：回退到构建内固定根。
    }
  }
  if (!storeDir) return TRUSTED_ROOT
  const resolvedStore = isAbsolute(storeDir) ? storeDir : join(app.getAppPath(), storeDir)
  try {
    const file = join(resolvedStore, 'root.public.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      kid?: unknown
      publicKey?: unknown
      environment?: unknown
    }
    if (typeof raw.kid !== 'string' || typeof raw.publicKey !== 'string')
      throw new Error('root.public.json 缺少 kid/publicKey')
    log.warn(
      `license: 开发构建使用了信任根覆盖 store=${resolvedStore} kid=${raw.kid}（发布包不会这样）`
    )
    return {
      ...TRUSTED_ROOT,
      kid: raw.kid,
      publicKey: raw.publicKey
    } as typeof TRUSTED_ROOT
  } catch (error) {
    log.error(
      'license: 忽略无效的开发信任根配置（' +
        (error instanceof Error ? error.message : String(error)) +
        '），回退到构建内固定根'
    )
    return TRUSTED_ROOT
  }
}

async function bootLicenseGate(): Promise<LicenseGateOutcome | null> {
  // 仅开发构建（未打包）允许跳过门禁；发布包不读该开关。
  if (!app.isPackaged && process.env.CANVAS_LICENSE_DEV_BYPASS === '1') {
    log.warn('license: 已通过 CANVAS_LICENSE_DEV_BYPASS 跳过授权门禁（仅开发构建；发布包不生效）')
    return null
  }
  const { adapter, detail } = await selectDeviceAdapter({ dataDir: getDataDir() })
  log.info(`license: 设备适配器=${adapter.keySource}（${detail}）`)
  const service = new LicenseService({
    root: resolveDevelopmentTrustedRoot(),
    adapter,
    storageDir: join(getDataDir(), 'security')
  })
  // 授权窗 IPC 先于业务 IPC 注册；服务注入同时接通业务守卫。
  registerLicenseIpc()
  setLicenseServiceForIpc(service)
  markLicenseGateRequired()

  const snapshot = await service.evaluateOnBoot('boot')
  if (snapshot.state === 'active') {
    return { service, adapter }
  }

  // 无界面模型冒烟同样被门禁封闭：不落库、不发起请求，输出原因码退出。
  if (isModelSmokeTest) {
    printSmokeGateBlocked(snapshot.reasonCode ?? snapshot.state)
    app.exit(1)
    return null
  }

  // 授权窗路径：等待用户完成激活，或关闭窗口退出。
  log.info(`license: 未激活（${snapshot.reasonCode ?? snapshot.state}），进入授权窗`)
  createLicenseWindow()
  const activated = await waitForLicenseActivation(service)
  if (!activated) {
    app.exit(0)
    return null
  }
  // 注意：此处不关闭授权窗 —— win32 下零窗口会触发 window-all-closed → app.quit，
  // 业务窗尚未创建。授权窗在业务窗就绪后由 whenReady 主体关闭。
  return { service, adapter }
}

function waitForLicenseActivation(service: LicenseService): Promise<boolean> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (service.snapshot.state === 'active') {
        clearInterval(poll)
        resolve(true)
        return
      }
      const window = getLicenseWindow()
      if (!window || window.isDestroyed()) {
        clearInterval(poll)
        resolve(false)
      }
    }, 500)
  })
}

app.whenReady().then(async () => {
  // 仅安装传输适配器；请求阶段仍由 gateway/image.ts 的 emitGatewayEvent 统一记录。
  setImageNetworkFetch((input, init) => net.fetch(input instanceof URL ? input.href : input, init))
  electronApp.setAppUserModelId('com.canvas-studio.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ── 授权门禁（方案 §3.3）───────────────────────────────────────────────
  // 必须先于一切数据库访问（含进程锁的 SQLite 表）、诊断、密钥迁移、
  // 业务 IPC、媒体协议与外部接入：未激活时只提供授权窗。
  // 发行版（CANVAS_DISTRIBUTION=1）：不做授权、不注入设备密钥库——
  // API Key 走系统安全存储（DPAPI），导入即用。
  let gate: LicenseGateOutcome | null = null
  let vault: SecretVault | null = null
  if (!DISTRIBUTION_EDITION) {
    gate = await bootLicenseGate()
    if (!gate) {
      return // 授权窗路径：waitForLicenseActivation 未通过，应用已退出
    }
  }
  const licenseService = gate?.service

  // A single desktop owner per data store protects unsaved renderers even without local access.
  // 进程锁基于 SQLite，因此放在授权门禁之后（未授权实例不得触碰项目数据库）。
  try {
    desktopDataOwnership = acquireProcessLock('desktop-data-owner')
  } catch {
    app.exit(1)
    return
  }
  // ── 门禁通过：进入既有业务启动路径 ─────────────────────────────────────

  // 数据目录锁准入后，先启用诊断，再执行业务：session_started / 上次非正常结束检查。
  await initDiagnostics()

  const database = getDb()
  // 发行版：预置即梦供应商与模型清单——客户打开模型设置即可见「即梦（本机 CLI）」，
  // 只需点「登录即梦」完成本机 OAuth 即可使用（CLI 已随包内置，无需下载）。
  if (DISTRIBUTION_EDITION) {
    const dreaminaRow = database.prepare('SELECT id FROM providers WHERE id = ?').get('dreamina')
    if (!dreaminaRow) {
      try {
        await saveProvider({
          id: 'dreamina',
          name: '即梦（本机 CLI）',
          specId: 'dreamina',
          baseURL: '',
          models: [
            ...DREAMINA_IMAGE_MODELS.map((id) => ({ id, modality: 'image' as const })),
            ...DREAMINA_VIDEO_MODELS.map((id) => ({ id, modality: 'video' as const }))
          ]
        })
        log.info('distribution: 已预置即梦供应商（登录后即可使用）')
      } catch (error) {
        log.warn(`distribution: 即梦供应商预置失败：${String((error as Error).message).slice(0, 120)}`)
      }
    }
  }
  // P2 设备绑定密钥库：迁移在激活后的启动事务中执行（方案 §4.3）；
  // 失败的行保留原值并计入 pending，下次启动重试。plain:/裸值曾在磁盘上
  // 存在过可复制明文，结果里带轮换提示。
  if (gate) {
    vault = new SecretVault({ adapter: gate.adapter, database: getDb })
    setActiveVault(vault)
    setGateAdapter(gate.adapter)
    const migrationResult = await migrateSecretsToVault({ vault, database })
    if (migrationResult.migrated || migrationResult.pending) {
      log.info(
        `vault: 密钥迁移完成 ${migrationResult.migrated} 条，待修复 ${migrationResult.pending} 条` +
          (migrationResult.rotatedRecommended ? `；其中 ${migrationResult.rotatedRecommended} 条曾为可复制明文，建议在供应商侧轮换` : '')
      )
    }
  }
  checkWorkspaceHealth({
    projectsDir: getProjectsDir(),
    projectIds: (
      database.prepare('SELECT id FROM projects WHERE deleted = 0').all() as Array<{ id: string }>
    ).map((row) => row.id),
    knownProjectIds: (
      database.prepare('SELECT id FROM projects').all() as Array<{ id: string }>
    ).map((row) => row.id)
  })
  // 数据根目录残留超过 24 小时的成片临时文件（tmp-video-*）在启动时兜底清扫；
  // 时限内不动，避免误删并行实例正在写的文件。
  const sweptVideoTemps = sweepStaleVideoTempFiles(getDataDir())
  if (sweptVideoTemps.length) {
    log.info(`workspace health: 已清扫 ${sweptVideoTemps.length} 个过期的成片临时文件`)
  }
  registerMediaProtocol()

  // 无界面真实验收：复用桌面端主进程的安全存储与网关，避免把真实 Token 测试建立在
  // 外部 GUI 自动化是否能捕获 Electron 窗口这一不稳定前提上。
  if (isModelSmokeTest) {
    const kindArg = process.argv.find((arg) => arg.startsWith('--model-smoke-kind='))
    const runVoiceClone = process.argv.includes('--model-smoke-voice-clone')
    const runVoiceDesign = process.argv.includes('--model-smoke-voice-design')
    const runChatNode = process.argv.includes('--model-smoke-chat-node')
    const requestedKinds = kindArg
      ?.slice('--model-smoke-kind='.length)
      .split(',')
      .map((kind) => kind.trim())
      .filter(
        (kind): kind is 'text' | 'image' | 'speech' =>
          kind === 'text' || kind === 'image' || kind === 'speech'
      )
    const { report, reportPath } = await runModelSmokeTest({
      kinds: requestedKinds?.length ? requestedKinds : undefined,
      // 单项复测不应顺带再花一次音色设计费用。
      includeVoiceDesign: !requestedKinds || runVoiceDesign,
      includeVoiceClone: !requestedKinds || runVoiceClone,
      includeChatNode: runChatNode
    })
    log.info(`model smoke test finished: ${reportPath}`)
    // stdout 只输出路径和汇总，完整报告不含密钥并写入用户数据目录。
    console.log(JSON.stringify({ reportPath, totals: report.totals }))
    app.exit(report.totals.fail > 0 ? 1 : 0)
    return
  }

  // 文件监听器用于外部文件变更；本地 Agent 仅通过主进程服务调用，不直写快照。
  // 窗口创建后赋值给引用，监听器通过 getter 延迟获取。
  let mainWindow: BrowserWindow | null = null
  const projectWatcher = new ProjectFileWatcher(() => mainWindow)

  registerProjectIpc(projectWatcher)
  registerLibraryIpc()
  registerMediaIpc()
  registerWorkspaceStateIpc()
  registerDiagnosticsIpc()
  const modelHost = new SqliteModelHost(database)
  const importedLegacyModels = await bootstrapLegacyProvidersToCatalog(modelHost)
  if (importedLegacyModels.length) {
    log.info(`model catalog: 已同步 ${importedLegacyModels.length} 个旧版模型配置，等待能力验证`)
  }
  registerModelIpc(modelHost, createDesktopModelRuntime(modelHost))
  mainWindow = createWindow()
  // 业务窗就绪后再关授权窗，避免零窗口触发 window-all-closed 退出。
  closeLicenseWindow()

  // 系统恢复后在下一次敏感操作前复验（方案 §3.3）：resume 时完整复验，
  // 失效则停收新任务（业务守卫即刻拒绝）、关闭外部接入，回到授权窗等待重新激活。
  // 发行版无授权体系，不挂 resume 复验。
  if (gate && licenseService && vault) powerMonitor.on('resume', () => {
    void (async () => {
      const snapshot: LicenseSnapshot = await licenseService.evaluateOnBoot('resume')
      vault.clearMemo()
      if (snapshot.state === 'active') return
      log.warn(`license: 系统恢复后授权失效（${snapshot.reasonCode ?? snapshot.state}），转入授权窗`)
      localAccessServer?.close()
      localAccessServer = null
      // 先开授权窗再关业务窗，避免零窗口触发 window-all-closed 退出。
      createLicenseWindow()
      for (const window of BrowserWindow.getAllWindows()) {
        if (window !== getLicenseWindow()) window.close()
      }
      const activated = await waitForLicenseActivation(licenseService)
      if (!activated) {
        app.exit(0)
        return
      }
      mainWindow = createWindow()
      closeLicenseWindow()
    })()
  })

  const keysService = gate && licenseService && vault
    ? new KeyPackageService({
    license: licenseService,
    vault,
    host: modelHost,
    database: () => getDb() as unknown as KeyPackageDatabase,
    trustedRoot: TRUSTED_ROOT,
    signFn: (message) => gate.adapter.sign(message),
    unwrapFn: (wrapped) => gate.adapter.unwrap(wrapped),
    deviceKeys: async () => {
      const keys = await gate.adapter.readPublicKeys()
      return {
        wrapPublicKey: keys.wrapPublicKey,
        signPublicKey: keys.signPublicKey,
        deviceSummary: keys.deviceSummary
      }
    }
  })
  : null
  registerGatewayIpc(mainWindow, keysService ?? undefined)
  // F9 收尾：把**同一个** KeyPackageService 发布给 agent-access（导出/预览侧），
  // 外部入口经 keys-bridge 调用它；不另建实例、不绕开设备绑定与授权门禁。
  if (keysService) publishKeysPackageAccessPort(keysService)
  registerFlowAssetsIpc(() => mainWindow)
  registerFlowCommandsIpc(
    () => mainWindow,
    (desktop) => registerFlowAgentsIpc(() => mainWindow, desktop)
  )

  if (process.argv.includes('--local-agent-access')) {
    try {
      registerLocalAgentTaskReports(() => mainWindow)
      localAccessServer = await startLocalAccessServer({
        dataDirectory: getDataDir(),
        appVersion: app.getVersion(),
        activeProjectId: () => projectWatcher.activeProjectId,
        diagnostics,
        desktop: createAccessDesktop(() => mainWindow),
        settleOrphanedRuns: true
      })
      emitDomainEvent('agent.access.server_ready', '本地外部接入已就绪')
    } catch {
      emitDomainEvent('agent.access.server_failed', '本地外部接入未启动', {
        status: 'failed',
        attributes: { phase: 'startup', code: 'ACCESS_START_FAILED' }
      })
    }
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') shutdownDeadlineAt = null
  else app.quit()
})

// 正常退出：等待日志 flush（≤2s，超时留非完整状态），写 session_ended，再关库退出。
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  localAccessServer?.close()
  localAccessServer = null
  event.preventDefault()
  if (shutdownDeadlineAt === null) {
    shutdownDeadlineAt = Date.now() + DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS
  }
  void (async () => {
    try {
      let upstreamDrainComplete = rendererDiagnosticsComplete
      try {
        const windows = BrowserWindow.getAllWindows()
        const drained = await Promise.all(
          windows.map((window) => drainWindowDiagnostics(window, remainingShutdownTimeMs()))
        )
        upstreamDrainComplete = upstreamDrainComplete && drained.every(Boolean)
      } catch {
        upstreamDrainComplete = false
        log.warn('[diagnostics] renderer shutdown drain failed')
      }
      rendererDiagnosticsComplete = upstreamDrainComplete
      if (diagnostics) {
        diagnostics.emit(mainProducer.build('app.session_ended', undefined, '主进程会话结束', {}))
        await diagnostics.flushOnQuit({
          upstreamDrainComplete,
          timeoutMs: remainingShutdownTimeMs()
        })
      }
    } catch {
      log.warn('[diagnostics] shutdown flush failed')
    } finally {
      try {
        desktopDataOwnership?.release()
      } catch {
        // Retain an unreleasable dead-owner row for conservative startup recovery.
      }
      desktopDataOwnership = null
      closeDb()
      app.quit()
    }
  })()
})
