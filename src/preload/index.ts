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
  ImageCropTransformInput,
  VideoFrameTransformInput,
  VideoRangeTransformInput,
  ImportMediaBufferInput,
  RenameProjectInput,
  SaveHistorySnapshotInput,
  SaveProjectInput,
  SaveProviderInput,
  SaveWorkflowTemplateInput,
  TestProviderResult,
  HistorySnapshotRecord,
  WorkflowTemplateRecord,
  VideoSubmitInput,
  VideoSubmitResult,
  AudioGenerateInput
} from '../shared/contracts'
import type {
  MediaAsset,
  MediaImportResult,
  ProjectFile,
  ProjectMeta,
  ProviderSummary,
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
  exportProject: (input: { id: string; name?: string }): Promise<IpcEnvelope<{ path: string }>> =>
    ipcRenderer.invoke(IPC.project.export, input),
  importProject: (): Promise<IpcEnvelope<ProjectMeta>> => ipcRenderer.invoke(IPC.project.import),
  importMedia: (input: {
    projectId: string
    paths: string[]
  }): Promise<IpcEnvelope<MediaImportResult>> => ipcRenderer.invoke(IPC.media.import, input),
  importMediaBuffer: (input: ImportMediaBufferInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.importBuffer, input),
  cropImage: (input: ImageCropTransformInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.imageCrop, input),
  extractVideoFrame: (input: VideoFrameTransformInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.videoFrame, input),
  clipVideo: (input: VideoRangeTransformInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.videoClip, input),
  extractVideoAudio: (input: VideoRangeTransformInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.videoAudio, input),
  pickMedia: (projectId: string): Promise<IpcEnvelope<MediaImportResult>> =>
    ipcRenderer.invoke(IPC.media.pick, projectId),
  listMedia: (projectId: string): Promise<IpcEnvelope<MediaAsset[]>> =>
    ipcRenderer.invoke(IPC.media.list, projectId),
  deleteMedia: (mediaId: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.media.delete, mediaId),
  // 媒体文件操作：资源管理器定位 / 复制绝对路径 / 系统默认程序打开
  revealMedia: (mediaId: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.media.reveal, mediaId),
  copyMediaPath: (mediaId: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.media.copyPath, mediaId),
  openMedia: (mediaId: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.media.open, mediaId),
  // 批量导出：弹出目录选择，将项目所有媒体复制到目标目录
  batchExportMedia: (
    projectId: string
  ): Promise<IpcEnvelope<{ exported: number; failed: number; targetDir: string }>> =>
    ipcRenderer.invoke(IPC.media.batchExport, { projectId }),
  workspace: {
    listTemplates: (): Promise<IpcEnvelope<WorkflowTemplateRecord[]>> =>
      ipcRenderer.invoke(IPC.workspace.listTemplates),
    saveTemplate: (
      input: SaveWorkflowTemplateInput
    ): Promise<IpcEnvelope<WorkflowTemplateRecord>> =>
      ipcRenderer.invoke(IPC.workspace.saveTemplate, input),
    deleteTemplate: (id: string): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.workspace.deleteTemplate, id),
    listSnapshots: (projectId: string): Promise<IpcEnvelope<HistorySnapshotRecord[]>> =>
      ipcRenderer.invoke(IPC.workspace.listSnapshots, projectId),
    saveSnapshot: (input: SaveHistorySnapshotInput): Promise<IpcEnvelope<HistorySnapshotRecord>> =>
      ipcRenderer.invoke(IPC.workspace.saveSnapshot, input),
    deleteSnapshot: (input: { projectId: string; id: string }): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.workspace.deleteSnapshot, input)
  },
  // 拖拽落盘的 File 对象拿真实路径（Electron 32+ 移除了 File.path）
  getDroppedFilePath: (file: File): string => webUtils.getPathForFile(file),
  gateway: {
    listProviders: (): Promise<IpcEnvelope<ProviderSummary[]>> =>
      ipcRenderer.invoke(IPC.gateway.providers),
    saveProvider: (input: SaveProviderInput): Promise<IpcEnvelope<ProviderSummary>> =>
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
    audioGenerate: (input: AudioGenerateInput): Promise<IpcEnvelope<MediaAsset>> =>
      ipcRenderer.invoke(IPC.gateway.audioGenerate, input),
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

// 仅在开发构建暴露 electronAPI（方便调试）。生产构建不暴露，避免一旦渲染层被
// 攻陷（如 Markdown/远程图片触发的漏洞），攻击者通过 electronAPI 拿到比最小
// 必要集更宽的能力。已确认渲染层代码零处使用 window.electron。
const isDev = process.env.NODE_ENV !== 'production'

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
    if (isDev) contextBridge.exposeInMainWorld('electron', electronAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
  if (isDev) {
    // @ts-ignore (define in dts)
    window.electron = electronAPI
  }
}
