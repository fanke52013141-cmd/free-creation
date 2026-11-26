import { loopBodyInfo, type FlowGraph, type FlowEdge, type FlowNode } from './flow-graph'
import {
  evaluateStageEntry,
  type StageCondition,
  type StageEntryFacts,
  type FlowStage
} from './stage-contracts'

type RoutingGraph = Pick<FlowGraph, 'entry' | 'exits' | 'nodes' | 'edges'>

/** 编译固定阶段的顺序依赖。阶段进入条件与输入仍使用原有的阶段标识。 */
export function compileFixedOrderRouting(stages: readonly FlowStage[]): RoutingGraph {
  const nodes: FlowNode[] = stages.map((stage) => ({
    nodeId: stage.nodeId,
    title: stage.stageKey,
    kind: 'agent',
    participation: stage.requireHumanDecision ? 'collaborative' : 'autonomous',
    goal: stage.goal,
    completion: stage.completion
  }))
  return {
    nodes,
    entry: stages[0]!.nodeId,
    exits: [stages[stages.length - 1]!.nodeId],
    edges: stages.slice(1).map((stage, index) => ({
      kind: 'data',
      from: { nodeId: stages[index]!.nodeId, portId: 'out-text' },
      to: { nodeId: stage.nodeId, portId: 'in-text' }
    }))
  }
}

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

type EdgeState = 'satisfied' | 'absent' | 'dead' | 'pending'
type RequiredInput = (nodeId: string, portId: string) => boolean

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

/** 已交付结果变化后，哪些步骤的输入、路由或循环退出条件可能随之变化。 */
export function graphReworkNodes(
  graph: FlowGraph,
  targetId: string,
  reviewDependencies: ReadonlyArray<readonly [sourceId: string, targetId: string]> = []
): Set<string> {
  if (!graph.nodes.some((node) => node.nodeId === targetId)) return new Set()

  const downstream = new Map<string, Set<string>>()
  const connect = (sourceId: string, nextId: string): void => {
    const targets = downstream.get(sourceId) ?? new Set<string>()
    targets.add(nextId)
    downstream.set(sourceId, targets)
  }
  const conditionSources = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    connect(edge.from.nodeId, edge.to.nodeId)
    const siblings = conditionSources.get(edge.from.nodeId) ?? new Set<string>()
    for (const condition of edge.condition ?? []) {
      const sourceId = conditionRef(condition)
      connect(sourceId, edge.to.nodeId)
      siblings.add(sourceId)
    }
    conditionSources.set(edge.from.nodeId, siblings)
  }
  for (const edge of graph.edges) {
    if (!edge.otherwise) continue
    for (const sourceId of conditionSources.get(edge.from.nodeId) ?? [])
      connect(sourceId, edge.to.nodeId)
  }
  for (const node of graph.nodes) {
    for (const selector of node.inputs?.selectors ?? [])
      connect(selector.sourceStageKey, node.nodeId)
    if (node.inputs?.summarySelector)
      connect(node.inputs.summarySelector.sourceStageKey, node.nodeId)
    for (const condition of node.loop?.exitCondition ?? [])
      connect(conditionRef(condition), node.nodeId)
  }
  for (const { carrierId, body } of loopBodyInfo(graph).values()) {
    for (const nodeId of body) {
      connect(carrierId, nodeId)
      connect(nodeId, carrierId)
    }
  }
  for (const [sourceId, nextId] of reviewDependencies) connect(sourceId, nextId)

  const affected = new Set([targetId])
  for (const nodeId of affected) {
    for (const nextId of downstream.get(nodeId) ?? []) affected.add(nextId)
  }
  return affected
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
  graph: RoutingGraph,
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
  graph: RoutingGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {},
  isRequiredInput?: RequiredInput,
  executionSkipped: ReadonlySet<string> = new Set()
): FlowRouteState {
  const settled = settledNodes(graph, facts, delivered, loopIterations)
  const skipped = new Set(executionSkipped)
  const skippedInputs = new Set(executionSkipped)
  const bodies = loopBodyInfo(graph)
  const carrierOf = new Map<string, string>()
  for (const [carrierId, info] of bodies)
    for (const nodeId of info.body) carrierOf.set(nodeId, carrierId)
  const resolved = (nodeId: string): boolean => settled.has(nodeId) || skipped.has(nodeId)
  const edgeState = (edge: FlowEdge): EdgeState => {
    const from = edge.from.nodeId
    if (skipped.has(from)) {
      if (skippedInputs.has(from) && !hasCondition(edge) && !edge.otherwise &&
          !isRequiredInput?.(edge.to.nodeId, edge.to.portId)) return 'absent'
      return 'dead'
    }
    // BL-11：同一循环体内的边按「本轮已交付」判定——循环载体要等退出条件才 settled，
    // 但 body 内的下游必须在本轮立即就绪，否则每轮都会停滞。
    const fromCarrier = carrierOf.get(from)
    const insideBody =
      fromCarrier !== undefined && fromCarrier === carrierOf.get(edge.to.nodeId)
    if (insideBody && !delivered.has(from)) return 'pending'
    if (!insideBody && !settled.has(from)) return 'pending'
    const conditionResolved = (nodeId: string): boolean =>
      resolved(nodeId) || (insideBody && delivered.has(nodeId))
    if (edge.otherwise) {
      let pending = false
      for (const sibling of graph.edges) {
        if (sibling === edge || sibling.from.nodeId !== from || !hasCondition(sibling)) continue
        if (conditionsSatisfied(sibling.condition!, facts)) return 'dead'
        if (!conditionsResolvable(sibling.condition!, conditionResolved)) pending = true
      }
      return pending ? 'pending' : 'satisfied'
    }
    if (!hasCondition(edge)) return 'satisfied'
    if (conditionsSatisfied(edge.condition!, facts)) return 'satisfied'
    return conditionsResolvable(edge.condition!, conditionResolved) ? 'dead' : 'pending'
  }
  let changed = true
  for (let guard = 0; changed && guard <= graph.nodes.length; guard++) {
    changed = false
    for (const node of graph.nodes) {
      if (node.nodeId === graph.entry || resolved(node.nodeId) || delivered.has(node.nodeId)) continue
      const allIncoming = graph.edges.filter((edge) => edge.to.nodeId === node.nodeId)
      const body = bodies.get(node.nodeId)
      // 循环载体的回边属于上一轮；判断本轮是否应整体跳过时不能使用它。
      const incoming = body
        ? allIncoming.filter((edge) => !body.body.has(edge.from.nodeId))
        : allIncoming
      const lostRequiredInput = incoming.some((edge) =>
        !hasCondition(edge) &&
        !edge.otherwise &&
        skipped.has(edge.from.nodeId) &&
        isRequiredInput?.(node.nodeId, edge.to.portId) &&
        incoming.every((alternate) =>
          alternate.to.portId !== edge.to.portId || edgeState(alternate) === 'dead'
        )
      )
      if (lostRequiredInput ||
          (incoming.length > 0 && incoming.every((edge) => edgeState(edge) === 'dead'))) {
        skipped.add(node.nodeId)
        if (lostRequiredInput) skippedInputs.add(node.nodeId)
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
  graph: RoutingGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {},
  isRequiredInput?: RequiredInput,
  executionSkipped?: ReadonlySet<string>
): FlowRouteResult {
  const { settled, skipped, edgeState } = flowRouteState(
    graph, facts, delivered, loopIterations, isRequiredInput, executionSkipped
  )
  const bodies = loopBodyInfo(graph)
  const ready: string[] = []
  const blocked: Array<{ nodeId: string; reason: string }> = []
  for (const node of graph.nodes) {
    if (settled.has(node.nodeId) || skipped.has(node.nodeId)) continue
    const body = bodies.get(node.nodeId)
    if (body) {
      // BL-11 / AF-8.4b 轮次作用域：循环载体的就绪只由**体外入边**决定；回边属于上一轮，
      // 新轮开始时忽略。每轮载体未交付即就绪（round ≥ 1）。
      const external = graph.edges.filter(
        (edge) => edge.to.nodeId === node.nodeId && !body.body.has(edge.from.nodeId)
      )
      const states = external.map(edgeState)
      const anySatisfied = states.includes('satisfied') || states.includes('absent')
      const anyPending = states.includes('pending')
      // 体外 dead 分支不参与本轮，但不能阻止另一个已满足分支进入循环。
      const externalReady = external.length === 0 || (node.joinPolicy === 'any'
        ? anySatisfied
        : anySatisfied && !anyPending)
      if (externalReady && !delivered.has(node.nodeId)) ready.push(node.nodeId)
      else if (!externalReady)
        blocked.push({
          nodeId: node.nodeId,
          reason: anyPending ? 'INCOMING_EDGES_PENDING' : 'INCOMING_EDGES_UNSATISFIED'
        })
      continue
    }
    const incoming = graph.edges.filter((edge) => edge.to.nodeId === node.nodeId)
    if (incoming.length === 0) {
      if (node.nodeId === graph.entry) {
        if (!delivered.has(node.nodeId)) ready.push(node.nodeId)
        else if (node.loop) ready.push(node.nodeId) // 入口循环未 settled，重复分派
      }
      continue
    }
    const states = incoming.map(edgeState)
    const anySatisfied = states.includes('satisfied') || states.includes('absent')
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
  graph: RoutingGraph,
  facts: StageEntryFacts,
  delivered: ReadonlySet<string>,
  loopIterations: Readonly<Record<string, number>> = {},
  isRequiredInput?: RequiredInput,
  executionSkipped?: ReadonlySet<string>
): boolean {
  const { settled, skipped } = flowRouteState(
    graph, facts, delivered, loopIterations, isRequiredInput, executionSkipped
  )
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

/** 循环退出条件是否成立（宿主在一轮 body 出口交付后据此决定是否再开一轮）。 */
export function loopExitConditionSatisfied(node: FlowNode, facts: StageEntryFacts): boolean {
  return !node.loop || conditionsSatisfied(node.loop.exitCondition, facts)
}
