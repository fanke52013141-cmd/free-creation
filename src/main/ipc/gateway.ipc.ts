// 模型网关 IPC handlers（信封规范见《技术框架与规范》§10）
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/contracts'
import type {
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
import { generateImageToAsset } from '../gateway/image'
import { transformImageEdit } from '../media/image-edit'
import { deleteProvider, listProviders, saveProvider } from '../gateway/providers.repo'
import {
  cancelVideoTask,
  getVideoTask,
  resumePendingVideoTasks,
  submitVideoTask
} from '../gateway/video'
import { generateAudioToAsset, generateSpeechToAsset } from '../gateway/audio'
import { designMiniMaxVoice } from '../gateway/voice'

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

  ipcMain.handle(IPC.gateway.providers, (): IpcEnvelope<ProviderSummary[]> => ok(listProviders()))

  ipcMain.handle(IPC.gateway.saveProvider, (_e, input: SaveProviderInput) =>
    wrap(() => {
      if (!input?.name?.trim()) throw new GatewayError('INVALID_NAME', '供应商名称不能为空')
      if (!input?.baseURL?.trim()) throw new GatewayError('INVALID_INPUT', 'Base URL 不能为空')
      if (!input.id && !input.apiKey?.trim()) {
        throw new GatewayError('PROVIDER_NO_KEY', '新建供应商必须填写 API Key')
      }
      return saveProvider(input)
    })
  )

  ipcMain.handle(IPC.gateway.deleteProvider, (_e, id: string) =>
    wrap(() => deleteProvider(id ?? ''))
  )

  // openai-compatible 走 /models；原生协议没有 /models，改用只读的协议探测，
  // 这样「测试」按钮对视频/语音供应商也能给出一句可行动的结论，而不是「首次生成时验证」。
  ipcMain.handle(IPC.gateway.testProvider, (_e, input: SaveProviderInput) =>
    wrapAsync<TestProviderResult>(async () => {
      if (driverForSpec(input.specId) === 'openai-compatible') return testProvider(input)
      return { models: [], message: await freeConnectionMessage(draftToConfig(input)) }
    })
  )

  // 协议自检：默认只做请求构造 + 零计费只读探测；带 runItemId 且 allowCost 才真实提交。
  ipcMain.handle(IPC.gateway.probeProvider, (_e, input: ProbeProviderInput) =>
    wrapAsync<ProbeProviderResult>(() => probeProvider(input))
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

  // 配音节点：协议由 config.backend 决定（MiniMax 异步 / 豆包 / OpenAI 兼容）。
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
