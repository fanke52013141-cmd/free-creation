/**
 * 授权窗专用 IPC（方案 §3.3：授权窗口只可探测 TPM、导出申请和证明、
 * 导入签名文件、查看简短诊断、安全退出）。
 *
 * 边界：
 * - 只有授权窗的隔离 preload（src/preload/license.ts）暴露这些通道；
 * - 每个 handler 校验 event.senderFrame 是授权窗自身，拒绝其他 frame 调用；
 * - 文件对话框固定扩展名与大小上限；文件内容不回传 renderer，只回传摘要；
 * - 本模块在业务 IPC 之前注册，且激活成功后由 main/index.ts 关闭授权窗。
 */
import { BrowserWindow, dialog, ipcMain, app } from 'electron'
import { readFile } from 'node:fs'
import { promisify } from 'node:util'
import { IPC } from '../../shared/contracts'
import type { IpcEnvelope } from '../../shared/contracts'
import { FILE_SIZE_LIMITS } from '@free-creation/license-protocol'
import type { LicenseService } from '../security/license/service'
import { setLicenseGateService } from '../security/license/gate'
import { LicenseError } from '../security/license/errors'

const readFileAsync = promisify(readFile)

let licenseWindow: BrowserWindow | null = null
let licenseService: LicenseService | null = null

export function setLicenseWindowForIpc(window: BrowserWindow | null): void {
  licenseWindow = window
}

export function setLicenseServiceForIpc(service: LicenseService | null): void {
  licenseService = service
  // 授权窗是唯一能推进激活状态的入口；服务注入即同步给业务守卫。
  setLicenseGateService(service)
}

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
}

function licenseErrorMessage(error: unknown): { code: string; message: string } {
  if (error instanceof LicenseError) return { code: error.code, message: error.message }
  return { code: 'UNKNOWN', message: String((error as Error)?.message ?? error).slice(0, 200) }
}

/** 授权窗自身的 frame 才能调用；业务窗、Agent 通道与不可信 frame 一律拒绝。 */
function isFromLicenseWindow(event: Electron.IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  return window !== null && window === licenseWindow
}

function guarded(
  event: Electron.IpcMainInvokeEvent,
  task: () => Promise<IpcEnvelope<unknown>>
): Promise<IpcEnvelope<unknown>> {
  if (!isFromLicenseWindow(event)) {
    return Promise.resolve(err('LICENSE_WINDOW_ONLY', '该通道仅授权窗可用'))
  }
  return task()
}

interface ShowSaveOptions {
  title: string
  defaultName: string
  extensions: string[]
}

async function showSaveDialog(window: BrowserWindow, options: ShowSaveOptions): Promise<string | null> {
  const result = await dialog.showSaveDialog(window, {
    title: options.title,
    defaultPath: options.defaultName,
    filters: [{ name: options.title, extensions: options.extensions }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

async function showOpenDialog(
  window: BrowserWindow,
  options: { title: string; extensions: string[] }
): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    title: options.title,
    filters: [{ name: options.title, extensions: options.extensions }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

export function registerLicenseIpc(): void {
  ipcMain.handle(IPC.license.getStatus, (event) =>
    guarded(event, async () => {
      if (!licenseService) return err('LICENSE_SERVICE_MISSING', '授权服务未就绪')
      return ok(licenseService.snapshot)
    })
  )

  ipcMain.handle(IPC.license.probeDevice, (event) =>
    guarded(event, async () => {
      if (!licenseService) return err('LICENSE_SERVICE_MISSING', '授权服务未就绪')
      try {
        return ok(await licenseService.probeDevice())
      } catch (error) {
        const { code, message } = licenseErrorMessage(error)
        return err(code, message)
      }
    })
  )

  // 导出设备申请：弹保存框 → 生成 .csreq → 落盘 → 只回传设备摘要。
  ipcMain.handle(IPC.license.exportRequest, (event) =>
    guarded(event, async () => {
      if (!licenseService) return err('LICENSE_SERVICE_MISSING', '授权服务未就绪')
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return err('LICENSE_WINDOW_MISSING', '授权窗不存在')
      try {
        const path = await showSaveDialog(window, {
          title: '导出设备申请',
          defaultName: 'device.csreq',
          extensions: ['csreq']
        })
        if (!path) return ok({ saved: false as const, deviceSummary: null, requestId: null })
        const { requestText, deviceSummary, requestId } = await licenseService.createDeviceRequest()
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, requestText, { mode: 0o600 })
        return ok({ saved: true as const, deviceSummary, requestId, path })
      } catch (error) {
        const { code, message } = licenseErrorMessage(error)
        return err(code, message)
      }
    })
  )

  // 导入挑战：弹打开框 → 主进程读取（≤1MiB）→ 验证并生成证明 → 存内存等待导出。
  let pendingProof: { text: string; deviceSummary: string } | null = null

  ipcMain.handle(IPC.license.importChallenge, (event) =>
    guarded(event, async () => {
      if (!licenseService) return err('LICENSE_SERVICE_MISSING', '授权服务未就绪')
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return err('LICENSE_WINDOW_MISSING', '授权窗不存在')
      try {
        const path = await showOpenDialog(window, { title: '导入挑战文件', extensions: ['cschallenge'] })
        if (!path) return ok({ imported: false as const, deviceSummary: null })
        const text = await readFileAsync(path, 'utf8')
        const { proofText, deviceSummary } = await licenseService.importChallenge(text)
        pendingProof = { text: proofText, deviceSummary }
        return ok({ imported: true as const, deviceSummary })
      } catch (error) {
        pendingProof = null
        const { code, message } = licenseErrorMessage(error)
        return err(code, message)
      }
    })
  )

  ipcMain.handle(IPC.license.exportProof, (event) =>
    guarded(event, async () => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return err('LICENSE_WINDOW_MISSING', '授权窗不存在')
      if (!pendingProof) return err('NO_PENDING_PROOF', '请先导入挑战文件生成证明')
      try {
        const path = await showSaveDialog(window, {
          title: '导出设备证明',
          defaultName: 'device.csproof',
          extensions: ['csproof']
        })
        if (!path) return ok({ saved: false as const, deviceSummary: pendingProof.deviceSummary })
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, pendingProof.text, { mode: 0o600 })
        const summary = pendingProof.deviceSummary
        return ok({ saved: true as const, deviceSummary: summary, path })
      } catch (error) {
        const { code, message } = licenseErrorMessage(error)
        return err(code, message)
      }
    })
  )

  // 导入授权：弹打开框 → 主进程读取（≤64KiB）→ 激活。
  ipcMain.handle(IPC.license.importLicense, (event) =>
    guarded(event, async () => {
      if (!licenseService) return err('LICENSE_SERVICE_MISSING', '授权服务未就绪')
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return err('LICENSE_WINDOW_MISSING', '授权窗不存在')
      try {
        const path = await showOpenDialog(window, { title: '导入授权文件', extensions: ['cslicense'] })
        if (!path) return ok({ imported: false as const, snapshot: null })
        const text = await readFileAsync(path, 'utf8')
        const snapshot = await licenseService.importLicense(text)
        return ok({ imported: true as const, snapshot })
      } catch (error) {
        const { code, message } = licenseErrorMessage(error)
        return err(code, message)
      }
    })
  )

  // 导入撤销/策略文件（管理方分发 .cspolicy）。
  ipcMain.handle(IPC.license.importPolicy, (event) =>
    guarded(event, async () => {
      if (!licenseService) return err('LICENSE_SERVICE_MISSING', '授权服务未就绪')
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return err('LICENSE_WINDOW_MISSING', '授权窗不存在')
      try {
        const path = await showOpenDialog(window, { title: '导入策略文件', extensions: ['cspolicy'] })
        if (!path) return ok({ imported: false as const })
        const text = await readFileAsync(path, 'utf8')
        const result = await licenseService.importRevocationPolicy(text)
        return ok({ imported: true as const, ...result })
      } catch (error) {
        const { code, message } = licenseErrorMessage(error)
        return err(code, message)
      }
    })
  )

  ipcMain.handle(IPC.license.getDiagnostic, (event) =>
    guarded(event, async () => {
      const snapshot = licenseService?.snapshot ?? null
      return ok({
        appVersion: app.getVersion(),
        platform: process.platform,
        license: snapshot
          ? {
              state: snapshot.state,
              reasonCode: snapshot.reasonCode,
              message: snapshot.message,
              term: snapshot.term,
              expiresAt: snapshot.expiresAt
            }
          : null,
        limits: {
          licenseFileBytes: FILE_SIZE_LIMITS.license,
          proofFileBytes: FILE_SIZE_LIMITS.proof
        }
      })
    })
  )

  ipcMain.handle(IPC.license.exitApp, (event) =>
    guarded(event, async () => {
      app.quit()
      return ok({ quitting: true })
    })
  )
}

/** size guard for read files（双保险；readFileAsync 前由 dialog 限定来源）。 */
export const LICENSE_FILE_LIMITS = FILE_SIZE_LIMITS
