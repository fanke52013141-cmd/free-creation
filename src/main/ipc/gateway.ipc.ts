// 模型网关 IPC handlers（信封规范见《技术框架与规范》§10）
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/contracts'
import type {
  GatewayEvent,
  IpcEnvelope,
  SaveProviderInput,
  TestProviderResult,
  VideoSubmitResult
} from '../../shared/contracts'
import type { MediaAsset, ProviderConfig, VideoTaskInfo } from '../../shared/types'
import { startChat, cancelChat } from '../gateway/chat'
import { GatewayError, testProvider } from '../gateway/factory'
import { generateImageToAsset } from '../gateway/image'
import { deleteProvider, listProviders, saveProvider } from '../gateway/providers.repo'
import {
  cancelVideoTask,
  getVideoTask,
  resumePendingVideoTasks,
  submitVideoTask
} from '../gateway/video'
import { generateAudioToAsset } from '../gateway/audio'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
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

export function registerGatewayIpc(win: BrowserWindow): void {
  const send = (e: GatewayEvent): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.gateway.event, e)
  }

  ipcMain.handle(IPC.gateway.providers, (): IpcEnvelope<ProviderConfig[]> => ok(listProviders()))

  ipcMain.handle(IPC.gateway.saveProvider, (_e, input: SaveProviderInput) =>
    wrap(() => {
      if (!input?.name?.trim()) throw new GatewayError('INVALID_NAME', '供应商名称不能为空')
      if (!input?.baseURL?.trim()) throw new GatewayError('INVALID_INPUT', 'Base URL 不能为空')
      return saveProvider(input)
    })
  )

  ipcMain.handle(IPC.gateway.deleteProvider, (_e, id: string) =>
    wrap(() => deleteProvider(id ?? ''))
  )

  ipcMain.handle(IPC.gateway.testProvider, (_e, input: SaveProviderInput) =>
    wrapAsync<TestProviderResult>(() => testProvider(input))
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

  ipcMain.handle(IPC.gateway.videoSubmit, (_e, input: Parameters<typeof submitVideoTask>[1]) =>
    wrap<VideoSubmitResult>(() => submitVideoTask(send, input))
  )

  ipcMain.handle(IPC.gateway.videoCancel, (_e, { taskId }: { taskId: string }) =>
    wrap(() => cancelVideoTask(taskId ?? ''))
  )

  ipcMain.handle(IPC.gateway.videoTask, (_e, { taskId }: { taskId: string }) =>
    wrap<VideoTaskInfo | null>(() => getVideoTask(taskId ?? ''))
  )

  ipcMain.handle(
    IPC.gateway.audioGenerate,
    (_e, input: Parameters<typeof generateAudioToAsset>[0]) =>
      wrapAsync<MediaAsset>(() => generateAudioToAsset(input))
  )

  // 启动恢复：重启前仍在途的视频任务继续轮询
  resumePendingVideoTasks(send)
}
