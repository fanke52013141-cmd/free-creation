import { app, shell, BrowserWindow, protocol, Menu, net } from 'electron'
import { setImageNetworkFetch } from './gateway/image'
import { join, extname } from 'path'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import icon from '../../resources/icon.png?asset'
import { registerProjectIpc } from './ipc/project.ipc'
import { startLocalAccessServer, type LocalAccessServer } from './agent-access/server'
import { createAccessDesktop } from './agent-access/desktop'
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
import { bootstrapLegacyProvidersToCatalog, upgradeLegacyApiKeys } from './gateway/providers.repo'
import { getMediaAbsPath } from './store/media.repo'
import { mimeForExtension } from '../shared/mime'
import { runModelSmokeTest } from './model-smoke'

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
  Menu.setApplicationMenu(null)
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.setMenu(null)

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

app.whenReady().then(async () => {
  // A single desktop owner per data store protects unsaved renderers even without local access.
  try {
    desktopDataOwnership = acquireProcessLock('desktop-data-owner')
  } catch {
    app.exit(1)
    return
  }
  // 仅安装传输适配器；请求阶段仍由 gateway/image.ts 的 emitGatewayEvent 统一记录。
  setImageNetworkFetch((input, init) => net.fetch(input instanceof URL ? input.href : input, init))
  electronApp.setAppUserModelId('com.canvas-studio.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 数据目录锁准入后，先启用诊断，再执行业务：session_started / 上次非正常结束检查。
  await initDiagnostics()

  const database = getDb()
  // safeStorage 上线前保存的 Key 至今是裸明文；启动时补一次收口，日志只记数量。
  const reEncrypted = upgradeLegacyApiKeys()
  if (reEncrypted) log.info(`providers: ${reEncrypted} 个历史明文 API Key 已重新加密`)
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
  const importedLegacyModels = bootstrapLegacyProvidersToCatalog(modelHost)
  if (importedLegacyModels.length) {
    log.info(`model catalog: 已同步 ${importedLegacyModels.length} 个旧版模型配置，等待能力验证`)
  }
  registerModelIpc(modelHost, createDesktopModelRuntime(modelHost))
  mainWindow = createWindow()
  registerGatewayIpc(mainWindow)
  registerFlowAssetsIpc(() => mainWindow)
  registerFlowCommandsIpc(
    () => mainWindow,
    (desktop) => registerFlowAgentsIpc(() => mainWindow, desktop)
  )

  if (process.argv.includes('--local-agent-access')) {
    try {
      localAccessServer = await startLocalAccessServer({
        dataDirectory: getDataDir(),
        appVersion: app.getVersion(),
        activeProjectId: () => projectWatcher.activeProjectId,
        desktop: createAccessDesktop(() => mainWindow)
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
