import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/contracts'
import type {
  BootstrapInfo,
  ChatStartInput,
  CreateProjectInput,
  GatewayEvent,
  IpcEnvelope,
  ImageGenerateInput,
  RenameProjectInput,
  SaveProjectInput,
  SaveProviderInput,
  TestProviderResult,
  VideoSubmitInput,
  VideoSubmitResult
} from '../shared/contracts'
import type {
  MediaAsset,
  MediaImportResult,
  ProjectFile,
  ProjectMeta,
  ProviderConfig,
  VideoTaskInfo
} from '../shared/types'

const api = {
  bootstrap: (): Promise<IpcEnvelope<BootstrapInfo>> => ipcRenderer.invoke(IPC.app.bootstrap),
  listProjects: (): Promise<IpcEnvelope<ProjectMeta[]>> => ipcRenderer.invoke(IPC.project.list),
  createProject: (input: CreateProjectInput): Promise<IpcEnvelope<ProjectMeta>> =>
    ipcRenderer.invoke(IPC.project.create, input.name),
  renameProject: (input: RenameProjectInput): Promise<IpcEnvelope<ProjectMeta | null>> =>
    ipcRenderer.invoke(IPC.project.rename, input),
  deleteProject: (id: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.project.remove, id),
  openProject: (id: string): Promise<IpcEnvelope<ProjectFile | null>> =>
    ipcRenderer.invoke(IPC.project.open, id),
  saveProject: (input: SaveProjectInput): Promise<IpcEnvelope<{ graphVersion: number } | null>> =>
    ipcRenderer.invoke(IPC.project.save, input),
  saveProjectSync: (input: SaveProjectInput): void => {
    ipcRenderer.sendSync(IPC.project.saveSync, input)
  },
  closeProject: (): Promise<IpcEnvelope<true>> => ipcRenderer.invoke(IPC.project.close),
  importMedia: (input: {
    projectId: string
    paths: string[]
  }): Promise<IpcEnvelope<MediaImportResult>> => ipcRenderer.invoke(IPC.media.import, input),
  pickMedia: (projectId: string): Promise<IpcEnvelope<MediaImportResult>> =>
    ipcRenderer.invoke(IPC.media.pick, projectId),
  listMedia: (projectId: string): Promise<IpcEnvelope<MediaAsset[]>> =>
    ipcRenderer.invoke(IPC.media.list, projectId),
  deleteMedia: (mediaId: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.media.delete, mediaId),
  // 拖拽落盘的 File 对象拿真实路径（Electron 32+ 移除了 File.path）
  getDroppedFilePath: (file: File): string => webUtils.getPathForFile(file),
  gateway: {
    listProviders: (): Promise<IpcEnvelope<ProviderConfig[]>> =>
      ipcRenderer.invoke(IPC.gateway.providers),
    saveProvider: (input: SaveProviderInput): Promise<IpcEnvelope<ProviderConfig>> =>
      ipcRenderer.invoke(IPC.gateway.saveProvider, input),
    deleteProvider: (id: string): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.gateway.deleteProvider, id),
    testProvider: (input: SaveProviderInput): Promise<IpcEnvelope<TestProviderResult>> =>
      ipcRenderer.invoke(IPC.gateway.testProvider, input),
    chatStart: (input: ChatStartInput): Promise<IpcEnvelope<{ taskId: string }>> =>
      ipcRenderer.invoke(IPC.gateway.chatStart, input),
    chatCancel: (taskId: string): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.gateway.chatCancel, { taskId }),
    imageGenerate: (input: ImageGenerateInput): Promise<IpcEnvelope<MediaAsset>> =>
      ipcRenderer.invoke(IPC.gateway.imageGenerate, input),
    videoSubmit: (input: VideoSubmitInput): Promise<IpcEnvelope<VideoSubmitResult>> =>
      ipcRenderer.invoke(IPC.gateway.videoSubmit, input),
    videoCancel: (taskId: string): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.gateway.videoCancel, { taskId }),
    videoTask: (taskId: string): Promise<IpcEnvelope<VideoTaskInfo | null>> =>
      ipcRenderer.invoke(IPC.gateway.videoTask, { taskId }),
    // 网关事件订阅（聊天流式分片 / 视频任务进度），返回取消订阅函数
    onEvent: (cb: (e: GatewayEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: GatewayEvent): void => cb(payload)
      ipcRenderer.on(IPC.gateway.event, listener)
      return () => {
        ipcRenderer.off(IPC.gateway.event, listener)
      }
    }
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
