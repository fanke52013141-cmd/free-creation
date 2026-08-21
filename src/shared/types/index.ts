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
