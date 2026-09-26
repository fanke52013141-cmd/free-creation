import type { LibraryCategory, SaveLibraryCategoryInput } from '../shared/library/blueprint'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/contracts'
import type {
  BootstrapInfo,
  ChatStartInput,
  ComfyuiSettingsInput,
  ComfyuiStatus,
  CloneProjectInput,
  CreateProjectInput,
  ExportCanvasStructureInput,
  GatewayEvent,
  IpcEnvelope,
  CreateLibraryFolderInput,
  CaptureProjectNodesInput,
  LibraryArchiveInput,
  LibraryDetailInput,
  LibraryExportInput,
  LibraryMaterializeInput,
  LibraryMaterializeResult,
  LibrarySearchInput,
  LibrarySearchResult,
  ImageGenerateInput,
  ImageEditInput,
  ImageCropTransformInput,
  ImageSplitTransformInput,
  TtsGenerateInput,
  VoiceCloneResult,
  SpeechGenerateInput,
  SpeechGenerateResult,
  VoiceDesignInput,
  VoiceDesignResult,
  VideoFrameTransformInput,
  VideoProbeInput,
  VideoProbeResult,
  VideoClipTransformInput,
  VideoAudioTransformInput,
  VideoThumbnailsInput,
  VideoThumbnailsResult,
  AudioWaveformInput,
  AudioWaveformResult,
  LocalMediaCapabilities,
  VocalSeparateInput,
  VocalSeparationResult,
  ImportMediaBufferInput,
  RenameProjectInput,
  SaveHistorySnapshotInput,
  SaveProjectInput,
  SaveWorkspaceProfileInput,
  CreateLibraryCollectionInput,
  CreateLibraryResourceInput,
  CaptureProjectMediaInput,
  LibraryBoard,
  LibraryBoardItem,
  LibraryCollection,
  LibraryFolder,
  LibraryResourceDetail,
  PublishLibraryRevisionInput,
  SaveLibraryBoardInput,
  SetLibraryCollectionsInput,
  SaveProviderInput,
  SaveWorkflowTemplateInput,
  ProbeProviderInput,
  ProbeProviderResult,
  TestProviderResult,
  HistorySnapshotRecord,
  ImageGenerationTimingSample,
  PalettePreferences,
  WorkflowTemplateRecord,
  VideoSubmitInput,
  VideoSubmitResult,
  AudioGenerateInput,
  VideoConversionInput,
  VideoEngineStatus
} from '../shared/contracts'
import type {
  SaveModelConnectionInput,
  DeleteModelDefinitionInput,
  SaveModelDefinitionInput,
  SaveModelFeatureBindingInput,
  ResolveModelFeatureInput,
  ResolvedModelFeature,
  ValidateModelDefinitionInput,
  ModelValidationResult
} from '../shared/contracts'
import type { Connection, ModelDefinition } from '@free-creation/model-contracts'
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
    ipcRenderer.invoke(IPC.project.create, input),
  cloneProject: (input: CloneProjectInput): Promise<IpcEnvelope<ProjectMeta>> =>
    ipcRenderer.invoke(IPC.project.clone, input),
  saveWorkspaceProfile: (
    input: SaveWorkspaceProfileInput
  ): Promise<IpcEnvelope<ProjectMeta | null>> =>
    ipcRenderer.invoke(IPC.project.saveWorkspaceProfile, input),
  listLibraryCategories: (): Promise<IpcEnvelope<LibraryCategory[]>> => ipcRenderer.invoke(IPC.library.listCategories),
  saveLibraryCategory: (input: SaveLibraryCategoryInput): Promise<IpcEnvelope<LibraryCategory>> => ipcRenderer.invoke(IPC.library.saveCategory, input),
  discardLibraryMaterialization: (input: { usageId: string; projectId: string }): Promise<IpcEnvelope<boolean>> => ipcRenderer.invoke(IPC.library.discardMaterialization, input),
  searchLibrary: (input: LibrarySearchInput): Promise<IpcEnvelope<LibrarySearchResult>> =>
    ipcRenderer.invoke(IPC.library.search, input),
  getLibraryResource: (input: LibraryDetailInput): Promise<IpcEnvelope<LibraryResourceDetail | null>> =>
    ipcRenderer.invoke(IPC.library.detail, input),
  createLibraryResource: (input: CreateLibraryResourceInput): Promise<IpcEnvelope<LibraryResourceDetail>> =>
    ipcRenderer.invoke(IPC.library.create, input),
  captureLibraryMedia: (input: CaptureProjectMediaInput): Promise<IpcEnvelope<LibraryResourceDetail>> =>
    ipcRenderer.invoke(IPC.library.captureProjectMedia, input),
  captureLibraryNodes: (input: CaptureProjectNodesInput): Promise<IpcEnvelope<LibraryResourceDetail>> =>
    ipcRenderer.invoke(IPC.library.captureProjectNodes, input),
  publishLibraryRevision: (input: PublishLibraryRevisionInput): Promise<IpcEnvelope<LibraryResourceDetail>> =>
    ipcRenderer.invoke(IPC.library.publishRevision, input),
  archiveLibraryResource: (input: LibraryArchiveInput): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.library.archive, input),
  listLibraryCollections: (): Promise<IpcEnvelope<LibraryCollection[]>> =>
    ipcRenderer.invoke(IPC.library.listCollections),
  createLibraryCollection: (input: CreateLibraryCollectionInput): Promise<IpcEnvelope<LibraryCollection>> =>
    ipcRenderer.invoke(IPC.library.createCollection, input),
  setLibraryCollections: (input: SetLibraryCollectionsInput): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.library.setCollections, input),
  listLibraryFolders: (): Promise<IpcEnvelope<LibraryFolder[]>> =>
    ipcRenderer.invoke(IPC.library.listFolders),
  createLibraryFolder: (input: CreateLibraryFolderInput): Promise<IpcEnvelope<LibraryFolder>> =>
    ipcRenderer.invoke(IPC.library.createFolder, input),
  deleteLibraryFolder: (folderId: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.library.deleteFolder, folderId),
  setLibraryResourceFolder: (input: { resourceId: string; folderId?: string | null }): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.library.setResourceFolder, input),
  listLibraryBoards: (): Promise<IpcEnvelope<LibraryBoard[]>> =>
    ipcRenderer.invoke(IPC.library.listBoards),
  createLibraryBoard: (input: { title: string; description?: string }): Promise<IpcEnvelope<LibraryBoard>> =>
    ipcRenderer.invoke(IPC.library.createBoard, input),
  getLibraryBoardItems: (boardId: string): Promise<IpcEnvelope<LibraryBoardItem[]>> =>
    ipcRenderer.invoke(IPC.library.getBoardItems, boardId),
  saveLibraryBoard: (input: SaveLibraryBoardInput): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.library.saveBoard, input),
  materializeLibraryResource: (input: LibraryMaterializeInput): Promise<IpcEnvelope<LibraryMaterializeResult>> =>
    ipcRenderer.invoke(IPC.library.materialize, input),
  exportLibrary: (input: LibraryExportInput = {}): Promise<IpcEnvelope<{ path: string }>> =>
    ipcRenderer.invoke(IPC.library.export, input),
  importLibrary: (): Promise<IpcEnvelope<{ imported: number }>> =>
    ipcRenderer.invoke(IPC.library.import),
  renameProject: (input: RenameProjectInput): Promise<IpcEnvelope<ProjectMeta | null>> =>
    ipcRenderer.invoke(IPC.project.rename, input),
  deleteProject: (id: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.project.remove, id),
  openProject: (id: string): Promise<IpcEnvelope<ProjectFile | null>> =>
    ipcRenderer.invoke(IPC.project.open, id),
  saveProject: (input: SaveProjectInput): Promise<IpcEnvelope<{ graphVersion: number } | null>> =>
    ipcRenderer.invoke(IPC.project.save, input),
  // F03 修复：sendSync 会阻塞渲染进程直到主进程应答，必须把真实结果信封带回给
  // 调用方，否则关窗保存的失败（冲突/写锁/磁盘错误）会被静默吞掉。
  saveProjectSync: (input: SaveProjectInput): IpcEnvelope<{ graphVersion: number } | null> =>
    ipcRenderer.sendSync(IPC.project.saveSync, input),
  closeProject: (): Promise<IpcEnvelope<true>> => ipcRenderer.invoke(IPC.project.close),
  onExternalProjectChange: (
    cb: (payload: { projectId: string; graphVersion: number }) => void
  ): (() => void) => {
    const listener = (_e: unknown, payload: { projectId: string; graphVersion: number }): void =>
      cb(payload)
    ipcRenderer.on(IPC.project.externalChange, listener)
    return () => {
      ipcRenderer.off(IPC.project.externalChange, listener)
    }
  },
  exportProject: (input: { id: string; name?: string }): Promise<IpcEnvelope<{ path: string }>> =>
    ipcRenderer.invoke(IPC.project.export, input),
  importProject: (): Promise<IpcEnvelope<ProjectMeta>> => ipcRenderer.invoke(IPC.project.import),
  exportCanvasStructure: (
    input: ExportCanvasStructureInput
  ): Promise<IpcEnvelope<{ path: string; nodeCount: number }>> =>
    ipcRenderer.invoke(IPC.project.exportStructure, input),
  importCanvasStructure: (): Promise<IpcEnvelope<ProjectMeta>> =>
    ipcRenderer.invoke(IPC.project.importStructure),
  importMedia: (input: {
    projectId: string
    paths: string[]
  }): Promise<IpcEnvelope<MediaImportResult>> => ipcRenderer.invoke(IPC.media.import, input),
  importMediaBuffer: (input: ImportMediaBufferInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.importBuffer, input),
  cropImage: (input: ImageCropTransformInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.imageCrop, input),
  splitImageGrid: (input: ImageSplitTransformInput): Promise<IpcEnvelope<MediaAsset[]>> =>
    ipcRenderer.invoke(IPC.media.imageSplit, input),
  extractVideoFrame: (input: VideoFrameTransformInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.videoFrame, input),
  clipVideo: (input: VideoClipTransformInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.videoClip, input),
  extractVideoAudio: (input: VideoAudioTransformInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.videoAudio, input),
  probeVideo: (input: VideoProbeInput): Promise<IpcEnvelope<VideoProbeResult>> =>
    ipcRenderer.invoke(IPC.media.videoProbe, input),
  generateVideoThumbnails: (
    input: VideoThumbnailsInput
  ): Promise<IpcEnvelope<VideoThumbnailsResult>> =>
    ipcRenderer.invoke(IPC.media.videoThumbnails, input),
  generateAudioWaveform: (input: AudioWaveformInput): Promise<IpcEnvelope<AudioWaveformResult>> =>
    ipcRenderer.invoke(IPC.media.audioWaveform, input),
  separateVocals: (input: VocalSeparateInput): Promise<IpcEnvelope<VocalSeparationResult>> =>
    ipcRenderer.invoke(IPC.media.vocalSeparate, input),
  getLocalMediaCapabilities: (): Promise<IpcEnvelope<LocalMediaCapabilities>> =>
    ipcRenderer.invoke(IPC.media.localCapabilities),
  getVideoEngineStatus: (): Promise<IpcEnvelope<VideoEngineStatus>> =>
    ipcRenderer.invoke(IPC.media.videoEngineStatus),
  installVideoEngine: (): Promise<IpcEnvelope<{ started: boolean }>> =>
    ipcRenderer.invoke(IPC.media.videoEngineInstall),
  convertVideoDepth: (input: VideoConversionInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.videoConvertDepth, input),
  convertVideoClay: (input: VideoConversionInput): Promise<IpcEnvelope<MediaAsset>> =>
    ipcRenderer.invoke(IPC.media.videoConvertClay, input),
  cancelVideoConversion: (jobId: string): Promise<IpcEnvelope<boolean>> =>
    ipcRenderer.invoke(IPC.media.videoConvertCancel, { jobId }),
  ttsGenerate: (input: TtsGenerateInput): Promise<IpcEnvelope<VoiceCloneResult>> =>
    ipcRenderer.invoke(IPC.media.ttsGenerate, input),
  comfyui: {
    status: (): Promise<IpcEnvelope<ComfyuiStatus>> => ipcRenderer.invoke(IPC.comfyui.status),
    saveSettings: (input: ComfyuiSettingsInput): Promise<IpcEnvelope<{ baseUrl: string }>> =>
      ipcRenderer.invoke(IPC.comfyui.saveSettings, input)
  },
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
  // 批量导出：弹出目录选择，将项目所有或当前筛选出的媒体复制到目标目录。
  batchExportMedia: (
    projectId: string,
    mediaIds?: string[]
  ): Promise<IpcEnvelope<{ exported: number; failed: number; targetDir: string }>> =>
    ipcRenderer.invoke(IPC.media.batchExport, { projectId, mediaIds }),
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
      ipcRenderer.invoke(IPC.workspace.deleteSnapshot, input),
    getPalettePreferences: (): Promise<IpcEnvelope<PalettePreferences>> =>
      ipcRenderer.invoke(IPC.workspace.getPalettePreferences),
    savePalettePreferences: (input: PalettePreferences): Promise<IpcEnvelope<PalettePreferences>> =>
      ipcRenderer.invoke(IPC.workspace.savePalettePreferences, input),
    recordImageGenerationTiming: (
      input: ImageGenerationTimingSample
    ): Promise<IpcEnvelope<ImageGenerationTimingSample[]>> =>
      ipcRenderer.invoke(IPC.workspace.recordImageGenerationTiming, input),
    getImageGenerationTimings: (): Promise<IpcEnvelope<ImageGenerationTimingSample[]>> =>
      ipcRenderer.invoke(IPC.workspace.getImageGenerationTimings)
  },
  // 拖拽落盘的 File 对象拿真实路径（Electron 32+ 移除了 File.path）
  getDroppedFilePath: (file: File): string => webUtils.getPathForFile(file),
  gateway: {
    listProviders: (): Promise<IpcEnvelope<ProviderSummary[]>> =>
      ipcRenderer.invoke(IPC.gateway.providers),
    listExecutableProviders: (): Promise<IpcEnvelope<ProviderSummary[]>> =>
      ipcRenderer.invoke(IPC.gateway.executableProviders),
    saveProvider: (input: SaveProviderInput): Promise<IpcEnvelope<ProviderSummary>> =>
      ipcRenderer.invoke(IPC.gateway.saveProvider, input),
    exportProviders: (input: { password: string }): Promise<IpcEnvelope<{ path: string; count: number }>> =>
      ipcRenderer.invoke(IPC.gateway.exportProviders, input),
    importProviders: (input: { password: string }): Promise<IpcEnvelope<{ added: number; updated: number; count: number }>> =>
      ipcRenderer.invoke(IPC.gateway.importProviders, input),
    deleteProvider: (id: string): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.gateway.deleteProvider, id),
    testProvider: (input: SaveProviderInput): Promise<IpcEnvelope<TestProviderResult>> =>
      ipcRenderer.invoke(IPC.gateway.testProvider, input),
    probeProvider: (input: ProbeProviderInput): Promise<IpcEnvelope<ProbeProviderResult>> =>
      ipcRenderer.invoke(IPC.gateway.probeProvider, input),
    chatStart: (input: ChatStartInput): Promise<IpcEnvelope<{ taskId: string }>> =>
      ipcRenderer.invoke(IPC.gateway.chatStart, input),
    chatCancel: (taskId: string): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.gateway.chatCancel, { taskId }),
    imageGenerate: (input: ImageGenerateInput): Promise<IpcEnvelope<MediaAsset>> =>
      ipcRenderer.invoke(IPC.gateway.imageGenerate, input),
    imageEdit: (input: ImageEditInput): Promise<IpcEnvelope<MediaAsset>> =>
      ipcRenderer.invoke(IPC.gateway.imageEdit, input),
    videoSubmit: (input: VideoSubmitInput): Promise<IpcEnvelope<VideoSubmitResult>> =>
      ipcRenderer.invoke(IPC.gateway.videoSubmit, input),
    videoCancel: (taskId: string): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.gateway.videoCancel, { taskId }),
    videoTask: (taskId: string): Promise<IpcEnvelope<VideoTaskInfo | null>> =>
      ipcRenderer.invoke(IPC.gateway.videoTask, { taskId }),
    audioGenerate: (input: AudioGenerateInput): Promise<IpcEnvelope<MediaAsset>> =>
      ipcRenderer.invoke(IPC.gateway.audioGenerate, input),
    speechGenerate: (input: SpeechGenerateInput): Promise<IpcEnvelope<SpeechGenerateResult>> =>
      ipcRenderer.invoke(IPC.gateway.speechGenerate, input),
    voiceDesign: (input: VoiceDesignInput): Promise<IpcEnvelope<VoiceDesignResult>> =>
      ipcRenderer.invoke(IPC.gateway.voiceDesign, input),
    // 网关事件订阅（聊天流式分片 / 视频任务进度），返回取消订阅函数
    onEvent: (cb: (e: GatewayEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: GatewayEvent): void => cb(payload)
      ipcRenderer.on(IPC.gateway.event, listener)
      return () => {
        ipcRenderer.off(IPC.gateway.event, listener)
      }
    }
  }
  ,
  models: {
    listConnections: (): Promise<IpcEnvelope<Connection[]>> => ipcRenderer.invoke(IPC.models.connections),
    listDefinitions: (connectionId?: string): Promise<IpcEnvelope<ModelDefinition[]>> =>
      ipcRenderer.invoke(IPC.models.definitions, connectionId),
    listBindings: (): Promise<IpcEnvelope<import('@free-creation/model-contracts').FeatureBinding[]>> =>
      ipcRenderer.invoke(IPC.models.bindings),
    saveConnection: (input: SaveModelConnectionInput): Promise<IpcEnvelope<Connection>> =>
      ipcRenderer.invoke(IPC.models.saveConnection, input),
    saveDefinition: (input: SaveModelDefinitionInput): Promise<IpcEnvelope<ModelDefinition>> =>
      ipcRenderer.invoke(IPC.models.saveDefinition, input),
    deleteDefinition: (input: DeleteModelDefinitionInput): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.models.deleteDefinition, input),
    deleteDefinitions: (input: import('../shared/contracts').DeleteModelDefinitionsInput): Promise<IpcEnvelope<number>> =>
      ipcRenderer.invoke(IPC.models.deleteDefinitions, input),
    deleteConnection: (input: import('../shared/contracts').DeleteModelConnectionInput): Promise<IpcEnvelope<boolean>> =>
      ipcRenderer.invoke(IPC.models.deleteConnection, input),
    discover: (input: import('../shared/contracts').DiscoverModelDefinitionsInput): Promise<IpcEnvelope<import('../shared/contracts').DiscoveredModel[]>> =>
      ipcRenderer.invoke(IPC.models.discover, input),
    validate: (input: ValidateModelDefinitionInput): Promise<IpcEnvelope<ModelValidationResult>> =>
      ipcRenderer.invoke(IPC.models.validate, input),
    saveBinding: (input: SaveModelFeatureBindingInput): Promise<IpcEnvelope<import('@free-creation/model-contracts').FeatureBinding>> =>
      ipcRenderer.invoke(IPC.models.saveBinding, input),
    resolveBinding: (input: ResolveModelFeatureInput): Promise<IpcEnvelope<ResolvedModelFeature>> =>
      ipcRenderer.invoke(IPC.models.resolveBinding, input)
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
