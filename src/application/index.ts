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
export { ProjectService } from './services/project-service'
export { CapabilityService } from './services/capability-service'
export { InMemoryAuditLog } from './services/audit-log'

// 存储实现
export { FileProjectStore } from './stores/file-store'

// ── 服务容器工厂 ──────────────────────────────────────────

import type { ServiceContext, ProjectStore, Permission } from './types'
import { NodeService } from './services/node-service'
import { WorkflowService } from './services/workflow-service'
import { ProjectService } from './services/project-service'
import { CapabilityService } from './services/capability-service'
import { InMemoryAuditLog } from './services/audit-log'

export interface ServiceContainer {
  nodeService: NodeService
  workflowService: WorkflowService
  projectService: ProjectService
  capabilityService: CapabilityService
  auditLog: InMemoryAuditLog
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
  permission?: Partial<Permission>
): ServiceContainer {
  const auditLog = new InMemoryAuditLog()
  const defaultPermission: Permission = {
    level: 'execute',
    ...permission
  }

  const ctx: ServiceContext = {
    store,
    permission: defaultPermission,
    audit: auditLog
  }

  return {
    nodeService: new NodeService(ctx),
    workflowService: new WorkflowService(ctx),
    projectService: new ProjectService(ctx),
    capabilityService: new CapabilityService(ctx),
    auditLog
  }
}
