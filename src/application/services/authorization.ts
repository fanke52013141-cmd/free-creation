import type { Permission, PermissionLevel, ServiceContext } from '../types'

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  read: 0,
  edit: 1,
  execute: 2,
  admin: 3
}

export function authorize(
  ctx: ServiceContext,
  required: PermissionLevel,
  capabilityId?: string
): string | null {
  if (PERMISSION_RANK[ctx.permission.level] < PERMISSION_RANK[required]) {
    return `当前入口只有 ${ctx.permission.level} 权限，执行此操作至少需要 ${required} 权限`
  }
  if (capabilityId && ctx.permission.deniedCapabilities?.includes(capabilityId)) {
    return `当前入口不允许使用能力: ${capabilityId}`
  }
  if (
    capabilityId &&
    ctx.permission.allowedCapabilities &&
    !ctx.permission.allowedCapabilities.includes(capabilityId)
  ) {
    return `当前入口未获授权使用能力: ${capabilityId}`
  }
  return null
}

export function requireWrite(ctx: ServiceContext, capabilityId?: string): string | null {
  if (!ctx.writeEnabled) {
    return 'Agent 写入已安全关闭：桌面画布快照事务尚未启用。可使用读取、契约查询和 dry-run。'
  }
  return authorize(ctx, 'edit', capabilityId)
}

export function requireExecution(ctx: ServiceContext, capabilityId?: string): string | null {
  if (!ctx.executionEnabled) {
    return '当前入口未接入无界面执行器。请使用 dry-run，或在桌面端运行工作流。'
  }
  return authorize(ctx, 'execute', capabilityId)
}

export function permissionForReadOnlyAgent(): Permission {
  return { level: 'read' }
}
