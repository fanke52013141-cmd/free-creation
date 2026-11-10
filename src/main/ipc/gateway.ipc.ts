// 模型网关 IPC handlers（信封规范见《技术框架与规范》§10）
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/contracts'
import type {
  DreaminaLoginCheckResult,
  DreaminaLoginMaterial,
  GatewayEvent,
  IpcEnvelope,
  ProbeProviderInput,
  ProbeProviderResult,
  SaveProviderInput,
  TestProviderResult,
  VideoSubmitResult
} from '../../shared/contracts'
import type { MediaAsset, ProviderSummary, VideoTaskInfo } from '../../shared/types'
import { driverForSpec } from '../../shared/provider-driver'
import { startChat, cancelChat } from '../gateway/chat'
import { GatewayError, testProvider } from '../gateway/factory'
import { draftToConfig, freeConnectionMessage, probeProvider } from '../gateway/provider-check'
import { checkDreaminaLogin, logoutDreamina, startDreaminaLogin } from '../gateway/dreamina-cli'
import { generateImageToAsset } from '../gateway/image'
import { transformImageEdit } from '../media/image-edit'
import {
  deleteProvider,
  listProviders,
  listVerifiedProviders,
  saveProvider
} from '../gateway/providers.repo'
import { exportProviders, importProviders } from '../gateway/provider-transfer'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { newTraceId, newSpanId } from '../../shared/observability'
import {
  cancelVideoTask,
  getVideoTask,
  controlVideoTask,
  resumePendingVideoTasks,
  submitVideoTask
} from '../gateway/video'
import { generateAudioToAsset, generateSpeechToAsset } from '../gateway/audio'
import { designMiniMaxVoice } from '../gateway/voice'

async function readPackageViaDialog(win: BrowserWindow): Promise<string | null> {
  const opened = await dialog.showOpenDialog(win, {
    title: '选择密钥包文件',
    filters: [{ name: '密钥包', extensions: ['cskeys'] }],
    properties: ['openFile']
  })
  if (opened.canceled || !opened.filePaths[0]) return null
  const { readFile } = await import('node:fs/promises')
  return readFile(opened.filePaths[0], 'utf8')
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return 'UNKNOWN'
}

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
}

/** 错误 → 稳定原因码信封（GatewayError 保留码；其余归一 GATEWAY_ERROR）。 */
function errOf(error: unknown): IpcEnvelope<never> {
  const message = String((error as Error)?.message ?? error).slice(0, 300)
  if (error instanceof GatewayError) return err(error.code, message)
  return err('GATEWAY_ERROR', message)
}

function wrap<T>(fn: () => T): IpcEnvelope<T> {
  try {
    return ok(fn())
  } catch (e) {
    if (e instanceof GatewayError) return err(e.code, e.message)
    return err('GATEWAY_ERROR', e instanceof Error ? e.message : String(e))
  }
}

async function wrapAsync<T>(fn: () => Promise<T>): Promise<IpcEnvelope<T>> {
  try {
    return ok(await fn())
  } catch (e) {
    if (e instanceof GatewayError) return err(e.code, e.message)
    return err('GATEWAY_ERROR', e instanceof Error ? e.message : String(e))
  }
}

/** P2 密钥包服务（index.ts 在模型宿主就绪后构造并注入）。 */
export interface GatewayKeysService {
  exportReceiveCredential(): Promise<{ credentialText: string; deviceSummary: string; expiresAt: number | null }>
  listExportableConnections(): Promise<Array<{ id: string; name: string; protocol: string; baseUrl: string; modelCount: number; hasKey: boolean }>>
  sealKeyPackageForRecipient(input: { password: string; recipientCredentialText: string; connectionIds: string[] }): Promise<{ packageText: string; packageId: string; expiresAt: number; connectionCount: number }>
  openKeyPackagePreview(input: { packageText: string; password: string }): Promise<{ packageId: string; expiresAt: number; issuerDeviceSummary: string; connections: Array<{ id: string; name: string; protocol: string; baseUrl: string; modelCount: number; hasKey: boolean }>; alreadyImported: boolean; existingConnections: string[] }>
  applyKeyPackageImport(input: { packageText: string; password: string; overwriteConfirmed: boolean }): Promise<{ packageId: string; added: number; updated: number; modelCount: number }>
}

export function registerGatewayIpc(win: BrowserWindow, keysService?: GatewayKeysService): void {
  const send = (e: GatewayEvent): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.gateway.event, e)
  }

  ipcMain.handle(IPC.gateway.providers, async (): Promise<IpcEnvelope<ProviderSummary[]>> => ok(await listProviders()))
  ipcMain.handle(IPC.gateway.executableProviders, async (): Promise<IpcEnvelope<ProviderSummary[]>> =>
    ok(await listVerifiedProviders())
  )

  // ── P2 密钥包（.cskeys v2）──────────────────────────────────────────
  // 全程不向 renderer 返回明文 Key；诊断事件只含连接数/包 ID/阶段与原因码。
  ipcMain.handle(IPC.gateway.keys.exportCredential, async () => {
    if (!keysService) return err('KEYS_SERVICE_MISSING', '密钥包服务未就绪')
    const traceId = newTraceId()
    const startedAt = Date.now()
    try {
      const result = await keysService.exportReceiveCredential()
      const save = await dialog.showSaveDialog(win, {
        title: '导出接收设备凭证',
        defaultPath: 'device.csdevcred',
        filters: [{ name: '接收设备凭证', extensions: ['csdevcred'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      })
      if (save.canceled || !save.filePath) {
        emitGatewayEvent('keys.credential.completed', '接收设备凭证导出', { traceId }, { status: 'cancelled', attributes: { component: 'keys' } })
        return err('CANCELLED', '已取消')
      }
      const { writeFile } = await import('node:fs/promises')
      await writeFile(save.filePath, result.credentialText, { mode: 0o600 })
      emitGatewayEvent('keys.credential.completed', '接收设备凭证导出', { traceId }, {
        status: 'success',
        durationMs: Date.now() - startedAt,
        attributes: { component: 'keys', deviceSummary: result.deviceSummary }
      })
      return ok({ path: save.filePath, deviceSummary: result.deviceSummary, expiresAt: result.expiresAt })
    } catch (error) {
      emitGatewayEvent('keys.credential.completed', '接收设备凭证导出', { traceId }, {
        status: 'failed',
        level: 'warn',
        durationMs: Date.now() - startedAt,
        attributes: { component: 'keys', code: errorCodeOf(error) }
      })
      return errOf(error)
    }
  })

  ipcMain.handle(IPC.gateway.keys.listConnections, async () => {
    if (!keysService) return err('KEYS_SERVICE_MISSING', '密钥包服务未就绪')
    try {
      return ok(await keysService.listExportableConnections())
    } catch (error) {
      return errOf(error)
    }
  })

  ipcMain.handle(IPC.gateway.keys.sealPackage, async (_event, input: { password?: string; connectionIds?: string[] }) => {
    if (!keysService) return err('KEYS_SERVICE_MISSING', '密钥包服务未就绪')
    const traceId = newTraceId()
    const startedAt = Date.now()
    let phase = 'validation'
    try {
      if (typeof input?.password !== 'string' || !Array.isArray(input.connectionIds) || input.connectionIds.length === 0) {
        throw new GatewayError('INVALID_INPUT', '请设置密码并选择要发放的连接')
      }
      phase = 'destination'
      const opened = await dialog.showOpenDialog(win, {
        title: '选择接收设备凭证',
        filters: [{ name: '接收设备凭证', extensions: ['csdevcred'] }],
        properties: ['openFile']
      })
      if (opened.canceled || !opened.filePaths[0]) {
        emitGatewayEvent('keys.package.completed', '密钥包发放', { traceId }, { status: 'cancelled', attributes: { component: 'keys', phase: 'destination' } })
        return err('CANCELLED', '已取消')
      }
      const { readFile } = await import('node:fs/promises')
      const recipientCredentialText = await readFile(opened.filePaths[0], 'utf8')
      phase = 'write'
      const sealed = await keysService.sealKeyPackageForRecipient({
        password: input.password,
        recipientCredentialText,
        connectionIds: input.connectionIds
      })
      const save = await dialog.showSaveDialog(win, {
        title: '导出密钥包',
        defaultPath: 'device-keys.cskeys',
        filters: [{ name: '密钥包', extensions: ['cskeys'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      })
      if (save.canceled || !save.filePath) {
        emitGatewayEvent('keys.package.completed', '密钥包发放', { traceId }, { status: 'cancelled', attributes: { component: 'keys', phase: 'destination' } })
        return err('CANCELLED', '已取消')
      }
      const { writeFile } = await import('node:fs/promises')
      await writeFile(save.filePath, sealed.packageText, { mode: 0o600 })
      emitGatewayEvent('keys.package.completed', '密钥包发放', { traceId }, {
        status: 'success',
        durationMs: Date.now() - startedAt,
        attributes: { component: 'keys', packageId: sealed.packageId, connectionCount: sealed.connectionCount, expiresAt: sealed.expiresAt }
      })
      return ok({ path: save.filePath, packageId: sealed.packageId, connectionCount: sealed.connectionCount, expiresAt: sealed.expiresAt })
    } catch (error) {
      emitGatewayEvent('keys.package.completed', '密钥包发放', { traceId }, {
        status: 'failed',
        level: 'warn',
        durationMs: Date.now() - startedAt,
        attributes: { component: 'keys', phase, code: errorCodeOf(error) }
      })
      return errOf(error)
    }
  })

  ipcMain.handle(IPC.gateway.keys.previewPackage, async (_event, input: { password?: string }) => {
    if (!keysService) return err('KEYS_SERVICE_MISSING', '密钥包服务未就绪')
    try {
      if (typeof input?.password !== 'string') throw new GatewayError('INVALID_INPUT', '请输入解封密码')
      const packageText = await readPackageViaDialog(win)
      if (packageText === null) return err('CANCELLED', '已取消')
      return ok(await keysService.openKeyPackagePreview({ packageText, password: input.password }))
    } catch (error) {
      return errOf(error)
    }
  })

  ipcMain.handle(IPC.gateway.keys.importPackage, async (_event, input: { password?: string; overwriteConfirmed?: boolean }) => {
    if (!keysService) return err('KEYS_SERVICE_MISSING', '密钥包服务未就绪')
    const traceId = newTraceId()
    const startedAt = Date.now()
    try {
      if (typeof input?.password !== 'string') throw new GatewayError('INVALID_INPUT', '请输入解封密码')
      const packageText = await readPackageViaDialog(win)
      if (packageText === null) return err('CANCELLED', '已取消')
      const result = await keysService.applyKeyPackageImport({
        packageText,
        password: input.password,
        overwriteConfirmed: input.overwriteConfirmed === true
      })
      emitGatewayEvent('keys.package.completed', '密钥包导入', { traceId }, {
        status: 'success',
        durationMs: Date.now() - startedAt,
        attributes: { component: 'keys', packageId: result.packageId, added: result.added, updated: result.updated, modelCount: result.modelCount }
      })
      return ok(result)
    } catch (error) {
      emitGatewayEvent('keys.package.completed', '密钥包导入', { traceId }, {
        status: 'failed',
        level: 'warn',
        durationMs: Date.now() - startedAt,
        attributes: { component: 'keys', code: errorCodeOf(error) }
      })
      return errOf(error)
    }
  })

  ipcMain.handle(
    IPC.gateway.exportProviders,
    async (
      _e,
      input: { password: string; providerIds: string[] }
    ): Promise<IpcEnvelope<{ path: string; count: number }>> => {
      const diagnostics = { traceId: newTraceId(), spanId: newSpanId() }
      emitGatewayEvent('provider.export.started', '开始导出供应商配置', diagnostics, {
        phase: 'validation'
      })
      if (typeof input?.password !== 'string' || input.password.length < 8) {
        emitGatewayEvent('provider.export.failed', '供应商导出校验失败', diagnostics, {
          phase: 'validation',
          attributes: { code: 'INVALID_PASSWORD' }
        })
        return err('INVALID_INPUT', '加密密码至少需要 8 个字符')
      }
      if (
        !Array.isArray(input.providerIds) ||
        input.providerIds.length === 0 ||
        input.providerIds.length > 500 ||
        input.providerIds.some((id) => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) ||
        new Set(input.providerIds).size !== input.providerIds.length
      ) {
        emitGatewayEvent('provider.export.failed', '供应商导出校验失败', diagnostics, {
          phase: 'validation',
          attributes: { code: 'INVALID_SELECTION' }
        })
        return err('INVALID_INPUT', '请选择需要导出的供应商')
      }
      try {
        const result = await dialog.showSaveDialog(win, {
          title: '导出加密的供应商配置',
          defaultPath: 'Canvas Studio 供应商配置.canvasproviders',
          filters: [{ name: 'Canvas Studio 供应商配置（已加密）', extensions: ['canvasproviders'] }]
        })
        if (result.canceled || !result.filePath) {
          emitGatewayEvent('provider.export.cancelled', '已取消供应商导出', diagnostics, {
            phase: 'destination'
          })
          return err('CANCELLED', '已取消导出')
        }
        const output = {
          path: result.filePath,
          count: await exportProviders(result.filePath, input.password, input.providerIds)
        }
        emitGatewayEvent('provider.export.completed', '供应商导出完成', diagnostics, {
          phase: 'write',
          attributes: { count: output.count }
        })
        return ok(output)
      } catch (error) {
        emitGatewayEvent('provider.export.failed', '供应商导出失败', diagnostics, {
          phase: 'export',
          attributes: { code: 'EXPORT_FAILED' }
        })
        // 业务校验类错误（选择无效/密钥不可读等）带原因返回，便于界面直接提示。
        const message = String((error as Error)?.message ?? '')
        const business = message && !/ENOENT|EACCES|EPERM/.test(message)
        return err('EXPORT_FAILED', business ? message.slice(0, 300) : '导出失败，请检查所选供应商密钥和目标位置后重试')
      }
    }
  )

  ipcMain.handle(
    IPC.gateway.importProviders,
    async (
      _e,
      input: { password: string }
    ): Promise<IpcEnvelope<{ added: number; updated: number; count: number }>> => {
      if (typeof input?.password !== 'string' || input.password.length < 8) {
        return err('INVALID_INPUT', '密码至少需要 8 个字符')
      }
      const result = await dialog.showOpenDialog(win, {
        title: '导入供应商配置',
        properties: ['openFile'],
        filters: [{ name: 'Canvas Studio 供应商配置（已加密）', extensions: ['canvasproviders'] }]
      })
      if (result.canceled || result.filePaths.length === 0) return err('CANCELLED', '已取消导入')
      return wrapAsync(() => importProviders(result.filePaths[0], input.password))
    }
  )

  ipcMain.handle(IPC.gateway.saveProvider, (_e, input: SaveProviderInput) =>
    wrapAsync(() => {
      if (!input?.name?.trim()) throw new GatewayError('INVALID_NAME', '供应商名称不能为空')
      // 本机 CLI 通道（即梦）没有 Base URL 与 API Key，凭据是本机登录态。
      const localCli = driverForSpec(input.specId) === 'local-cli'
      if (!localCli && !input?.baseURL?.trim())
        throw new GatewayError('INVALID_INPUT', 'Base URL 不能为空')
      if (!localCli && !input.id && !input.apiKey?.trim()) {
        throw new GatewayError('PROVIDER_NO_KEY', '新建供应商必须填写 API Key')
      }
      return saveProvider(input)
    })
  )

  ipcMain.handle(IPC.gateway.deleteProvider, (_e, id: string) =>
    wrapAsync(() => deleteProvider(id ?? ''))
  )

  // openai-compatible 走 /models；原生协议没有 /models，改用只读的协议探测，
  // 这样「测试」按钮对视频/语音供应商也能给出一句可行动的结论，而不是「首次生成时验证」。
  ipcMain.handle(IPC.gateway.testProvider, (_e, input: SaveProviderInput) =>
    wrapAsync<TestProviderResult>(async () => {
      if (driverForSpec(input.specId) === 'openai-compatible') return testProvider(input)
      return { models: [], message: await freeConnectionMessage(await draftToConfig(input)) }
    })
  )

  // 协议自检：默认只做请求构造 + 零计费只读探测；带 runItemId 且 allowCost 才真实提交。
  ipcMain.handle(IPC.gateway.probeProvider, (_e, input: ProbeProviderInput) =>
    wrapAsync<ProbeProviderResult>(() => probeProvider(input))
  )

  // 即梦本机 CLI 的 OAuth 设备流：发起后直接把浏览器打开，用户在网页上授权，
  // 面板再按自己的节奏轮询 checklogin——主进程不阻塞等待，也不接触任何 token。
  ipcMain.handle(IPC.gateway.dreaminaLogout, () => wrapAsync(async () => {
    const diagnostics = { traceId: newTraceId(), spanId: newSpanId() }
    emitGatewayEvent('dreamina.logout.started', '开始退出即梦', diagnostics)
    try {
      const result = await logoutDreamina()
      emitGatewayEvent('dreamina.logout.completed', '即梦已退出', diagnostics, { status: 'success' })
      return result
    } catch (error) {
      emitGatewayEvent('dreamina.logout.failed', '即梦退出失败', diagnostics, { status: 'failed', phase: 'local-cli' })
      throw error
    }
  }))

  ipcMain.handle(IPC.gateway.dreaminaLoginStart, () =>
    wrapAsync<DreaminaLoginMaterial>(async () => {
      const material = await startDreaminaLogin()
      if (material.status === 'pending' && material.verificationUri)
        void shell.openExternal(material.verificationUri)
      return material
    })
  )

  ipcMain.handle(IPC.gateway.dreaminaLoginCheck, (_e, deviceCode: string) =>
    wrapAsync<DreaminaLoginCheckResult>(() => checkDreaminaLogin(deviceCode ?? ''))
  )

  ipcMain.handle(IPC.gateway.chatStart, (_e, input: Parameters<typeof startChat>[1]) =>
    wrap(() => ({ taskId: startChat(send, input) }))
  )

  ipcMain.handle(IPC.gateway.chatCancel, (_e, { taskId }: { taskId: string }) =>
    wrap(() => cancelChat(taskId ?? ''))
  )

  ipcMain.handle(
    IPC.gateway.imageGenerate,
    (_e, input: Parameters<typeof generateImageToAsset>[0]) =>
      wrapAsync<MediaAsset>(() => generateImageToAsset(input))
  )

  ipcMain.handle(IPC.gateway.imageEdit, (_e, input: Parameters<typeof transformImageEdit>[0]) =>
    wrapAsync<MediaAsset>(() => transformImageEdit(input))
  )

  ipcMain.handle(IPC.gateway.videoSubmit, (_e, input: Parameters<typeof submitVideoTask>[1]) =>
    wrapAsync<VideoSubmitResult>(() => submitVideoTask(send, input))
  )

  ipcMain.handle(
    IPC.gateway.videoCancel,
    (_e, { taskId, traceId }: { taskId: string; traceId?: string }) =>
      wrapAsync(() => cancelVideoTask(taskId ?? '', traceId))
  )

  ipcMain.handle(
    IPC.gateway.videoTask,
    (_e, { taskId, traceId }: { taskId: string; traceId?: string }) =>
      wrapAsync<VideoTaskInfo | null>(() =>
        getVideoTask(taskId ?? '')?.status === 'unknown'
          ? controlVideoTask(taskId ?? '', false, traceId)
          : Promise.resolve(getVideoTask(taskId ?? ''))
      )
  )

  ipcMain.handle(
    IPC.gateway.audioGenerate,
    (_e, input: Parameters<typeof generateAudioToAsset>[0]) =>
      wrapAsync<MediaAsset>(() => generateAudioToAsset(input))
  )

  // 配音节点：协议由 config.backend 决定（MiniMax 异步 / 火山语音合成 1.0）。
  ipcMain.handle(
    IPC.gateway.speechGenerate,
    (_e, input: Parameters<typeof generateSpeechToAsset>[0]) =>
      wrapAsync(() => generateSpeechToAsset(input))
  )

  // 音色设计节点：返回试听音频资产与可复用的 voice_id。
  ipcMain.handle(IPC.gateway.voiceDesign, (_e, input: Parameters<typeof designMiniMaxVoice>[0]) =>
    wrapAsync(() => designMiniMaxVoice(input))
  )

  // 启动恢复：重启前仍在途的视频任务继续轮询
  resumePendingVideoTasks(send)
}
