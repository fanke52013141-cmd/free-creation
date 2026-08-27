// IPC 契约：通道名 + payload 类型 + 统一信封（见《技术框架与规范》§10）

import type { ChatMessage, GatewayModelInfo, ProviderSpecId, VideoGenParams } from '../types'

export const IPC = {
  app: {
    bootstrap: 'app:bootstrap'
  },
  log: {
    /** 渲染进程 → 主进程：运行错误 / 全局异常落盘（fire-and-forget） */
    write: 'log:write'
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
    /** 导入内置示例项目（resources/demo 的 canvasbundle，每次生成新 id 副本） */
    importDemo: 'project:import-demo'
  },
  media: {
    import: 'media:import',
    importBuffer: 'media:import-buffer',
    pick: 'media:pick',
    list: 'media:list',
    delete: 'media:delete',
    reveal: 'media:reveal',
    copyPath: 'media:copy-path',
    open: 'media:open',
    batchExport: 'media:batch-export'
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
  },
  run: {
    /** 渲染进程 → 主进程：运行记录追加（fire-and-forget） */
    append: 'run:append',
    /** 渲染进程 → 主进程：读取项目运行记录列表 */
    list: 'run:list'
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

// ── 运行日志（渲染进程 → 主进程 fire-and-forget）──

/** 渲染进程上报的运行错误条目，经 sanitizeRunError 脱敏后落盘。 */
export interface RunLogEntry {
  label: string
  reason: string
  nodeId?: string
  portId?: string
  phase?: string
  nodeType?: string
  contractVersion?: number
  runId?: string
  /** 未提供时由主进程落盘前盖章（组件内调用 Date.now 会被 React 编译器判为非纯） */
  timestamp?: number
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

// ── 运行记录（R8 WP2：节点级 runMeta + 项目级 runs.json）──

/** 节点级运行元数据，以 JSON 字符串存入 NodeCardShape.runMeta 字段。 */
export interface RunMeta {
  /** 结束时间戳（ms） */
  at: number
  /** 该节点本次执行耗时（ms） */
  durationMs: number
  /** 所属全局运行的 runId（与 executor WorkflowContext.runId 一致） */
  runId: string
  /** 失败时的摘要错误信息（已脱敏） */
  error?: string
}

/** 单节点运行明细（run record 内一条节点记录） */
export interface RunRecordNode {
  /** 节点 ID（tldraw shape id） */
  id: string
  /** 节点标签 / 标题 */
  label: string
  /** 节点类型（nodeType） */
  type: string
  /** 执行状态 */
  status: 'done' | 'skipped' | 'failed'
  /** 该节点执行耗时（ms） */
  durationMs: number
  /** 失败时的错误原因（已脱敏） */
  errorReason?: string
}

/** 项目级运行记录条目（runs.json 中一条） */
export interface RunRecordEntry {
  /** 运行唯一标识（executor 生成的 crypto.randomUUID()） */
  runId: string
  /** 运行开始时间戳（ms） */
  startedAt: number
  /** 整轮运行总耗时（ms） */
  durationMs: number
  /** 参与本轮运行的节点总数 */
  total: number
  /** 成功节点数（status = done） */
  ok: number
  /** 失败节点数（status = failed） */
  failed: number
  /** 节点级明细数组 */
  nodes: RunRecordNode[]
}

/** 渲染进程 → 主进程：追加运行记录（fire-and-forget） */
export interface AppendRunInput {
  projectId: string
  record: RunRecordEntry
}
