import type { FlowGraph, FlowEdge, FlowNode } from './flow-graph'
import {
  evaluateStageEntry,
  type StageCondition,
  type StageEntryFacts,
  type FlowStage
} from './stage-contracts'

/**
 * O4-P3/P4 声明式图路由器（纯函数）。
 *
 * 铁律：路由只认**已交付事实**（StageEntryFacts，来自权威资产/账本）+ **声明式条件**
 * （StageCondition，复用 evaluateStageEntry 解释）。本模块不接收任何模型文字输入——
 * 模型只能在节点内部决策，不能改变图路由。条件不执行任意脚本（沿用 AF-01 安全边界）。
 *
 * 汇合：节点 joinPolicy='all'（缺省，所有入边满足）/ 'any'（任一入边满足）。
 * 循环（P4）：循环节点交付后未" settles"前可重复分派；exitCondition 满足或达到
 * maxIterations 即 settled（对下游视为已交付）。迭代计数由宿主运行态传入。
 */
export interface FlowRouteResult {
  ready: string[]
  blocked: Array<{ nodeId: string; reason: string }>
}

/** 复用 AF-01 条件解释器：把条件当作一个伪阶段的 entry 求值（全满足才 true）。 */
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

function edgeSatisfied(
  edge: FlowEdge,
  facts: StageEntryFacts,
  settled: ReadonlySet<string>
): boolean {
  if (!settled.has(edge.from.nodeId)) return false
  return conditionsSatisfied(edge.condition ?? [], facts)
}

/**
 * 已"settled"节点（对下游路由视为已交付）：
 * - 非循环节点：已交付即 settled；
 * - 循环节点：已交付且（exitCondition 满足 或 迭代数 ≥ maxIterations）才 settled。
 * 未 settled 的循环节点仍可重复分派，其下游边不触发。
 */
export function settledNodes(
  graph: FlowGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {}
): Set<string> {
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]))
  const settled = new Set<string>()
  for (const nodeId of delivered) {
    const node = nodeById.get(nodeId)
    if (!node?.loop) {
      settled.add(nodeId)
      continue
    }
    const iterations = loopIterations[nodeId] ?? 0
    if (conditionsSatisfied(node.loop.exitCondition, facts) || iterations >= node.loop.maxIterations)
      settled.add(nodeId)
  }
  return settled
}

/**
 * 计算下一批可分派节点。
 * - 入口节点（无入边）初始就绪；入口循环节点未 settled 前可重复分派；
 * - 其余节点按 joinPolicy 等待入边满足（入边源须 settled）；
 * - 已 settled 节点不再分派；未 settled 的已交付循环节点可重复分派。
 */
export function nextReadyNodes(
  graph: FlowGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {}
): FlowRouteResult {
  const settled = settledNodes(graph, facts, delivered, loopIterations)
  const ready: string[] = []
  const blocked: Array<{ nodeId: string; reason: string }> = []
  for (const node of graph.nodes) {
    if (settled.has(node.nodeId)) continue
    const incoming = graph.edges.filter(
      (edge) => edge.kind === 'data' && edge.to.nodeId === node.nodeId
    )
    if (incoming.length === 0) {
      if (node.nodeId === graph.entry) {
        if (!delivered.has(node.nodeId)) ready.push(node.nodeId)
        else if (node.loop) ready.push(node.nodeId) // 入口循环未 settled，重复分派
      }
      continue
    }
    const satisfied = incoming.map((edge) => edgeSatisfied(edge, facts, settled))
    const joinPolicy = node.joinPolicy ?? 'all'
    const isReady = joinPolicy === 'any' ? satisfied.some(Boolean) : satisfied.every(Boolean)
    if (isReady) ready.push(node.nodeId)
    else blocked.push({ nodeId: node.nodeId, reason: 'INCOMING_EDGES_UNSATISFIED' })
  }
  return { ready, blocked }
}

/** 流程完成 = 所有出口节点已 settled（循环出口须满足退出条件或达上限）。 */
export function isFlowComplete(
  graph: FlowGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {}
): boolean {
  const settled = settledNodes(graph, facts, delivered, loopIterations)
  return graph.exits.every((exit) => settled.has(exit))
}

/** 循环节点是否仍可重复分派（已交付但未 settled）。宿主据此决定是否再分派。 */
export function loopNeedsAnotherIteration(
  node: FlowNode,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {}
): boolean {
  if (!node.loop || !delivered.has(node.nodeId)) return false
  const iterations = loopIterations[node.nodeId] ?? 0
  return (
    !conditionsSatisfied(node.loop.exitCondition, facts) && iterations < node.loop.maxIterations
  )
}