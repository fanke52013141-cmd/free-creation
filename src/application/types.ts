/**
 * Application Service Layer 类型定义
 *
 * 这个文件定义了所有应用服务的统一接口和返回类型。
 * 核心设计原则：
 * - 服务层不依赖任何 UI 框架（React/tldraw）
 * - 所有写操作返回 Result<T>，不抛出异常
 * - 所有操作通过 ProjectStore 访问数据，不直接读写文件系统
 * - 幂等性通过 idempotencyKey 保证
 */

import type {
  CanvasNode,
  CanvasEdge,
  GroupDecl,
  ProjectMeta,
  ProjectFile,
  MediaAsset,
  PortType,
  NodeTypeId
} from '@shared/types'

// ── 统一结果类型 ──────────────────────────────────────────

export type Result<T> = { ok: true; data: T } | { ok: false; error: ServiceError }

export interface ServiceError {
  code: string
  message: string
  /** 关联的节点/边/资产 ID */
  entityId?: string
  /** 额外上下文 */
  details?: Record<string, unknown>
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail<T>(
  code: string,
  message: string,
  details?: Record<string, unknown>
): Result<T> {
  return { ok: false, error: { code, message, details } }
}

/** 从 Result 中提取数据或抛出异常（仅供测试和内部使用） */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.data
  throw new Error(`[${result.error.code}] ${result.error.message}`)
}

// ── ProjectStore 接口 ─────────────────────────────────────

/**
 * 数据访问抽象层。不同适配器提供不同实现：
 * - FileProjectStore: 直接读写 project.json（CLI/MCP）
 * - DesktopProjectStore: 包装 tldraw Editor 状态（桌面端）
 * - IpcProjectStore: 通过 IPC 代理到主进程（渲染进程）
 */
export interface ProjectStore {
  // 项目操作
  listProjects(): Promise<ProjectMeta[]>
  getProject(id: string): Promise<ProjectFile | null>
  createProject(name: string): Promise<ProjectMeta>
  deleteProject(id: string): Promise<boolean>

  // 图数据操作
  getNodes(projectId: string): Promise<CanvasNode[]>
  getEdges(projectId: string): Promise<CanvasEdge[]>
  getGroups(projectId: string): Promise<GroupDecl[]>
  saveGraph(
    projectId: string,
    graph: { nodes: CanvasNode[]; edges: CanvasEdge[]; groups: GroupDecl[] },
    options?: { expectedGraphVersion?: number }
  ): Promise<{ graphVersion: number }>

  // 媒体资产
  listArtifacts(projectId: string): Promise<MediaAsset[]>
  getArtifact(assetId: string): Promise<MediaAsset | null>

  // Run / Artifact 持久化（P3）
  createRun(record: Omit<RunRecord, 'createdAt'>): Promise<RunRecord>
  updateRun(runId: string, patch: RunUpdatePatch): Promise<RunRecord | null>
  getRun(runId: string): Promise<RunRecord | null>
  listRuns(projectId: string, filter?: { status?: RunStatus }): Promise<RunRecord[]>
  createRunArtifact(
    record: Omit<RunArtifactRecord, 'artifactId' | 'createdAt'>
  ): Promise<RunArtifactRecord>
  listRunArtifacts(runId: string): Promise<RunArtifactRecord[]>
}

// ── 权限级别 ───────────────────────────────────────────────

export type PermissionLevel = 'read' | 'edit' | 'execute' | 'admin'

export interface Permission {
  level: PermissionLevel
  /** 允许的能力 ID 列表，空表示全部允许 */
  allowedCapabilities?: string[]
  /** 禁止的能力 ID 列表 */
  deniedCapabilities?: string[]
}

// ── 操作请求类型 ──────────────────────────────────────────

export interface CreateNodeRequest {
  projectId: string
  type: NodeTypeId
  title?: string
  x?: number
  y?: number
  params?: Record<string, unknown>
  /** 幂等键——相同 key 重复调用不会创建多个节点 */
  idempotencyKey?: string
  /** 乐观并发控制：必须等于读取项目时得到的 graphVersion。 */
  expectedGraphVersion?: number
}

export interface UpdateNodeRequest {
  projectId: string
  nodeId: string
  title?: string
  params?: Record<string, unknown>
  /** 位置更新（仅桌面端有实际意义，headless 模式忽略） */
  position?: { x: number; y: number }
  expectedGraphVersion?: number
  idempotencyKey?: string
}

export interface ConnectNodesRequest {
  projectId: string
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
  idempotencyKey?: string
  expectedGraphVersion?: number
}

export interface ValidateWorkflowRequest {
  projectId: string
  /** 指定节点范围，空表示全部 */
  nodeIds?: string[]
}

export interface RunWorkflowRequest {
  projectId: string
  /** 指定节点范围 */
  nodeIds?: string[]
  /** 运行到指定节点为止（含） */
  toNodeId?: string
  /** 是否自动运行所有上游依赖 */
  includeUpstream?: boolean
  /** dry-run 模式：只返回预估，不实际执行 */
  dryRun?: boolean
  idempotencyKey?: string
}

export interface RunNodeRequest {
  projectId: string
  nodeId: string
  dryRun?: boolean
  idempotencyKey?: string
}

// ── 操作响应类型 ──────────────────────────────────────────

export interface ConnectionValidation {
  valid: boolean
  errors: string[]
  /** 连接的两端端口类型 */
  fromType?: PortType
  toType?: PortType
}

export interface WorkflowValidationResult {
  valid: boolean
  errors: Array<{
    nodeId?: string
    portId?: string
    message: string
    severity: 'error' | 'warning'
  }>
  stats: {
    nodeCount: number
    edgeCount: number
    inputIssues: number
    connectionIssues: number
  }
}

export interface RunEstimate {
  /** 将执行的节点数 */
  nodeCount: number
  /** 预计调用的模型列表 */
  models: Array<{ providerId: string; modelId: string; nodeId: string }>
  /** 缺失的必填配置 */
  missingConfigs: Array<{ nodeId: string; fields: string[] }>
  /** 风险提示 */
  risks: string[]
}

export interface RunHandle {
  runId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  scope: {
    type: 'node' | 'selection' | 'workflow'
    nodeIds?: string[]
  }
  startedAt: number
  finishedAt?: number
  durationMs?: number
  error?: { code: string; message: string }
}

// ── Run / Artifact 持久化 ─────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RunScopeType = 'node' | 'selection' | 'workflow'

/** 持久化的运行记录——一次工作流或节点执行的完整生命周期。 */
export interface RunRecord {
  runId: string
  projectId: string
  scope: { type: RunScopeType; nodeIds?: string[] }
  status: RunStatus
  actor: AuditActor
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  error?: { code: string; message: string }
  createdAt: number
}

/** 更新运行记录时可修改的字段。 */
export type RunUpdatePatch = Partial<
  Pick<RunRecord, 'status' | 'startedAt' | 'finishedAt' | 'durationMs' | 'error'>
>

/** 运行产出的单条记录——关联 Run 与 MediaAsset（或纯文本/JSON 产物）。 */
export interface RunArtifactRecord {
  artifactId: string
  runId: string
  projectId: string
  nodeId: string
  portId?: string
  mediaId?: string
  artifactType: 'image' | 'video' | 'audio' | 'text' | 'json' | 'file'
  mimeType?: string
  label?: string
  inputSummary?: Record<string, unknown>
  modelKey?: string
  createdAt: number
}

export interface ArtifactInfo {
  artifactId: string
  type: 'image' | 'video' | 'audio' | 'text' | 'json'
  mimeType: string
  width?: number
  height?: number
  durationSec?: number
  thumbnailUri?: string
  resourceUri: string
  sourceNodeId?: string
  createdAt: number
}

// ── 审计日志 ───────────────────────────────────────────────

export type AuditActor = 'user' | 'agent' | 'system'

export interface AuditEntry {
  timestamp: number
  actor: AuditActor
  action: string
  projectId?: string
  entityId?: string
  before?: unknown
  after?: unknown
  duration?: number
}

export interface AuditLog {
  entries: AuditEntry[]
  log(entry: Omit<AuditEntry, 'timestamp'>): void
  query(filter?: Partial<Pick<AuditEntry, 'actor' | 'action' | 'projectId'>>): AuditEntry[]
  clear(): void
}

// ── 事务 ──────────────────────────────────────────────────

export interface Transaction {
  id: string
  projectId: string
  operations: Array<{
    type: 'create-node' | 'update-node' | 'delete-node' | 'connect' | 'disconnect'
    data: unknown
  }>
  status: 'open' | 'committed' | 'aborted'
}

// ── 服务容器 ───────────────────────────────────────────────

/**
 * 服务上下文——所有服务共享同一个上下文实例。
 * 包含数据存储、权限、审计日志和事务管理。
 */
export interface ServiceContext {
  store: ProjectStore
  permission: Permission
  audit: AuditLog
  /** 仅在真正接入桌面项目事务层并获得显式授权时允许修改项目。 */
  writeEnabled: boolean
  /** 当前入口是否拥有可执行的无界面执行器。没有时必须拒绝，而非伪造 queued。 */
  executionEnabled: boolean
  /** 审计主体；CLI/MCP 都必须留下来源。 */
  actor: AuditActor
}
