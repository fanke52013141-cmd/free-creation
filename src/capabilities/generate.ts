/**
 * 自动生成层
 *
 * 从 Capability Registry 自动生成各入口所需的描述文件。
 * 这确保了「一套定义，多个入口」——修改能力定义后，所有入口自动同步。
 *
 * CI 流程应执行 generateAll() 并检查产物是否与已提交版本一致，
 * 如果存在差异则构建失败（防止开发者修改了契约却忘记更新生成文件）。
 */

import type {
  Capability,
  McpToolSchema,
  CliCommandSpec,
  CapabilityMatrixEntry,
  ContractSnapshot
} from './types'
import { listCapabilities } from './registry'

// ── 单项生成 ───────────────────────────────────────────────

/**
 * 从能力定义生成 MCP 工具 Schema。
 *
 * 注意：MCP 使用通用工具（create_node, configure_node 等），
 * 这里的 per-capability schema 仅用于动态参数校验和文档生成，
 * 不是为每个节点创建独立的 MCP 工具。
 */
export function generateMcpToolSchema(cap: Capability): McpToolSchema {
  const properties: Record<string, unknown> = {}

  for (const [key, field] of Object.entries(cap.configSchema)) {
    const prop: Record<string, unknown> = {
      type: jsonSchemaType(field.type),
      description: field.description ?? ''
    }
    if (field.enumValues) prop.enum = field.enumValues
    if (field.defaultValue !== undefined) prop.default = field.defaultValue
    if (field.minimum !== undefined) prop.minimum = field.minimum
    if (field.maximum !== undefined) prop.maximum = field.maximum
    properties[key] = prop
  }

  return {
    name: `node.${cap.nodeType}`,
    description: `${cap.title} — ${cap.description}`,
    inputSchema: {
      type: 'object',
      properties,
      required: Object.entries(cap.configSchema)
        .filter(([, f]) => f.required)
        .map(([key]) => key)
    }
  }
}

/** 从能力定义生成 CLI 命令规格 */
export function generateCliSpec(cap: Capability): CliCommandSpec {
  return {
    command: cap.nodeType,
    description: `${cap.title}: ${cap.description}`,
    options: Object.entries(cap.configSchema).map(([key, field]) => ({
      name: `--${key}`,
      type: field.type,
      description: field.description,
      required: field.required ?? false,
      defaultValue: field.defaultValue
    }))
  }
}

/** 从能力定义生成能力矩阵条目 */
export function generateMatrixEntry(cap: Capability): CapabilityMatrixEntry {
  return {
    capability: cap.id,
    node: cap.title,
    nodeType: cap.nodeType,
    version: cap.version,
    contractVersion: cap.contractVersion,
    cli: cap.expose.cli,
    mcp: cap.expose.mcp,
    inputs: cap.inputs.length,
    outputs: cap.outputs.length,
    headless: cap.runtime.headless
  }
}

/** 从能力定义生成契约快照 */
export function generateSnapshot(cap: Capability): ContractSnapshot {
  return {
    capabilityId: cap.id,
    version: cap.version,
    inputs: cap.inputs,
    outputs: cap.outputs,
    configSchema: cap.configSchema,
    snapshotAt: Date.now()
  }
}

// ── 批量生成 ───────────────────────────────────────────────

export interface GeneratedArtifacts {
  mcpTools: McpToolSchema[]
  cliCommands: CliCommandSpec[]
  capabilityMatrix: CapabilityMatrixEntry[]
  snapshots: ContractSnapshot[]
  /** 仅供运行时审计；提交到 generated/ 的稳定产物会移除该字段。 */
  generatedAt: number
}

/**
 * 从当前注册表生成全部产物。
 * CI 脚本调用此函数，将结果写入 generated/ 目录，并检查是否有未提交差异。
 */
export function generateAll(): GeneratedArtifacts {
  const caps = [...listCapabilities()].sort((a, b) => a.id.localeCompare(b.id))
  return {
    mcpTools: caps.map(generateMcpToolSchema),
    cliCommands: caps.map(generateCliSpec),
    capabilityMatrix: caps.map(generateMatrixEntry),
    snapshots: caps.map(generateSnapshot),
    generatedAt: Date.now()
  }
}

function jsonSchemaType(type: string): string {
  switch (type) {
    case 'enum':
    case 'color':
      return 'string'
    case 'rect':
      return 'object'
    default:
      return type
  }
}

// ── 契约差异检测 ──────────────────────────────────────────

export interface ContractDiff {
  capabilityId: string
  changes: Array<{
    type: 'added' | 'removed' | 'modified'
    path: string
    before?: unknown
    after?: unknown
  }>
}

/**
 * 比较两个契约快照的差异。
 * 用于检测能力定义变更是否引入了破坏性变化。
 */
export function diffSnapshots(oldSnap: ContractSnapshot, newSnap: ContractSnapshot): ContractDiff {
  const changes: ContractDiff['changes'] = []

  // 比较输入端口
  diffPorts(oldSnap.inputs, newSnap.inputs, 'inputs', changes)
  // 比较输出端口
  diffPorts(oldSnap.outputs, newSnap.outputs, 'outputs', changes)
  // 比较配置 Schema
  diffConfigSchema(oldSnap.configSchema, newSnap.configSchema, 'config', changes)

  return { capabilityId: newSnap.capabilityId, changes }
}

function diffPorts(
  oldPorts: ContractSnapshot['inputs'],
  newPorts: ContractSnapshot['inputs'],
  prefix: string,
  changes: ContractDiff['changes']
): void {
  const oldMap = new Map(oldPorts.map((p) => [p.id, p]))
  const newMap = new Map(newPorts.map((p) => [p.id, p]))

  for (const [id, port] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ type: 'added', path: `${prefix}.${id}`, after: port })
    }
  }
  for (const [id, port] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({ type: 'removed', path: `${prefix}.${id}`, before: port })
    }
  }
  for (const [id, oldPort] of oldMap) {
    const newPort = newMap.get(id)
    if (!newPort) continue
    if (oldPort.type !== newPort.type) {
      changes.push({
        type: 'modified',
        path: `${prefix}.${id}.type`,
        before: oldPort.type,
        after: newPort.type
      })
    }
    if (oldPort.required !== newPort.required) {
      changes.push({
        type: 'modified',
        path: `${prefix}.${id}.required`,
        before: oldPort.required,
        after: newPort.required
      })
    }
  }
}

function diffConfigSchema(
  oldSchema: Record<string, unknown>,
  newSchema: Record<string, unknown>,
  prefix: string,
  changes: ContractDiff['changes']
): void {
  const oldKeys = new Set(Object.keys(oldSchema))
  const newKeys = new Set(Object.keys(newSchema))

  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      changes.push({ type: 'added', path: `${prefix}.${key}`, after: newSchema[key] })
    }
  }
  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      changes.push({ type: 'removed', path: `${prefix}.${key}`, before: oldSchema[key] })
    }
  }
}

/** 判断差异是否为破坏性变更 */
export function isBreakingChange(diff: ContractDiff): boolean {
  return diff.changes.some((c) => {
    if (c.type === 'removed') return true
    if (c.type === 'modified' && c.path.endsWith('.type')) return true
    if (c.type === 'modified' && c.path.endsWith('.required') && c.after === true) return true
    return false
  })
}
