// IPC 契约：通道名 + payload 类型 + 统一信封（见《技术框架与规范》§10）

import type {
  ChatMessage,
  GatewayModelInfo,
  ProviderSpecId,
  VideoGenerationMode,
  VideoGenParams
} from '../types'
import type { ImageCropConfig } from '../image-crop'
import type { ImageSplitConfig } from '../image-split'
import type { ImageEditConfig } from '../image-edit'
import type { TtsConfig } from '../tts'
import type { SpeechConfig } from '../speech'
import type { VoiceDesignConfig } from '../voice-design'
import type {
  VideoFrameConfig,
  VideoClipConfig,
  VideoAudioConfig,
  VocalSeparationConfig
} from '../video-transform'
import type { PalettePreferences } from '../palette-preferences'
import type { WorkspaceProfile } from '../workspace-profile'
import type {
  CreateLibraryCollectionInput,
  CreateLibraryResourceInput,
  CaptureProjectMediaInput,
  LibraryBoard,
  LibraryBoardItem,
  LibraryCollection,
  LibraryResourceDetail,
  LibraryResourceSummary,
  LibrarySearchInput,
  PublishLibraryRevisionInput,
  SaveLibraryBoardInput,
  SetLibraryCollectionsInput
} from '../library/types'
import type {
  Capability,
  Connection,
  JsonValue,
  ModelDefinition,
  ModelOperation
} from '@free-creation/model-contracts'

export const IPC = {
  app: {
    bootstrap: 'app:bootstrap'
  },
  project: {
    list: 'project:list',
    create: 'project:create',
    clone: 'project:clone',
    saveWorkspaceProfile: 'project:workspace-profile:save',
    rename: 'project:rename',
    remove: 'project:delete',
    open: 'project:open',
    save: 'project:save',
    saveSync: 'project:save-sync',
    close: 'project:close',
    export: 'project:export',
    import: 'project:import',
    exportStructure: 'project:export-structure',
    importStructure: 'project:import-structure',
    externalChange: 'project:external-change'
  },
  media: {
    import: 'media:import',
    importBuffer: 'media:import-buffer',
    imageCrop: 'media:image-crop',
    imageSplit: 'media:image-split',
    videoFrame: 'media:video-frame',
    videoClip: 'media:video-clip',
    videoAudio: 'media:video-audio',
    videoProbe: 'media:video-probe',
    videoThumbnails: 'media:video-thumbnails',
    audioWaveform: 'media:audio-waveform',
    vocalSeparate: 'media:vocal-separate',
    localCapabilities: 'media:local-capabilities',
    videoEngineStatus: 'media:video-engine-status',
    videoEngineInstall: 'media:video-engine-install',
    videoConvertDepth: 'media:video-convert-depth',
    videoConvertClay: 'media:video-convert-clay',
    videoConvertCancel: 'media:video-convert-cancel',
    pick: 'media:pick',
    list: 'media:list',
    delete: 'media:delete',
    reveal: 'media:reveal',
    copyPath: 'media:copy-path',
    open: 'media:open',
    batchExport: 'media:batch-export',
    ttsGenerate: 'media:tts-generate'
  },
  comfyui: {
    status: 'comfyui:status',
    saveSettings: 'comfyui:save-settings'
  },
  workspace: {
    listTemplates: 'workspace:templates:list',
    saveTemplate: 'workspace:templates:save',
    deleteTemplate: 'workspace:templates:delete',
    listSnapshots: 'workspace:snapshots:list',
    saveSnapshot: 'workspace:snapshots:save',
    deleteSnapshot: 'workspace:snapshots:delete',
    getPalettePreferences: 'workspace:palette-preferences:get',
    savePalettePreferences: 'workspace:palette-preferences:save',
    recordImageGenerationTiming: 'workspace:image-generation-timing:record',
    getImageGenerationTimings: 'workspace:image-generation-timings:get'
  },
  library: {
    listCategories: 'library:categories:list',
    saveCategory: 'library:categories:save',
    discardMaterialization: 'library:materialize:discard',
    search: 'library:search',
    detail: 'library:detail',
    create: 'library:create',
    captureProjectMedia: 'library:capture-project-media',
    publishRevision: 'library:publish-revision',
    archive: 'library:archive',
    listCollections: 'library:collections:list',
    createCollection: 'library:collections:create',
    setCollections: 'library:collections:set',
    listBoards: 'library:boards:list',
    createBoard: 'library:boards:create',
    getBoardItems: 'library:boards:items',
    saveBoard: 'library:boards:save',
    materialize: 'library:materialize',
    export: 'library:export',
    import: 'library:import'
  },
  gateway: {
    providers: 'gateway:providers:list',
    executableProviders: 'gateway:providers:executable',
    saveProvider: 'gateway:providers:save',
    deleteProvider: 'gateway:providers:delete',
    exportProviders: 'gateway:providers:export',
    importProviders: 'gateway:providers:import',
    testProvider: 'gateway:providers:test',
    probeProvider: 'gateway:providers:probe',
    chatStart: 'gateway:chat:start',
    chatCancel: 'gateway:chat:cancel',
    imageGenerate: 'gateway:image:generate',
    imageEdit: 'gateway:image:edit',
    videoSubmit: 'gateway:video:submit',
    videoCancel: 'gateway:video:cancel',
    videoTask: 'gateway:video:task',
    audioGenerate: 'gateway:audio:generate',
    speechGenerate: 'gateway:speech:generate',
    voiceDesign: 'gateway:voice:design',
    event: 'gateway:event'
  },
  models: {
    connections: 'models:connections:list',
    saveConnection: 'models:connections:save',
    definitions: 'models:definitions:list',
    saveDefinition: 'models:definitions:save',
    deleteDefinition: 'models:definitions:delete',
    deleteDefinitions: 'models:definitions:delete-many',
    deleteConnection: 'models:connections:delete',
    discover: 'models:connections:discover',
    validate: 'models:definitions:validate',
    saveBinding: 'models:bindings:save',
    bindings: 'models:bindings:list',
    resolveBinding: 'models:bindings:resolve'
  }
} as const

export type IpcEnvelope<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export interface BootstrapInfo {
  lastProjectId: string | null
}

// ── 新模型模块（与 legacy gateway providers 完全独立）──────────────────────

export interface SaveModelConnectionInput {
  id: string
  name: string
  protocol: Connection['protocol']
  baseUrl: string
  /** 省略时保留已保存的密钥；绝不会回传到 renderer。 */
  apiKey?: string
  headers?: Record<string, string>
  metadata?: Record<string, unknown>
  enabled?: boolean
}

export interface SaveModelDefinitionInput {
  id: string
  connectionId: string
  name: string
  modelId: string
  capabilities: Capability[]
  metadata?: Record<string, unknown>
  enabled?: boolean
}

export interface DeleteModelDefinitionInput {
  modelDefinitionId: string
}

export interface DeleteModelDefinitionsInput {
  modelDefinitionIds: string[]
}

export interface DeleteModelConnectionInput {
  connectionId: string
}

/** A redacted result of the provider's optional OpenAI-compatible /models endpoint. */
export interface DiscoverModelDefinitionsInput {
  connectionId: string
}

export interface DiscoveredModel {
  id: string
  name: string
}

export interface ValidateModelDefinitionInput {
  connectionId: string
  modelDefinitionId: string
  operation: ModelOperation
  /** 真实验证会按该模型的最低请求计费，调用方必须显式确认。 */
  allowCost: true
}

export interface ModelValidationResult {
  status: 'unverified' | 'validating' | 'verified' | 'failed' | 'unsupported'
  message: string
  action?: string
  checkedAt: string
}

export interface SaveModelFeatureBindingInput {
  featureKey: string
  connectionId: string
  modelDefinitionId: string
  operation: ModelOperation
  enabled?: boolean
  overrides?: Record<string, JsonValue>
}

export interface ResolveModelFeatureInput {
  featureKey: string
  operation: ModelOperation
}

/** Redacted execution target: it deliberately never contains a connection secret. */
export interface ResolvedModelFeature {
  featureKey: string
  providerId: string
  modelId: string
  operation: ModelOperation
  modelKey: string
}

export interface ModelCatalogSnapshot {
  connections: Connection[]
  models: ModelDefinition[]
}

export interface CreateProjectInput {
  name: string
  workspaceProfile?: WorkspaceProfile
}

export interface CloneProjectInput {
  sourceId: string
  name: string
}

export interface SaveWorkspaceProfileInput {
  projectId: string
  workspaceProfile: WorkspaceProfile
}

export interface LibraryMaterializeInput {
  nodeBindings?: Array<{ componentId: string; nodeId: string }>
  projectId: string
  resourceId: string
  revisionId: string
  componentIds: string[]
}

export interface LibrarySearchResult {
  items: LibraryResourceSummary[]
  nextCursor: string | null
}

export interface LibraryMaterializeResult {
  usageId: string
  componentAssets: Array<{ componentId: string; asset: import('../types').MediaAsset }>
  assets: import('../types').MediaAsset[]
  textComponents: import('../library/types').LibraryResourceComponent[]
}

export interface LibraryExportInput {
  resourceIds?: string[]
}

export interface LibraryDetailInput {
  resourceId: string
  revisionId?: string
}

export interface LibraryArchiveInput {
  resourceId: string
  archived: boolean
}

export type {
  CreateLibraryCollectionInput,
  CreateLibraryResourceInput,
  CaptureProjectMediaInput,
  LibraryBoard,
  LibraryBoardItem,
  LibraryCollection,
  LibraryResourceDetail,
  LibraryResourceSummary,
  LibrarySearchInput,
  PublishLibraryRevisionInput,
  SaveLibraryBoardInput,
  SetLibraryCollectionsInput
}

export interface RenameProjectInput {
  id: string
  name: string
}

export interface SaveProjectInput {
  id: string
  tldrawSnapshot?: unknown
  graph?: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
  /**
   * 乐观锁：renderer 记住上次成功保存返回的 graphVersion，保存前以此校验；
   * 不匹配（画布外有 Agent/其他写入）返回 REVISION_CONFLICT 而不是静默覆盖。
   */
  expectedGraphVersion?: number
}

export interface ExportCanvasStructureInput {
  id: string
  name: string
  snapshot: unknown
  graph: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
}

export interface ImportMediaBufferInput {
  projectId: string
  mime: string
  name?: string
  data: Uint8Array
}

export interface ImageCropTransformInput {
  projectId: string
  sourceMediaId: string
  config: ImageCropConfig
}

export interface ImageSplitTransformInput {
  projectId: string
  sourceMediaId: string
  config: ImageSplitConfig
}

export interface VideoTransformSourceInput {
  projectId: string
  sourceMediaId: string
}

export interface VideoFrameTransformInput extends VideoTransformSourceInput {
  config: VideoFrameConfig
}

export interface VideoClipTransformInput extends VideoTransformSourceInput {
  config: VideoClipConfig
}

export interface VideoAudioTransformInput extends VideoTransformSourceInput {
  config: VideoAudioConfig
}

/** 只读取当前项目内视频的元信息，供时间轴精确显示；不产生媒体资产。 */
export interface VideoProbeInput extends VideoTransformSourceInput {}

export interface VideoProbeResult {
  durationMs: number
  /** 源视频的平均帧率；不可用时为 null，时间轴仍以毫秒为准。 */
  fps: number | null
  hasAudio: boolean
}

/** 时间轴缩略图请求：均匀采样指定数量的帧返回 data URL 数组。 */
export interface VideoThumbnailsInput extends VideoTransformSourceInput {
  count: number
}

export interface VideoThumbnailsResult {
  /** 与 count 等长的 data URL 数组（JPEG）。 */
  thumbnails: string[]
}

/** 音频波形采样请求：返回归一化振幅数组供前端绘制。 */
export interface AudioWaveformInput {
  projectId: string
  sourceMediaId: string
  /** 采样点数；建议 200-400。 */
  samples: number
}

export interface AudioWaveformResult {
  /** 归一化到 [0,1] 的峰值数组。 */
  peaks: number[]
  sampleRate: number
}

export interface VocalSeparateInput {
  projectId: string
  sourceMediaId: string
  config: VocalSeparationConfig
}

export interface VocalSeparationResult {
  vocals: import('../types').MediaAsset
  /** 仅当 config.outputAccompaniment=true 时存在。 */
  accompaniment?: import('../types').MediaAsset
}

/** 本机媒体工具只读探测结果；用于在配置阶段提示，不能替代执行时的真实错误处理。 */
export interface LocalToolCapability {
  available: boolean
  message: string
}

export interface LocalMediaCapabilities {
  ffmpeg: LocalToolCapability
  ffprobe: LocalToolCapability
  audioSeparator: LocalToolCapability
}

/** State of the app-managed local CUDA runtime used by the video conversion nodes. */
export interface VideoEngineStatus {
  pythonAvailable: boolean
  ready: boolean
  installing: boolean
  progress: string
  message: string
  gpuName?: string
}

export interface VideoConversionInput {
  projectId: string
  sourceMediaId: string
  /** Stable for one run so the UI can cancel its active child process. */
  jobId: string
  config: import('../video-conversion').VideoDepthConfig | import('../video-conversion').VideoClayConfig
}

// ── 本地 ComfyUI 语音复刻（IndexTTS-2.5）──

export interface TtsGenerateInput {
  projectId: string
  /** 参考音频（音色来源）在本地图库中的 mediaId。 */
  referenceAudioId: string
  /** 要朗读的文本。 */
  text: string
  /** 合成参数（语言 / 语速 / 情绪 / 输出格式）。 */
  config: TtsConfig
}

/**
 * 语音复刻结果。MiniMax 链路会额外登记一个可复用的 voice_id；
 * 本地 ComfyUI 链路没有音色概念，voiceId 为空串而不是伪造一个。
 */
export interface VoiceCloneResult {
  asset: import('../types').MediaAsset
  voiceId: string
}

export interface ComfyuiSettingsInput {
  /** ComfyUI 服务地址，如 http://127.0.0.1:8188。 */
  baseUrl: string
}

export interface ComfyuiStatus {
  online: boolean
  baseUrl: string
  /** ComfyUI 版本号（仅在线时返回）。 */
  version?: string
  /** IndexTTS-2.5 自定义节点是否已安装。 */
  ttsNodeReady: boolean
  /** 人类可读的状态说明（连接失败原因 / 缺节点提示）。 */
  message: string
}

// ── 本地工作区状态（模板与手动历史版本）──

export interface WorkflowTemplateRecord {
  id: string
  name: string
  createdAt: number
  nodes: unknown[]
  edges: unknown[]
  nodeCount: number
}

export interface SaveWorkflowTemplateInput {
  name: string
  nodes: unknown[]
  edges: unknown[]
  nodeCount: number
}

export interface HistorySnapshotRecord {
  id: string
  label: string
  timestamp: number
  nodeCount: number
  snapshot: unknown
}

export interface SaveHistorySnapshotInput {
  projectId: string
  label: string
  nodeCount: number
  snapshot: unknown
}

/** 本机 UI 偏好；不属于项目文件，导入导出不会携带。 */
export type { PalettePreferences }

/**
 * 单张图片生成的本机耗时样本。它刻意不包含 prompt、项目 ID、媒体 ID 或供应商密钥：
 * 这份数据只用于估算同一供应商/模型的完成进度，且不随项目导入导出。
 */
export interface ImageGenerationTimingSample {
  /** 同一次节点运行的稳定 ID；主进程以它幂等去重，重载界面不会重复采样。 */
  runId: string
  providerKey: string
  modelKey: string
  durationMs: number
  recordedAt: number
}

// ── 模型网关契约 ──

export interface SaveProviderInput {
  /** 有 id 为更新，无 id 为新建 */
  id?: string
  name: string
  specId: ProviderSpecId
  baseURL: string
  /** 新建时必填；更新时留空代表保留主进程已保存的密钥。 */
  apiKey?: string
  models: GatewayModelInfo[]
}

export interface TestProviderResult {
  models: string[]
  message: string
}

/** 供应商协议自检：一条「该协议会这样发请求」的可核对记录。 */
export interface ProviderProbeOutcome {
  /**
   * pass 只在端点可达且回执不含鉴权语义时给出；判定刻意保守，宁可 unknown 也不
   * 能把「我没验证成」说成「你的密钥没问题」。
   */
  status: 'pass' | 'fail' | 'unknown'
  httpStatus?: number
  detail: string
}

export interface ProviderProbeItem {
  id: string
  label: string
  method: 'GET' | 'POST'
  url: string
  /** 将要发送的请求体（密钥已掩码）；只读探测项没有请求体 */
  body?: string
  /** 仍然缺失的必填项；非空时不提供真实调用 */
  missing: string[]
  /** free 由自检自动探测（零计费）；paid 必须用户逐条确认后才真实提交 */
  cost: 'free' | 'paid'
  probe?: ProviderProbeOutcome
}

export interface ProbeProviderInput extends SaveProviderInput {
  /** 要真实调用的条目 id；缺省表示只做免费预览与只读探测 */
  runItemId?: string
  /** 必须显式为 true 才允许计费调用，防止误触 */
  allowCost?: true
}

export interface ProbeProviderResult {
  items: ProviderProbeItem[]
  summary: string
}

export interface ChatStartInput {
  providerId: string
  modelId: string
  system?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'high'
}

export interface ImageGenerateInput {
  projectId: string
  providerId: string
  modelId: string
  prompt: string
  /** 传 'auto' 或留空表示用服务端默认 */
  size?: string
  /** 参考图（本地图库 mediaId，主进程转 base64 data URL 作为图生图输入） */
  referenceMediaId?: string
  /** 多参考图（真实 many 端口的稳定顺序）；与旧 referenceMediaId 合并去重后提交。 */
  referenceMediaIds?: string[]
  /** 种子：固定后可复现同一张图，0 或留空表示随机 */
  seed?: number
  /** 宽高比（部分供应商支持） */
  aspectRatio?: string
  /** 分辨率档位（1k/2k/4k）；仅当供应商能力表声明支持时由网关提交 */
  resolution?: string
  /** 透明背景；仅能力表声明 supportsTransparentBackground 的供应商会携带该字段 */
  background?: 'transparent'
}

export interface ImageEditInput {
  projectId: string
  sourceMediaId: string
  providerId: string
  modelId: string
  prompt: string
  size?: string
  config: ImageEditConfig
}

export interface VideoSubmitInput {
  projectId: string
  nodeId: string
  providerId: string
  modelId: string
  prompt: string
  /** 协议模式由节点配置明确选择，不能再根据“第几根线”猜测。 */
  mode?: VideoGenerationMode
  params?: VideoGenParams
  /** 首帧图（本地图库 mediaId，主进程转 base64 data URL 上传） */
  firstFrameMediaId?: string
  /** H3 等首尾帧协议的尾帧图；与首帧一样是明确的正式输入。 */
  lastFrameMediaId?: string
  /**
   * 多模态参考图片。顺序就是提示词中“图片 1 / 图片 2”的稳定顺序；
   * 首尾帧不混入此数组，避免角色和语义被悄悄混淆。
   */
  referenceImageMediaIds?: string[]
  /** 可选的多段运动参考视频；顺序来自 video.in-reference-video 的真实连线。 */
  referenceVideoMediaIds?: string[]
  /**
   * @deprecated 仅保留给已在运行中的旧调用；新代码一律使用 referenceVideoMediaIds。
   * 不作为节点契约的一部分。
   */
  referenceVideoMediaId?: string
  /** 多模态参考音频；不能把它伪装成输出配乐。 */
  referenceAudioMediaIds?: string[]
}

export interface VideoSubmitResult {
  taskId: string
}

// ── 音频生成（TTS）──

export interface AudioGenerateInput {
  projectId: string
  providerId: string
  modelId: string
  /** 要朗读的文本 */
  text: string
  /** 音色（部分供应商支持） */
  voice?: string
  /** 输出格式 */
  format?: string
  /** MiniMax 非流式合成可选的 AIGC 音频水印。 */
  aigcWatermark?: boolean
}

// ── 配音节点：模型驱动的语音合成 ──

/**
 * 配音节点的合成请求。`config.backend` 决定主进程走哪条协议：
 * minimax（异步 t2a_async_v2）/ volc（火山语音合成 1.0 tts/create）。
 */
export interface SpeechGenerateInput {
  projectId: string
  providerId: string
  modelId: string
  /** 已与上游文本合并后的朗读正文。 */
  text: string
  /** MiniMax 音色档案里的 voice_id（上游「音色设计」节点或节点内填写）；火山使用节点内 speaker。 */
  voiceId: string
  /** 火山语音合成 1.0 可选参考音频；引用本地素材库中的 1～3 个音频资产。 */
  referenceAudioIds?: string[]
  config: SpeechConfig
}

/** 火山语音合成 1.0 返回的字幕时间轴。 */
export interface SpeechSubtitleSentence {
  start_time: number
  end_time: number
  text: string
  words?: unknown[]
}

export interface SpeechSubtitle {
  text: string
  sentences: SpeechSubtitleSentence[]
}

export interface SpeechGenerateResult {
  asset: import('../types').MediaAsset
  /** 仅火山语音合成 1.0 在 enableSubtitle 打开时存在。 */
  subtitle?: SpeechSubtitle
  /**
   * 本次真正生效的音色 ID，用于产物溯源。只有网关能确定的才写：MiniMax 空值会兜底成
   * 系统音色；火山留空时服务端可能采用默认音色，因此不写——绝不拿"用户没填"冒充
   * "用了默认音色"。
   */
  voiceId?: string
}

// ── 音色设计节点（MiniMax voice_design）──

export interface VoiceDesignInput {
  projectId: string
  providerId: string
  /** 音色描述（已与上游文本合并）。 */
  prompt: string
  config: VoiceDesignConfig
}

export interface VoiceDesignResult {
  /** 试听音频（服务端 hex 解码后落盘的本地资产）。 */
  asset: import('../types').MediaAsset
  /** 设计出的 voice_id，可直接被下游配音节点引用。 */
  voiceId: string
}

/** 主进程 → 渲染进程的网关事件（聊天流式分片 / 视频任务进度） */
export type GatewayEvent =
  | { kind: 'chat-delta'; taskId: string; text: string }
  | { kind: 'chat-reasoning'; taskId: string; text: string }
  | { kind: 'chat-done'; taskId: string }
  | { kind: 'chat-error'; taskId: string; error: string }
  | { kind: 'video-status'; taskId: string; status: string; message?: string }
  | {
      kind: 'video-done'
      taskId: string
      mediaId: string
      mediaPath: string
      name: string
      mime: string
    }
  | { kind: 'video-error'; taskId: string; error: string }
