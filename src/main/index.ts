import { app, shell, BrowserWindow, protocol } from 'electron'
import { join, extname } from 'path'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import icon from '../../resources/icon.png?asset'
import { registerProjectIpc } from './ipc/project.ipc'
import { registerMediaIpc } from './ipc/media.ipc'
import { registerGatewayIpc } from './ipc/gateway.ipc'
import { closeDb, getDb } from './store/db'
import { getMediaAbsPath } from './store/media.repo'

log.initialize()
log.info('main process starting')

// media:// 协议：渲染进程加载本地媒体（stream 支持 <video> 播放）
protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { stream: true } }])

// 媒体 MIME 类型查找（与 media.repo.ts MIME_BY_EXT 保持一致）
const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac'
}

function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url)
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = getMediaAbsPath(relPath)
    if (!abs) {
      return new Response(null, { status: 403 })
    }

    const ext = extname(abs).toLowerCase()
    const contentType = MEDIA_MIME[ext] ?? 'application/octet-stream'

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
  closeDb()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDb()
})
