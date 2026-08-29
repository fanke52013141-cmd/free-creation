// IPC 契约：通道名 + payload 类型 + 统一信封（见《技术框架与规范》§10）

import type { ChatMessage, GatewayModelInfo, ProviderSpecId, VideoGenParams } from '../types'
import type { ImageCropConfig } from '../image-crop'

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
    import: 'project:import'
  },
  media: {
    import: 'media:import',
    importBuffer: 'media:import-buffer',
    imageCrop: 'media:image-crop',
    pick: 'media:pick',
    list: 'media:list',
    delete: 'media:delete',
    reveal: 'media:reveal',
    copyPath: 'media:copy-path',
    open: 'media:open',
    batchExport: 'media:batch-export'
  },
  workspace: {
    listTemplates: 'workspace:templates:list',
    saveTemplate: 'workspace:templates:save',
    deleteTemplate: 'workspace:templates:delete',
    listSnapshots: 'workspace:snapshots:list',
    saveSnapshot: 'workspace:snapshots:save',
    deleteSnapshot: 'workspace:snapshots:delete'
  },
  gateway: {
    providers: 'gateway:providers:list',
    saveProvider: 'gateway:providers:save',
    deleteProvider: 'gateway:providers:delete',
    testProvider: 'gateway:providers:test',
    chatStart: 'gateway:chat:start',
    chatCancel: 'gateway:chat:cancel',
    imageGenerate: 'gateway:image:generate',
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
  /** 种子：固定后可复现同一张图，0 或留空表示随机 */
  seed?: number
  /** 宽高比（部分供应商支持） */
  aspectRatio?: string
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
