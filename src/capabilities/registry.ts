/**
 * Capability Registry 核心实现
 *
 * 提供能力注册、查询、版本管理和枚举功能。
 * 所有入口（桌面端、CLI、MCP）都通过这个注册表访问能力定义，
 * 禁止绕过注册表直接硬编码能力信息。
 */

import type {
  Capability,
  CapabilityDefinition,
  CapabilityExpose,
  ContractSnapshot
} from './types'

// ── 注册表内部状态 ─────────────────────────────────────────

const registry = new Map<string, Capability>()
const snapshots = new Map<string, ContractSnapshot[]>()

// ── 公开 API ──────────────────────────────────────────────

/**
 * 定义并注册一项能力。
 *
 * 这是整个系统的唯一入口：修改一项能力时，只需修改它的 defineCapability() 调用，
 * 桌面端 UI、CLI 参数、MCP Schema、校验器和测试都会自动反映变化。
 *
 * @throws 如果 id 格式不合法、版本不是语义化版本、或重复注册
 */
export function defineCapability(def: CapabilityDefinition): Capability {
  validateDefinition(def)

  const cap: Capability = { ...def }

  // 如果已有同 id 的能力且版本相同，跳过（支持热重载场景）
  const existing = registry.get(cap.id)
  if (existing && existing.version === cap.version) {
    registry.set(cap.id, cap)
    return cap
  }

  registry.set(cap.id, cap)

  // 自动保存契约快照
  recordSnapshot(cap)

  return cap
}

/** 获取指定 ID 的能力定义 */
export function getCapability(id: string): Capability | undefined {
  return registry.get(id)
}

/** 获取所有已注册的能力 */
export function listCapabilities(): Capability[]
/** 按暴露标志过滤能力 */
export function listCapabilities(filter: Partial<CapabilityExpose>): Capability[]
export function listCapabilities(filter?: Partial<CapabilityExpose>): Capability[] {
  const all = Array.from(registry.values())
  if (!filter) return all

  return all.filter((cap) => {
    if (filter.desktop !== undefined && cap.expose.desktop !== filter.desktop) return false
    if (filter.cli !== undefined && cap.expose.cli !== filter.cli) return false
    if (filter.mcp !== undefined && cap.expose.mcp !== filter.mcp) return false
    return true
  })
}

/** 按节点类型查找能力 */
export function getCapabilityByNodeType(nodeType: string): Capability | undefined {
  for (const cap of registry.values()) {
    if (cap.nodeType === nodeType) return cap
  }
  return undefined
}

/** 按 ID 列表批量获取能力 */
export function getCapabilities(ids: string[]): Capability[] {
  return ids.map((id) => registry.get(id)).filter((c): c is Capability => c !== undefined)
}

/** 注册表是否为空 */
export function isEmpty(): boolean {
  return registry.size === 0
}

/** 清空注册表（仅供测试使用） */
export function clearRegistry(): void {
  registry.clear()
  snapshots.clear()
}

// ── 契约快照 ───────────────────────────────────────────────

/** 获取指定能力的所有历史快照 */
export function getSnapshots(capabilityId: string): ContractSnapshot[] {
  return snapshots.get(capabilityId) ?? []
}

/** 获取最新快照 */
export function getLatestSnapshot(capabilityId: string): ContractSnapshot | undefined {
  const list = snapshots.get(capabilityId)
  if (!list || list.length === 0) return undefined
  return list[list.length - 1]
}

function recordSnapshot(cap: Capability): void {
  const snap: ContractSnapshot = {
    capabilityId: cap.id,
    version: cap.version,
    inputs: cap.inputs,
    outputs: cap.outputs,
    configSchema: cap.configSchema,
    snapshotAt: Date.now()
  }
  const list = snapshots.get(cap.id) ?? []
  list.push(snap)
  snapshots.set(cap.id, list)
}

// ── 校验 ──────────────────────────────────────────────────

function validateDefinition(def: CapabilityDefinition): void {
  if (!def.id || !def.id.includes('.')) {
    throw new Error(
      `[CapabilityRegistry] id 必须是 "category.name" 格式，收到: "${def.id}"`
    )
  }

  if (!def.version || !/^\d+\.\d+\.\d+$/.test(def.version)) {
    throw new Error(
      `[CapabilityRegistry] "${def.id}" version 必须是语义化版本 (x.y.z)，收到: "${def.version}"`
    )
  }

  if (!def.nodeType) {
    throw new Error(`[CapabilityRegistry] "${def.id}" 必须指定 nodeType`)
  }

  if (!def.title) {
    throw new Error(`[CapabilityRegistry] "${def.id}" 必须有 title`)
  }

  // 校验端口 ID 唯一性
  const portIds = new Set<string>()
  for (const port of [...def.inputs, ...def.outputs]) {
    if (portIds.has(port.id)) {
      throw new Error(
        `[CapabilityRegistry] "${def.id}" 端口 ID 重复: "${port.id}"`
      )
    }
    portIds.add(port.id)
  }
}
