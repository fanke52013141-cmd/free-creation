import type { FlowGraph, FlowEdge } from './flow-graph'
import {
  evaluateStageEntry,
  type StageCondition,
  type StageEntryFacts,
  type FlowStage
} from './stage-contracts'

/**
 * O4-P3 声明式图路由器（纯函数）。
 *
 * 铁律：路由只认**已交付事实**（StageEntryFacts，来自权威资产/账本）+ **声明式条件**
 * （StageCondition，复用 evaluateStageEntry 解释）。本模块不接收任何模型文字输入——
 * 模型只能在节点内部决策，不能改变图路由。条件不执行任意脚本（沿用 AF-01 安全边界）。
 *
 * 汇合：节点 joinPolicy='all'（缺省，所有入边满足）/ 'any'（任一入边满足，条件分支汇合常用）。
 * 循环执行（迭代计数/exitCondition 强制退出）属 P4；本阶段路由顺序+条件+汇合。
 */
export interface FlowRouteResult {
  /** 可分派的节点（入边条件已满足且未交付）。 */
  ready: string[]
  /** 尚未就绪的节点及稳定原因（不静默放行）。 */
  blocked: Array<{ nodeId: string; reason: string }>
}

/** 复用 AF-01 条件解释器：把边条件当作一个伪阶段的 entry 求值（全满足才 true）。 */
function conditionsSatisfied(conditions: StageCondition[], facts: StageEntryFacts): boolean {
  if (conditions.length === 0) return true
  const pseudoStage = {
    stageKey: '__edge__',
    nodeId: '__edge__',
    goal: 'edge',
    completion: 'edge',
    requireHumanDecision: false,
    entry: conditions
  } as FlowStage
  return evaluateStageEntry(pseudoStage, facts).ok
}

/** 入边满足 = 源节点已交付 + 边条件全满足。只读事实，不接受模型文字。 */
function edgeSatisfied(
  edge: FlowEdge,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>
): boolean {
  if (!delivered.has(edge.from.nodeId)) return false
  return conditionsSatisfied(edge.condition ?? [], facts)
}

/**
 * 计算下一批可分派节点。
 * - 入口节点（无入边）初始就绪；
 * - 其余节点按 joinPolicy 等待入边满足（all=全部，any=任一）；
 * - 已交付节点不再分派。
 */
export function nextReadyNodes(
  graph: FlowGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>
): FlowRouteResult {
  const ready: string[] = []
  const blocked: Array<{ nodeId: string; reason: string }> = []
  for (const node of graph.nodes) {
    if (delivered.has(node.nodeId)) continue
    const incoming = graph.edges.filter(
      (edge) => edge.kind === 'data' && edge.to.nodeId === node.nodeId
    )
    if (incoming.length === 0) {
      if (node.nodeId === graph.entry) ready.push(node.nodeId)
      continue
    }
    const satisfied = incoming.map((edge) => edgeSatisfied(edge, facts, delivered))
    const joinPolicy = node.joinPolicy ?? 'all'
    const isReady = joinPolicy === 'any' ? satisfied.some(Boolean) : satisfied.every(Boolean)
    if (isReady) ready.push(node.nodeId)
    else blocked.push({ nodeId: node.nodeId, reason: 'INCOMING_EDGES_UNSATISFIED' })
  }
  return { ready, blocked }
}

/** 流程完成 = 所有出口节点已交付。 */
export function isFlowComplete(graph: FlowGraph, delivered: ReadonlySet<string>): boolean {
  return graph.exits.every((exit) => delivered.has(exit))
}