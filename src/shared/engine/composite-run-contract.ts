import type { CompositeManifest } from '../composite/manifest'
import type { ContractInputMap } from '../engine/inputs'
import type { NodeValue } from '../engine/values'
import type { CancelSignal } from './executor-types'

export interface CompositeRunChainEntry {
  capabilityId: string
  version: string
}

/**
 * 嵌套运行的祖先上下文（W3）：chain 含调用方节点流自身，expandedNodes 为
 * 祖先链累计展开的内部节点数。顶层调用缺省；递归/深度/预算在运行期与发布期同口径拒绝。
 */
export interface CompositeRunContext {
  chain: CompositeRunChainEntry[]
  expandedNodes: number
}

export interface CompositeRunRequest {
  manifest: CompositeManifest
  inputs: ContractInputMap
  /** 外层运行 ID（父运行）；节点流自身每次调用拥有独立 runId。 */
  runId?: string
  /** 画布上的节点流实例 ID；用于运行记录关联到具体实例。 */
  instanceNodeId?: string
  signal?: CancelSignal
  /** 调用方节点流的祖先上下文；顶层调用缺省。 */
  parentContext?: CompositeRunContext
}

export interface CompositeRunFailure {
  /** 稳定错误码：INPUT_REQUIRED / REQUIRED_OUTPUT_MISSING / NODE_FAILED / ... */
  code: string
  /** input / step / output / runtime */
  phase: 'input' | 'step' | 'output' | 'runtime'
  /** 可定位的内部节点与端口（没有则为空）。 */
  nodeId?: string
  portId?: string
}

export interface CompositeRunOutcome {
  status: 'done' | 'failed'
  reason?: string
  /** 本次运行按公开输出 ID 收集的正式结果；不含未映射的内部结果。 */
  outputs?: Record<string, NodeValue>
  /** 兼容旧执行器的单一业务媒体产物。 */
  media?: { mediaId: string; mediaPath: string; mime: string }
  /** 内部运行摘要，供诊断/未来持久化使用，不进入公开端口。 */
  stepCount?: number
  failure?: CompositeRunFailure
}
