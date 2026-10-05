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
import { DiagnosticsProducer, newProducerId } from '../shared/observability'
import { registerLibraryIpc } from './ipc/library.ipc'
import { SqliteModelHost } from './model-host/sqlite-model-host'
import { createDesktopModelRuntime } from './model-host/runtime'
import { closeDb, getDataDir, getDb, getProjectsDir } from './store/db'
import { reconcileWorkspace, sweepStaleVideoTempFiles } from './store/workspace-health'
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
const mainProducer = new DiagnosticsProducer({
  process: 'main',
  producerId: newProducerId('main')
})

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
    if (await checkPreviousSession(nodeFsStore(), sessionsDir)) {
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

  // 渲染进程崩溃/被杀：记录可用退出码，异常后仍执行原有窗口策略（不吞异常继续）。
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
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
  // 仅安装传输适配器；请求阶段仍由 gateway/image.ts 的 emitGatewayEvent 统一记录。
  setImageNetworkFetch((input, init) => net.fetch(input instanceof URL ? input.href : input, init))
  electronApp.setAppUserModelId('com.canvas-studio.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 诊断底座先于业务库初始化：app.session_started / 上次非正常结束检查。
  await initDiagnostics()

  const database = getDb()
  // safeStorage 上线前保存的 Key 至今是裸明文；启动时补一次收口，日志只记数量。
  const reEncrypted = upgradeLegacyApiKeys()
  if (reEncrypted) log.info(`providers: ${reEncrypted} 个历史明文 API Key 已重新加密`)
  const health = reconcileWorkspace({
    projectsDir: getProjectsDir(),
    projectIds: (
      database.prepare('SELECT id FROM projects WHERE deleted = 0').all() as Array<{ id: string }>
    ).map((row) => row.id)
  })
  if (
    health.recoveredImports.length ||
    health.orphanedProjectIds.length ||
    health.temporaryFiles.length
  ) {
    log.warn('workspace health check found recoverable items', health)
  }
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

  // 文件监听器：CLI/MCP 写入 project.json 时通知渲染进程实时刷新。
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

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  closeDb()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 正常退出：等待日志 flush（≤2s，超时留非完整状态），写 session_ended，再关库退出。
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void (async () => {
    if (diagnostics) {
      diagnostics.emit(mainProducer.build('app.session_ended', undefined, '主进程会话结束', {}))
      await diagnostics.flushOnQuit()
    }
    closeDb()
    app.quit()
  })()
})
