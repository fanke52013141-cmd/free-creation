/**
 * Application Service Layer — 统一入口
 *
 * 所有适配器（桌面端、CLI、MCP）都通过此模块访问应用服务。
 * 创建服务实例时，传入不同的 ProjectStore 实现即可适配不同运行环境。
 */

// 类型导出
export type {
  Result,
  ServiceError,
  ProjectStore,
  PermissionLevel,
  Permission,
  ServiceContext,
  CreateNodeRequest,
  UpdateNodeRequest,
  ConnectNodesRequest,
  ValidateWorkflowRequest,
  RunWorkflowRequest,
  RunNodeRequest,
  ConnectionValidation,
  WorkflowValidationResult,
  RunEstimate,
  RunHandle,
  RunStatus,
  RunScopeType,
  RunRecord,
  RunUpdatePatch,
  RunArtifactRecord,
  ArtifactInfo,
  AuditActor,
  AuditEntry,
  AuditLog,
  Transaction
} from './types'
export { ok, fail, unwrap } from './types'

// 服务实现
export { NodeService, isPortTypeCompatible } from './services/node-service'
export { WorkflowService } from './services/workflow-service'
export { RunService } from './services/run-service'
export { ProjectService } from './services/project-service'
export { CapabilityService } from './services/capability-service'
export { InMemoryAuditLog } from './services/audit-log'
export {
  authorize,
  requireWrite,
  requireExecution,
  permissionForReadOnlyAgent
} from './services/authorization'

// 存储实现
export { FileProjectStore } from './stores/file-store'
export { DesktopProjectStore } from './stores/desktop-store'

// 图写入事务共享协议
export { GraphVersionConflictError, syncGraphSnapshot } from '@shared/graph-snapshot-sync'

// ── 服务容器工厂 ──────────────────────────────────────────

import type { ServiceContext, ProjectStore, Permission } from './types'
import { NodeService } from './services/node-service'
import { WorkflowService } from './services/workflow-service'
import { RunService } from './services/run-service'
import { ProjectService } from './services/project-service'
import { CapabilityService } from './services/capability-service'
import { InMemoryAuditLog } from './services/audit-log'

export interface ServiceContainer {
  nodeService: NodeService
  workflowService: WorkflowService
  runService: RunService
  projectService: ProjectService
  capabilityService: CapabilityService
  auditLog: InMemoryAuditLog
}

export interface ServiceOptions {
  permission?: Partial<Permission>
  writeEnabled?: boolean
  executionEnabled?: boolean
  actor?: 'user' | 'agent' | 'system'
}

/**
 * 创建服务容器。
 *
 * @param store 数据存储实现
 * @param permission 权限配置
 * @returns 包含所有服务的容器
 */
export function createServices(
  store: ProjectStore,
  options: ServiceOptions = {}
): ServiceContainer {
  const auditLog = new InMemoryAuditLog()
  const defaultPermission: Permission = {
    level: 'execute',
    ...options.permission
  }

  const ctx: ServiceContext = {
    store,
    permission: defaultPermission,
    audit: auditLog,
    // 保持内存测试和桌面内部调用的现有行为；外部入口必须显式传 false/true。
    writeEnabled: options.writeEnabled ?? true,
    executionEnabled: options.executionEnabled ?? true,
    actor: options.actor ?? 'agent'
  }

  return {
    nodeService: new NodeService(ctx),
    workflowService: new WorkflowService(ctx),
    runService: new RunService(ctx),
    projectService: new ProjectService(ctx),
    capabilityService: new CapabilityService(),
    auditLog
  }
}

/**
 * 受控 Agent 草稿写入开关：CANVAS_AGENT_WRITE=draft 时外部入口（CLI/MCP）
 * 才允许修改项目。图写入事务（快照同步 + 乐观锁 + 回滚）落地前该开关必须
 * 保持关闭，避免出现"图数据存在、画布不可见、下次保存被覆盖"。
 */
export function agentWriteEnabledFromEnv(
  value: string | undefined = process.env.CANVAS_AGENT_WRITE
): boolean {
  return value === 'draft'
}
