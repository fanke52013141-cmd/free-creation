// 核心数据模型（双进程共享单一事实源，见《技术框架与规范》§4）

export type NodeTypeId =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'chat'
  | 'script'
  | 'code'
  | 'json'
  | 'group'
  | 'storyboard'
  | 'compose'

export type PortType = 'text' | 'json' | 'image' | 'video' | 'audio' | 'file' | 'any'

export type MediaKind = 'image' | 'video' | 'audio' | 'file'

export interface PortDecl {
  id: string
  name: string
  dir: 'in' | 'out'
  type: PortType
  required?: boolean
}

export type NodeContent =
  | { kind: 'text'; text: string }
  | { kind: 'json'; data: unknown }
  | { kind: 'media'; mediaId: string }
  | { kind: 'chat'; messages: unknown[] }
  | { kind: 'empty' }

export type ExecStatus =
  'idle' | 'pending' | 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'cached'

export interface ExecState {
  status: ExecStatus
  error?: { stage: string; reason: string; raw?: string }
  updatedAt?: number
}

export interface CanvasNode {
  id: string
  type: NodeTypeId
  title: string
  x: number
  y: number
  w: number
  h: number
  ports: PortDecl[]
  params: Record<string, unknown>
  content: NodeContent
  exec: ExecState
  meta: {
    source: 'upload' | 'generate' | 'derive' | 'input'
    createdAt: number
    taskId?: string
    derivedFrom?: string
  }
}

export interface CanvasEdge {
  id: string
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}

export interface GroupDecl {
  id: string
  name: string
  nodeIds: string[]
  kind: 'plain' | 'storyboard' | 'generator'
}

export interface ProjectMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  coverMediaId?: string
  graphVersion: number
}

// project.json 结构。tldrawSnapshot 保存画布原始状态（含视口）；
// nodes/edges 是我们自己的图数据，M2 节点系统起开始填充。
export interface ProjectFile {
  version: 1
  meta: ProjectMeta
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  groups: GroupDecl[]
  tldrawSnapshot?: unknown
}

export interface MediaAsset {
  id: string
  kind: MediaKind
  mime: string
  path: string
  sizeBytes: number
  width?: number
  height?: number
  durationSec?: number
  thumbPath?: string
  createdAt: number
  /** 原始文件名（不含扩展名），节点标题用 */
  name?: string
  /** 文本类小文件（txt/md/json）的正文内容，建文本节点时直接填充 */
  textContent?: string
}

export interface MediaImportError {
  path: string
  reason: string
}

export interface MediaImportResult {
  assets: MediaAsset[]
  errors: MediaImportError[]
}

export interface AsyncTask {
  id: string
  providerId: string
  modelId: string
  nodeId: string
  projectId: string
  kind: 'image' | 'video' | 'audio' | 'chat'
  status: 'pending' | 'submitted' | 'running' | 'success' | 'failed' | 'cancelled'
  input: unknown
  output?: { mediaId?: string; text?: string }
  error?: string
  attempts: number
  createdAt: number
  updatedAt: number
}

// ── M4 模型网关（见《M4-模型网关-开源方案调研》）──

export type ModelModality = 'text' | 'image' | 'video' | 'audio'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GatewayModelInfo {
  /** 发给 API 的模型 ID */
  id: string
  /** UI 显示名（缺省用 id） */
  name?: string
  modality: ModelModality
  contextLimit?: number
  outputLimit?: number
}

export type ProviderSpecId =
  'openai' | 'deepseek' | 'qwen' | 'kimi' | 'glm' | 'doubao' | 'relay' | 'minimax' | 'seedance'

export interface ProviderConfig {
  id: string
  name: string
  specId: ProviderSpecId
  baseURL: string
  apiKey: string
  models: GatewayModelInfo[]
  createdAt: number
}

/** 供应商模板：新增供应商时的预设（渲染端设置面板与主进程驱动映射共用） */
export interface ProviderSpec {
  id: ProviderSpecId
  label: string
  desc: string
  baseURL: string
  /** 该模板主要服务的模态，仅作面板提示 */
  modality: ModelModality
  suggestions: string[]
}

export const PROVIDER_SPECS: ProviderSpec[] = [
  {
    id: 'relay',
    label: '中转站 / 自定义',
    desc: 'OpenAI 兼容端点（BaseURL + Key + Model），常用于 GPT 系列文本与生图',
    baseURL: '',
    modality: 'image',
    suggestions: ['gpt-image-2', 'gpt-5.2']
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    desc: 'ChatGPT 官方 API',
    baseURL: 'https://api.openai.com/v1',
    modality: 'text',
    suggestions: ['gpt-5.2']
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    desc: '深度求索官方 API',
    baseURL: 'https://api.deepseek.com',
    modality: 'text',
    suggestions: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'qwen',
    label: '通义千问',
    desc: '阿里云百炼 DashScope（OpenAI 兼容模式）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modality: 'text',
    suggestions: ['qwen-max', 'qwen-plus']
  },
  {
    id: 'kimi',
    label: 'Kimi',
    desc: '月之暗面官方 API',
    baseURL: 'https://api.moonshot.cn/v1',
    modality: 'text',
    suggestions: ['kimi-k2-turbo-preview']
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    desc: '智谱开放平台（OpenAI 兼容）',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    modality: 'text',
    suggestions: ['glm-4.6']
  },
  {
    id: 'doubao',
    label: '豆包（方舟）',
    desc: '火山方舟 OpenAI 兼容端点，模型 ID 用接入点或方舟模型 ID',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    modality: 'text',
    suggestions: []
  },
  {
    id: 'minimax',
    label: 'MiniMax（海螺）',
    desc: 'MiniMax H3 视频生成，异步任务式',
    baseURL: 'https://api.minimaxi.com',
    modality: 'video',
    suggestions: ['MiniMax-H3']
  },
  {
    id: 'seedance',
    label: 'Seedance（火山方舟）',
    desc: '字节 Seedance 视频生成（方舟账户需余额>200元），模型 ID 带日期版本号',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    modality: 'video',
    suggestions: ['doubao-seedance-2-0-260128']
  }
]

export interface VideoGenParams {
  ratio?: string
  duration?: number
  resolution?: string
}

/** 视频任务对渲染端的投影（tasks 表 kind='video' 行） */
export interface VideoTaskInfo {
  id: string
  projectId: string
  nodeId: string
  providerId: string
  modelId: string
  status: 'submitted' | 'running' | 'success' | 'failed' | 'cancelled'
  mediaId?: string
  mediaPath?: string
  error?: string
  createdAt: number
  updatedAt: number
}
