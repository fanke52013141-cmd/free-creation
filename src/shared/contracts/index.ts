// IPC 契约：通道名 + payload 类型 + 统一信封（见《技术框架与规范》§10）

import type { ChatMessage, GatewayModelInfo, ProviderSpecId, VideoGenParams } from '../types'

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
    close: 'project:close'
  },
  media: {
    import: 'media:import',
    pick: 'media:pick',
    list: 'media:list',
    delete: 'media:delete'
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
    composeVideos: 'gateway:compose:videos',
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

// ── 模型网关契约 ──

export interface SaveProviderInput {
  /** 有 id 为更新，无 id 为新建 */
  id?: string
  name: string
  specId: ProviderSpecId
  baseURL: string
  apiKey: string
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
}

export interface ImageGenerateInput {
  projectId: string
  providerId: string
  modelId: string
  prompt: string
  /** 传 'auto' 或留空表示用服务端默认 */
  size?: string
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

// ── 视频合成 ──

export interface ComposeVideosInput {
  projectId: string
  /** 源视频的 mediaId 列表（按顺序拼接） */
  mediaIds: string[]
}

/** 主进程 → 渲染进程的网关事件（聊天流式分片 / 视频任务进度） */
export type GatewayEvent =
  | { kind: 'chat-delta'; taskId: string; text: string }
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
