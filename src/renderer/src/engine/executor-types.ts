// 节点执行器统一接口（契约规范 P3 / 路线图 R1）
//
// 目标：把原 executor.ts 里按 nodeType 分发的巨型 switch 拆成各节点自注册的执行器，
// 新增普通节点时只需新增 Spec + Body + Executor，不再修改核心运行器。
//
// 依赖方向（单向 DAG，无循环）：
//   registry.tsx  ←  specs/index.tsx  ←  各节点执行器
//        ↑                                      ↓
//   contracts.ts ──────────────────────────────┘（执行器复用输入工具）
// 本文件只定义类型；registry 用 `import type` 引用，运行时不新增依赖。
import type { CanvasNode, ProviderConfig } from '@shared/types'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import type { ContractInputMap, ContractOutputs } from './contracts'

/** 取消信号。运行器在收到停止指令时把 cancelled 置 true，执行器据此中止长任务。 */
export interface CancelSignal {
  readonly cancelled: boolean
}

/**
 * 子流程执行请求（循环控制节点用）。循环节点为列表里每一项构造该请求，
 * 运行器据此执行「循环体」节点链：对当前项执行一次，返回各节点输出。
 */
export interface SubflowRequest {
  /** 循环体节点 id 链（按拓扑顺序执行）；空数组表示无循环体。 */
  nodeIds: string[]
  /** 当前列表项的变量环境，注入为循环体节点的输入。 */
  item: Record<string, unknown>
  /** 当前项在列表里的序号（用于进度/来源追踪）。 */
  index: number
  /** 当前项的可选稳定 id（如镜头 id），用于来源追踪。 */
  itemId?: string
}

/** 子流程执行的输出：循环体各节点产出的契约输出（key 为节点 id）。 */
export type SubflowOutput = Record<string, ContractOutputs>

/**
 * 执行器拿到的上下文：运行器为每个节点组装一次，包含执行所需的全部只读输入与受控写入入口。
 *
 * 写入约定：执行产生的持久化状态通过 updateProps / updateResult 写回 shape，
 * 运行器在执行结束后重新读取 shape 并经 projectNodeOutputs 投影成端口输出。
 * 因此执行器不应自行缓存或返回输出数据包——投影是运行器的统一职责。
 */
export interface NodeExecutionContext {
  /** 节点契约声明（端口、类型、契约版本）。 */
  node: CanvasNode
  /** 执行开始时的 tldraw shape 快照（含 props 持久化状态与 meta 运行结果）。 */
  shape: NodeCardShape
  /** 已收集并校验的上游输入，键为输入 portId。 */
  inputs: ContractInputMap
  projectId: string
  providers: ProviderConfig[]
  /** 取消信号。 */
  signal: CancelSignal
  /** 把执行产生的持久化状态写回 shape props（合并文本、媒体资产引用等）。 */
  updateProps: (patch: Partial<NodeCardShape['props']>) => void
  /** 把命名变量运行结果写入 shape meta（处理 / 代码节点使用）。传 null 清空。 */
  updateResult: (result: string | null) => void
  /**
   * 当前节点的直接下游节点 id（通用图信息，运行器对每个节点填充）。循环控制节点
   * 用这批节点作为「循环体」，对列表每一项驱动它们执行一次。
   */
  downstream?: string[]
  /**
   * 执行一条子流程（循环控制节点用）：运行器对请求的循环体节点链执行一次并返回输出。
   * 非循环节点不会注入。循环节点用它把列表逐项填充进下游子流程变量。
   */
  runSubflow?: (request: SubflowRequest) => Promise<SubflowOutput>
}

export interface NodeExecutionResult {
  /** done：执行成功；skipped：缺输入或无需运行；failed：执行报错。 */
  status: 'done' | 'skipped' | 'failed'
  /** skipped / failed 时给用户的简短原因。 */
  reason?: string
}

/**
 * 节点自注册执行器（契约规范 P3）。
 *
 * 定义为函数类型别名：节点只需导出一个形如 `(ctx) => result` 的函数即可注入到
 * Spec 的 executor 字段，运行器按 nodeType 取出并调用。语义等价于
 * `interface NodeExecutor { execute(ctx): result }`，但裸函数形式更简洁，
 * 节点目录无需多一层对象包装。
 *
 * 执行器只负责本节点的能力；输入收集、契约校验、输出投影与登记全部由运行器
 * 统一处理，执行器内禁止再写 `if (nodeType === ...)` 式分支或猜测上游节点类型。
 */
export type NodeExecutor = (
  ctx: NodeExecutionContext
) => Promise<NodeExecutionResult> | NodeExecutionResult
