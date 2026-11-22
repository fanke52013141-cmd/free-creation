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
 * BL-03（2026-11-22）死路径消除：
 * - 边有三态：satisfied（源已落定且条件成立）/ dead（源已跳过，或源已落定且条件已可判定为不成立）/
 *   pending（源未落定，或条件引用的节点尚未落定）。
 * - 节点全部入边 dead → skipped（不会执行），并沿数据边向下游传播；skipped 视为已落定。
 * - 汇合 all（缺省）= 全部入边已落定（satisfied 或 dead）且至少一条 satisfied——XOR 分支汇合
 *   不再需要作者手写 any；any = 任一入边 satisfied。
 * - 流程完成 = 全部出口已落定（交付或跳过）且至少一个出口交付。
 * BL-04 `otherwise` 边：同源所有条件出边都已可判定且均不成立时 satisfied；任一成立时 dead。
 * 循环（P4）：循环节点交付后未 settled 前可重复分派；exitCondition 满足或达到 maxIterations
 * 即 settled。迭代计数由宿主运行态传入。
 */
export interface FlowRouteResult {
  ready: string[]
  blocked: Array<{ nodeId: string; reason: string }>
  /** BL-03：确定不会执行的节点（未选中的分支及只依赖它们的下游）。 */
  skipped: string[]
  /** BL-04：同一源节点有多条条件出边同时成立（多值交付命中多个互斥分支）——宿主应拒绝推进。 */
  ambiguous: string[]
}

type EdgeState = 'satisfied' | 'dead' | 'pending'

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

function conditionRef(condition: StageCondition): string {
  return condition.kind === 'review-passed' ? condition.reviewNodeId : condition.stageKey
}

/** 条件引用的节点全部已落定（交付或跳过）时，"不成立"才是终局结论，可据此判死边。 */
function conditionsResolvable(
  conditions: StageCondition[],
  resolved: (nodeId: string) => boolean
): boolean {
  return conditions.every((condition) => resolved(conditionRef(condition)))
}

const hasCondition = (edge: FlowEdge): boolean => (edge.condition?.length ?? 0) > 0

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

export interface FlowRouteState {
  settled: Set<string>
  skipped: Set<string>
  edgeState: (edge: FlowEdge) => EdgeState
}

/** BL-03：落定/跳过状态的不动点计算（图已无环；对未校验的环图也有界终止）。 */
export function flowRouteState(
  graph: FlowGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {}
): FlowRouteState {
  const settled = settledNodes(graph, facts, delivered, loopIterations)
  const skipped = new Set<string>()
  const resolved = (nodeId: string): boolean => settled.has(nodeId) || skipped.has(nodeId)
  const edgeState = (edge: FlowEdge): EdgeState => {
    const from = edge.from.nodeId
    if (skipped.has(from)) return 'dead'
    if (!settled.has(from)) return 'pending'
    if (edge.otherwise) {
      let pending = false
      for (const sibling of graph.edges) {
        if (sibling === edge || sibling.from.nodeId !== from || !hasCondition(sibling)) continue
        if (conditionsSatisfied(sibling.condition!, facts)) return 'dead'
        if (!conditionsResolvable(sibling.condition!, resolved)) pending = true
      }
      return pending ? 'pending' : 'satisfied'
    }
    if (!hasCondition(edge)) return 'satisfied'
    if (conditionsSatisfied(edge.condition!, facts)) return 'satisfied'
    return conditionsResolvable(edge.condition!, resolved) ? 'dead' : 'pending'
  }
  let changed = true
  for (let guard = 0; changed && guard <= graph.nodes.length; guard++) {
    changed = false
    for (const node of graph.nodes) {
      if (node.nodeId === graph.entry || resolved(node.nodeId) || delivered.has(node.nodeId)) continue
      const incoming = graph.edges.filter((edge) => edge.to.nodeId === node.nodeId)
      if (incoming.length > 0 && incoming.every((edge) => edgeState(edge) === 'dead')) {
        skipped.add(node.nodeId)
        changed = true
      }
    }
  }
  return { settled, skipped, edgeState }
}

/**
 * 计算下一批可分派节点。
 * - 入口节点（无入边）初始就绪；入口循环节点未 settled 前可重复分派；
 * - 其余节点按 joinPolicy 等待入边（见文件头 BL-03 语义）；
 * - 已 settled / skipped 节点不再分派；未 settled 的已交付循环节点可重复分派。
 */
export function nextReadyNodes(
  graph: FlowGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {}
): FlowRouteResult {
  const { settled, skipped, edgeState } = flowRouteState(graph, facts, delivered, loopIterations)
  const ready: string[] = []
  const blocked: Array<{ nodeId: string; reason: string }> = []
  for (const node of graph.nodes) {
    if (settled.has(node.nodeId) || skipped.has(node.nodeId)) continue
    const incoming = graph.edges.filter((edge) => edge.to.nodeId === node.nodeId)
    if (incoming.length === 0) {
      if (node.nodeId === graph.entry) {
        if (!delivered.has(node.nodeId)) ready.push(node.nodeId)
        else if (node.loop) ready.push(node.nodeId) // 入口循环未 settled，重复分派
      }
      continue
    }
    const states = incoming.map(edgeState)
    const anySatisfied = states.includes('satisfied')
    const anyPending = states.includes('pending')
    const joinPolicy = node.joinPolicy ?? 'all'
    const isReady = joinPolicy === 'any' ? anySatisfied : anySatisfied && !anyPending
    if (isReady) ready.push(node.nodeId)
    else
      blocked.push({
        nodeId: node.nodeId,
        reason: anyPending ? 'INCOMING_EDGES_PENDING' : 'INCOMING_EDGES_UNSATISFIED'
      })
  }
  // BL-04 运行期兜底：静态互斥按单值交付判定，多值交付可能同时命中多个分支。
  const ambiguous: string[] = []
  for (const source of settled) {
    const targets = new Set(
      graph.edges
        .filter(
          (edge) =>
            edge.from.nodeId === source && hasCondition(edge) && edgeState(edge) === 'satisfied'
        )
        .map((edge) => edge.to.nodeId)
    )
    if (targets.size > 1) ambiguous.push(source)
  }
  return { ready, blocked, skipped: [...skipped], ambiguous }
}

/** 流程完成 = 全部出口已落定（交付或跳过）且至少一个出口交付（循环出口须满足退出条件或达上限）。 */
export function isFlowComplete(
  graph: FlowGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {}
): boolean {
  const { settled, skipped } = flowRouteState(graph, facts, delivered, loopIterations)
  return (
    graph.exits.every((exit) => settled.has(exit) || skipped.has(exit)) &&
    graph.exits.some((exit) => settled.has(exit))
  )
}

/**
 * BL-06 / AF-8.1a 图模式交付判定：子任务 completed 即交付，**不要求产出非空**——可选输出
 * 本次不产出是合法完成；输出是否满足要求由下游 required 输入判定。
 */
export function deliveredGraphNodes(
  children: ReadonlyArray<{ nodeId: string; state: string }>
): Set<string> {
  return new Set(children.filter((child) => child.state === 'completed').map((child) => child.nodeId))
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
