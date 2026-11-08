/**
 * 授权窗生命周期（方案 §3.3：状态未 active 时唯一可用窗口）。
 *
 * - 独立页面（license.html）+ 隔离 preload（license.js）；
 * - sandbox 开启、contextIsolation 开启、nodeIntegration 关闭；
 * - 无菜单、不可导航（拒绝任何 window.open 与跨页导航）；
 * - 激活成功后由调用方关闭并进入业务启动路径。
 */
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { setLicenseWindowForIpc } from '../../ipc/license.ipc'

let licenseWindowRef: BrowserWindow | null = null

export function getLicenseWindow(): BrowserWindow | null {
  return licenseWindowRef
}

export function createLicenseWindow(): BrowserWindow {
  if (licenseWindowRef && !licenseWindowRef.isDestroyed()) {
    licenseWindowRef.focus()
    return licenseWindowRef
  }
  const window = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 620,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Canvas Studio 授权',
    webPreferences: {
      preload: join(__dirname, '../preload/license.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  window.setMenu(null)
  window.on('ready-to-show', () => window.show())
  // 授权窗不允许派生任何新窗口或外部导航。
  window.webContents.setWindowOpenHandler((details) => {
    const url = details.url
    if (url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  window.on('closed', () => {
    if (licenseWindowRef === window) {
      licenseWindowRef = null
      setLicenseWindowForIpc(null)
    }
  })

  licenseWindowRef = window
  setLicenseWindowForIpc(window)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/license.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/license.html'))
  }
  return window
}

export function closeLicenseWindow(): void {
  if (licenseWindowRef && !licenseWindowRef.isDestroyed()) {
    licenseWindowRef.close()
  }
  licenseWindowRef = null
}
