/**
 * Capability Registry — 统一入口
 *
 * 导入此模块即自动注册全部能力定义。
 * 所有适配器（桌面端、CLI、MCP）都通过此模块访问能力信息。
 *
 * 用法：
 *   import { getCapability, listCapabilities } from '@/capabilities'
 */

// 类型导出
export type {
  Capability,
  CapabilityDefinition,
  CapabilityExpose,
  CapabilityPort,
  CapabilityCommands,
  CapabilityRuntime,
  ConfigSchema,
  ConfigFieldSchema,
  McpToolSchema,
  CliCommandSpec,
  CapabilityMatrixEntry,
  ContractSnapshot,
  SemVer,
  ChangeType
} from './types'
export { isAgentRunnable } from './types'

// 注册表 API
export {
  defineCapability,
  getCapability,
  getCapabilityByNodeType,
  getCapabilities,
  listCapabilities,
  isEmpty,
  clearRegistry,
  getSnapshots,
  getLatestSnapshot
} from './registry'

// 自动生成
export {
  generateMcpToolSchema,
  generateCliSpec,
  generateMatrixEntry,
  generateSnapshot,
  generateAll,
  diffSnapshots,
  isBreakingChange
} from './generate'
export type { GeneratedArtifacts, ContractDiff } from './generate'

// 能力定义（导入即注册）
export { capabilityDefinitions } from './definitions'

// ──────────────────────────────────────────────────────────
// 副作用导入：注册全部能力定义
// ──────────────────────────────────────────────────────────
import './definitions'
