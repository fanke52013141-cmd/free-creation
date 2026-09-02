// IPC 契约：通道名 + payload 类型 + 统一信封（见《技术框架与规范》§10）

import type { ChatMessage, GatewayModelInfo, ProviderSpecId, VideoGenParams } from '../types'
import type { ImageCropConfig } from '../image-crop'
import type { ImageSplitConfig } from '../image-split'
import type { ImageEditConfig } from '../image-edit'
import type { TtsConfig } from '../tts'
import type {
  VideoFrameConfig,
  VideoClipConfig,
  VideoAudioConfig,
  VocalSeparationConfig
} from '../video-transform'
import type { PalettePreferences } from '../palette-preferences'

export const IPC = {
  app: {
    bootstrap: 'app:bootstrap'
  },
  project: {
    list: 'project:list',
    create: 'project:create',
    rename: 'project:rename',
    remove: 'project:delete',
    open: 'project:open',
    save: 'project:save',
    saveSync: 'project:save-sync',
    close: 'project:close',
    export: 'project:export',
    import: 'project:import',
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
    savePalettePreferences: 'workspace:palette-preferences:save'
  },
  gateway: {
    providers: 'gateway:providers:list',
    saveProvider: 'gateway:providers:save',
    deleteProvider: 'gateway:providers:delete',
    testProvider: 'gateway:providers:test',
    chatStart: 'gateway:chat:start',
    chatCancel: 'gateway:chat:cancel',
    imageGenerate: 'gateway:image:generate',
    imageEdit: 'gateway:image:edit',
    videoSubmit: 'gateway:video:submit',
    videoCancel: 'gateway:video:cancel',
    videoTask: 'gateway:video:task',
    audioGenerate: 'gateway:audio:generate',
    event: 'gateway:event'
  }
} as const

export type IpcEnvelope<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export interface BootstrapInfo {
  lastProjectId: string | null
}

export interface CreateProjectInput {
  name: string
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

export interface ChatStartInput {
  providerId: string
  modelId: string
  system?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
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
