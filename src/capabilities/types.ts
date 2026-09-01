/**
 * Capability Registry 类型定义
 *
 * 这是整个系统的「单一事实来源」。所有入口（桌面端、CLI、MCP）的能力描述
 * 都从这份类型派生。任何输入、输出、设置项或执行语义的变化都必须在这里
 * 体现，并通过自动生成机制传播到各个适配器。
 *
 * 规则：禁止在页面组件、CLI 适配器或 MCP 适配器中单独定义业务规则。
 */

import type { PortType, PortCardinality, NodeTypeId, NodeExecutionMode } from '@shared/types'

// ── 暴露控制 ──────────────────────────────────────────────

/** 声明一项能力可以被哪些入口访问 */
export interface CapabilityExpose {
  /** 桌面端画布是否可见 */
  desktop: boolean
  /** CLI 是否可调用 */
  cli: boolean
  /** MCP 是否暴露给 Agent */
  mcp: boolean
}

// ── 配置 Schema ───────────────────────────────────────────

export type ConfigFieldType =
  'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'color' | 'rect'

/** 单个配置字段的 Schema 描述 */
export interface ConfigFieldSchema {
  type: ConfigFieldType
  required?: boolean
  defaultValue?: unknown
  /** type 为 enum 时的可选值 */
  enumValues?: string[]
  /** 字段语义说明（用于 MCP 工具描述、CLI 帮助、桌面端 tooltip） */
  description?: string
  /** object / array 类型的嵌套 Schema */
  properties?: Record<string, ConfigFieldSchema>
  /** array 元素类型 */
  items?: ConfigFieldSchema
  /** 数值范围 */
  minimum?: number
  maximum?: number
}

export type ConfigSchema = Record<string, ConfigFieldSchema>

// ── 端口描述 ───────────────────────────────────────────────

/** 能力端口描述（与 PortDecl 对齐，但独立于图数据层） */
export interface CapabilityPort {
  id: string
  name: string
  type: PortType
  required: boolean
  cardinality: PortCardinality
  description: string
}

// ── 命令映射 ───────────────────────────────────────────────

/** 能力关联的应用命令 ID（执行引擎据此分发） */
export interface CapabilityCommands {
  /** 主执行命令 */
  execute?: string
  /** 预览命令（不产生持久化结果） */
  preview?: string
  /** 自定义校验命令 */
  validate?: string
}

// ── 能力特性 ───────────────────────────────────────────────

/** 能力的运行时特性声明 */
export interface CapabilityRuntime {
  /** 是否支持无界面执行（headless） */
  headless: boolean
  /** 是否支持预览模式 */
  preview: boolean
  /** 是否支持批量处理 */
  batch: boolean
  /** 执行模式 */
  executionMode: NodeExecutionMode
  /**
   * 是否可被 Agent 无界面自动执行。manual-publish 节点（导演台、手动导入图片/音频）
   * 设为 false：它们只复用用户明确「发布」的结果，不可由 Agent 自动触发。
   * 省略时默认 true。
   */
  agentRunnable?: boolean
}

/** 判断一项能力是否可被 Agent 自动执行（省略 agentRunnable 时默认 true）。 */
export function isAgentRunnable(runtime: CapabilityRuntime): boolean {
  return runtime.agentRunnable ?? true
}

// ── 版本规则 ───────────────────────────────────────────────

/**
 * 能力版本（语义化版本）。
 * - patch: 实现优化、Bug 修复，契约不变
 * - minor: 增加可选参数或可选输出，向后兼容
 * - major: 删除字段、改变类型、改变语义（破坏性变更）
 */
export type SemVer = string // 格式: x.y.z

/** 契约变更类型 */
export type ChangeType = 'patch' | 'minor' | 'major'

// ── 完整能力定义 ───────────────────────────────────────────

/** 一项完整的能力定义——所有入口的唯一事实来源 */
export interface Capability {
  /** 能力 ID，格式为 category.name（如 image.crop） */
  id: string
  /** 语义化版本 */
  version: SemVer
  /** 契约版本号（用于历史项目兼容性检查） */
  contractVersion: number
  /** 对应的节点类型 ID */
  nodeType: NodeTypeId
  /** 用户可见名称 */
  title: string
  /** 能力描述（用于 MCP tool description 和 CLI help） */
  description: string
  /** 分类 */
  category: string
  /** 输入端口 */
  inputs: CapabilityPort[]
  /** 输出端口 */
  outputs: CapabilityPort[]
  /** 配置 Schema */
  configSchema: ConfigSchema
  /** 命令映射 */
  commands: CapabilityCommands
  /** 运行时特性 */
  runtime: CapabilityRuntime
  /** 暴露控制 */
  expose: CapabilityExpose
}

/** defineCapability() 的输入参数 */
export type CapabilityDefinition = Capability

// ── 自动生成产物类型 ──────────────────────────────────────

/** MCP 工具 Schema（JSON Schema 格式） */
export interface McpToolSchema {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

/** CLI 命令规格 */
export interface CliCommandSpec {
  command: string
  description: string
  options: Array<{
    name: string
    type: ConfigFieldType
    description?: string
    required: boolean
    defaultValue?: unknown
  }>
}

/** 能力矩阵条目 */
export interface CapabilityMatrixEntry {
  capability: string
  node: string
  nodeType: string
  version: SemVer
  contractVersion: number
  cli: boolean
  mcp: boolean
  inputs: number
  outputs: number
  headless: boolean
}

/** 契约快照（用于 diff 检测） */
export interface ContractSnapshot {
  capabilityId: string
  version: SemVer
  inputs: CapabilityPort[]
  outputs: CapabilityPort[]
  configSchema: ConfigSchema
  /** 仅供运行时审计；提交到 generated/ 的稳定产物会移除该字段。 */
  snapshotAt: number
}
