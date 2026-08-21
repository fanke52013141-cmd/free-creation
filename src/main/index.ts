import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import icon from '../../resources/icon.png?asset'
import { registerProjectIpc } from './ipc/project.ipc'
import { registerMediaIpc } from './ipc/media.ipc'
import { registerGatewayIpc } from './ipc/gateway.ipc'
import { getDb } from './store/db'
import { getMediaAbsPath } from './store/media.repo'

log.initialize()
log.info('main process starting')

// media:// 协议：渲染进程加载本地媒体（stream 支持 <video> 播放）
protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { stream: true } }])

function registerMediaProtocol(): void {
  protocol.handle('media', (request) => {
    const url = new URL(request.url)
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = getMediaAbsPath(relPath)
    if (!abs) {
      return new Response(null, { status: 403 })
    }
    return net.fetch(pathToFileURL(abs).toString())
  })
}

function createWindow(): BrowserWindow {
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.canvas-studio.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  getDb()
  registerMediaProtocol()
  registerProjectIpc()
  registerMediaIpc()
  const win = createWindow()
  registerGatewayIpc(win)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
