// 节点执行器统一接口（从 renderer/executor-types.ts 移入共享层）
//
// 依赖方向（单向 DAG，无循环）：
//   executors ← executor-types ← gateway-client ← shared/types
//
// 关键变化：NodeExecutionContext 新增 gateway 字段，执行器通过依赖注入
// 获得 GatewayClient，不再直接访问 window.api。
import type { CanvasNode, ProviderSummary } from '../types'
import type { GatewayClient } from './gateway-client'
import type { ContractInputMap, ContractOutputs } from './inputs'

/**
 * 共享层节点形状接口。renderer 的 NodeCardShape（tldraw TLBaseShape）满足此接口；
 * headless 执行路径构造一个等价的纯数据对象即可。
 */
export interface NodeShape {
  props: {
    nodeType: string
    title: string
    config: string
    text: string
    mediaId: string
    mediaPath: string
    mediaMime: string
    exec: string
    w: number
    h: number
  }
  meta?: {
    nodeRun?: unknown
    nodeResult?: string
  }
}

/** 运行控制信号。暂停在当前原子任务结束后生效；停止会解除暂停等待。 */
export interface CancelSignal {
  readonly cancelled: boolean
  readonly paused?: boolean
}

/**
 * 子流程执行请求（循环控制节点用）。循环节点为列表里每一项构造该请求，
 * 运行器据此执行「循环体」节点链：对当前项执行一次，返回各节点输出。
 */
export interface SubflowRequest {
  nodeIds: string[]
  item: Record<string, unknown>
  index: number
  itemId?: string
  itemRunId?: string
  iterationNodeId?: string
  itemTargets?: Array<{ nodeId: string; portId: string }>
}

export type SubflowOutput = Record<string, ContractOutputs>

/**
 * 执行器拿到的上下文：运行器为每个节点组装一次，包含执行所需的全部只读输入与受控写入入口。
 *
 * gateway 字段是 P3 新增：执行器通过此接口调用模型网关（聊天/生图/视频/音频），
 * 而不是直接访问 window.api。renderer 运行器注入 IPC 包装，headless 运行器注入
 * 直接调用 main/gateway 模块的实现。
 */
export interface NodeExecutionContext {
  node: CanvasNode
  shape: NodeShape
  inputs: ContractInputMap
  projectId: string
  runId?: string
  providers: ProviderSummary[]
  signal: CancelSignal
  /** 模型网关客户端（P3）：替代执行器中对 window.api.gateway 的直接调用。 */
  gateway: GatewayClient
  /**
   * 代码执行入口（P3）：renderer 注入 Web Worker 实现，headless 可注入 Node.js vm 实现。
   * 代码节点执行器通过此函数执行用户代码，不直接导入 renderer 的 codeRuntime 模块。
   */
  runCode?: (
    source: string,
    args: Record<string, unknown>
  ) => Promise<{ kind: 'text'; text: string } | { kind: 'json'; data: unknown }>
  waitForResume?: () => Promise<void>
  updateProps: (patch: Partial<NodeShape['props']>) => void
  updateResult: (result: string | null) => void
  outgoing?: Array<{ nodeId: string; fromPortId: string; toPortId: string }>
  runSubflow?: (request: SubflowRequest) => Promise<SubflowOutput>
  restoreSubflowInputs?: (request: Pick<SubflowRequest, 'nodeIds' | 'iterationNodeId'>) => void
}

export interface NodeExecutionResult {
  status: 'done' | 'skipped' | 'failed'
  reason?: string
}

export type NodeExecutor = (
  ctx: NodeExecutionContext
) => Promise<NodeExecutionResult> | NodeExecutionResult
