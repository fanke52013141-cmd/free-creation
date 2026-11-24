import { z } from 'zod'
import { StageConditionSchema, StageInputsSchema, type StageCondition } from './stage-contracts'
import { canonicalFlowJson } from './semantic-revision'
import {
  buildCapabilityCatalog,
  findCapability,
  participationRank,
  parseLegacyCapability,
  type CapabilityDescriptor,
  type CapabilityRef
} from './capability-catalog'

/**
 * O4-P1 FlowGraph：可序列化流程解释器 IR（纯共享协议，main 不导入 React）。
 *
 * 设计原则：最大化复用 AF-01/02 既有契约——
 * - 最小必要输入复用 StageInputsSchema（ContextSelector，AF-02）；
 * - 条件复用 StageConditionSchema（声明式，evaluateStageEntry 解释，不执行脚本）；
 * - 节点目标/完成条件语义沿用 FlowStage（固定目标，不由模型补写）。
 *
 * 本文件只做 schema + 静态校验（纯函数），不接执行。编译（P2）与图路由执行（P3+）后续。
 * 三形态统一声明 participation；循环必须有界（loop.maxIterations），无界环静态拒绝。
 */
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)

export const FlowParticipationSchema = z.enum(['autonomous', 'collaborative', 'human'])
export type FlowParticipation = z.infer<typeof FlowParticipationSchema>

export const FlowNodeKindSchema = z.enum([
  'agent',
  'human-task',
  'capability',
  'review',
  'state-machine'
])
export type FlowNodeKind = z.infer<typeof FlowNodeKindSchema>

/**
 * BL-05 / AF-6.2「校验即准入」：图模式**可分派**的节点种类唯一来源。
 * validateFlowGraph（GUI/CLI/MCP 校验与预览）、compileFlowGraph、coordinator-host 运行准入
 * 共用这份常量——校验通过的图，运行准入不会再因种类被拒。
 * state-machine 不是可分派图节点：状态机由编译器为整张图派生。
 * BL-10：能力目录改由 `capability-catalog` 从节点注册表与已发布节点流生成，本文件不再持有能力白名单。
 */
export const FLOW_GRAPH_DISPATCHABLE_KINDS = ['agent', 'capability', 'human-task', 'review'] as const
export type FlowGraphDispatchableKind = (typeof FLOW_GRAPH_DISPATCHABLE_KINDS)[number]
export function isDispatchableFlowNodeKind(kind: FlowNodeKind): kind is FlowGraphDispatchableKind {
  return (FLOW_GRAPH_DISPATCHABLE_KINDS as readonly string[]).includes(kind)
}

export const FlowDecisionSchema = z
  .object({
    allowed: z.array(z.enum(['approve', 'edit', 'reject', 'respond'])).min(1).max(4),
    when: z.array(StageConditionSchema).max(16).optional()
  })
  .strict()

export const FlowNodeSchema = z
  .object({
    nodeId: id,
    title: z.string().trim().min(1).max(120),
    participation: FlowParticipationSchema,
    kind: FlowNodeKindSchema,
    /** 固定阶段目标：分派逐字使用，不由模型补写（沿用 AF-01）。 */
    goal: z.string().min(1).max(8192),
    /** 固定完成条件说明：验收以交付事实为准。 */
    completion: z.string().min(1).max(4096),
    /** AF-02 最小必要输入编制；缺省=沿用固定上游输入。 */
    inputs: StageInputsSchema.optional(),
    /** 人机协作决策集（collaborative 必填；autonomous 禁止）。 */
    decisions: FlowDecisionSchema.optional(),
    /** capability 节点专用（兼容旧 JSON：`id@version`，kind 缺省为 node）。新图用 capabilityRef。 */
    capability: z.string().min(1).max(80).optional(),
    /** BL-10 / NF-13.1：能力引用——节点能力或已发布节点流（固定版本）。 */
    capabilityRef: z
      .object({
        kind: z.enum(['node', 'composite']),
        id: z.string().min(1).max(80),
        version: z.string().min(1).max(40)
      })
      .strict()
      .optional(),
    /** review 节点专用。 */
    review: z
      .object({
        criteria: z.string().min(1).max(4096),
        rejectPolicy: z.enum(['rework', 'stop']).default('rework'),
        maxReworks: z.number().int().min(0).max(3).default(1)
      })
      .strict()
      .optional(),
    /** 循环载体：有界循环声明。任何环必须包含一个声明 loop 的载体节点。 */
    loop: z
      .object({
        maxIterations: z.number().int().min(1).max(64),
        exitCondition: z.array(StageConditionSchema).min(1).max(16)
      })
      .strict()
      .optional(),
    /** 汇合策略：多入边节点等待所有/任一入边交付（缺省 all）。条件分支汇合常用 any。 */
    joinPolicy: z.enum(['all', 'any']).optional(),
    /** 编译后承载的真实画布节点（编译器填，外部生成时缺省）。 */
    carrierNodeId: id.optional()
  })
  .strict()
  .superRefine((node, context) => {
    if (node.participation === 'human' && node.kind !== 'human-task')
      context.addIssue({ code: 'custom', message: 'human participation requires a human-task node' })
    if (node.kind === 'human-task' && node.participation !== 'human')
      context.addIssue({ code: 'custom', message: 'human-task node must use human participation' })
    if (node.participation === 'collaborative' && node.kind === 'agent' && !node.decisions)
      context.addIssue({
        code: 'custom',
        message: 'collaborative agent node must declare decisions'
      })
    if (node.participation === 'autonomous' && node.decisions)
      context.addIssue({ code: 'custom', message: 'autonomous node must not declare decisions' })
    if (node.kind === 'capability' && !node.capability && !node.capabilityRef)
      context.addIssue({
        code: 'custom',
        message: 'capability node requires capabilityRef (or legacy capability id)'
      })
    if (node.kind === 'capability' && node.capability && node.capabilityRef)
      context.addIssue({
        code: 'custom',
        message: 'capability node must not declare both capability and capabilityRef'
      })
    if (node.kind !== 'capability' && node.capabilityRef)
      context.addIssue({ code: 'custom', message: 'only capability nodes may declare capabilityRef' })
    if (node.kind === 'review' && !node.review)
      context.addIssue({ code: 'custom', message: 'review node requires review config' })
  })
export type FlowNode = z.infer<typeof FlowNodeSchema>

/** 统一读取能力引用：新字段优先，旧 `capability: id@version` 视为 node 能力。 */
export function flowNodeCapabilityRef(node: FlowNode): CapabilityRef | null {
  if (node.capabilityRef) return node.capabilityRef
  return node.capability ? parseLegacyCapability(node.capability) : null
}

export const FlowEdgeSchema = z
  .object({
    from: z.object({ nodeId: id, portId: id }).strict(),
    to: z.object({ nodeId: id, portId: id }).strict(),
    /**
     * BL-05 / AF-4.3a（2026-11-22）：FlowGraph 只有数据边。字段保留可选以兼容旧 JSON，
     * 只接受 'data'；旧 'control' 边显式拒绝（不静默丢弃）。控制关系（controls/observes/
     * review-gate/rework）不是 FlowGraph 边，由编译器写入节点 config.relations。
     */
    kind: z
      .literal(
        'data',
        'FLOW_EDGE_KIND_REMOVED: control edges were removed from FlowGraph; express ordering with a data edge and re-publish the graph'
      )
      .default('data'),
    /** 条件边：全部满足才流转（复用 evaluateStageEntry 口径）。同源条件出边必须两两互斥（BL-04）。 */
    condition: z.array(StageConditionSchema).max(16).optional(),
    /**
     * BL-04 否则分支：同源所有条件出边都已可判定且均不成立时流转；任一成立时不流转。
     * 不能与 condition 同用；每个源节点最多一条；必须至少有一条同源条件出边。
     */
    otherwise: z.literal(true).optional()
  })
  .strict()
export type FlowEdge = z.infer<typeof FlowEdgeSchema>

export const FlowGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    graphId: id,
    name: z.string().min(1).max(120),
    /** 总目标：复述注入主 Agent（对抗 lost-in-the-middle）。 */
    goal: z.string().min(1).max(32768),
    nodes: z.array(FlowNodeSchema).min(1).max(64),
    edges: z.array(FlowEdgeSchema).max(256),
    entry: id,
    exits: z.array(id).min(1).max(16),
    budgets: z
      .object({
        maxSteps: z.number().int().min(1).max(64).default(12),
        maxActiveMs: z.number().int().min(1000).max(3600000).default(600000),
        maxLoopIterations: z.number().int().min(1).max(64).default(8)
      })
      .strict()
      .default({ maxSteps: 12, maxActiveMs: 600000, maxLoopIterations: 8 })
  })
  .strict()
  .superRefine((graph, context) => {
    const nodeIds = new Set(graph.nodes.map((node) => node.nodeId))
    if (nodeIds.size !== graph.nodes.length)
      context.addIssue({ code: 'custom', message: 'Node ids must be unique' })
    if (!nodeIds.has(graph.entry))
      context.addIssue({ code: 'custom', message: 'Entry must reference a declared node' })
    for (const exit of graph.exits)
      if (!nodeIds.has(exit))
        context.addIssue({ code: 'custom', message: 'Exit must reference a declared node' })
    graph.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.from.nodeId))
        context.addIssue({ code: 'custom', path: ['edges', index], message: 'Edge from must reference a declared node' })
      if (!nodeIds.has(edge.to.nodeId))
        context.addIssue({ code: 'custom', path: ['edges', index], message: 'Edge to must reference a declared node' })
      for (const condition of edge.condition ?? [])
        checkConditionRefs(condition, nodeIds, context, ['edges', index])
      if (edge.otherwise && (edge.condition?.length ?? 0) > 0)
        context.addIssue({ code: 'custom', path: ['edges', index], message: 'An otherwise edge must not declare a condition' })
    })
    for (const node of graph.nodes) {
      for (const selector of node.inputs?.selectors ?? [])
        if (!nodeIds.has(selector.sourceStageKey))
          context.addIssue({
            code: 'custom',
            message: `Selector on ${node.nodeId} must reference a declared node`
          })
      for (const condition of node.loop?.exitCondition ?? [])
        checkConditionRefs(condition, nodeIds, context, [])
      for (const condition of node.decisions?.when ?? [])
        checkConditionRefs(condition, nodeIds, context, [])
    }
  })
export type FlowGraph = z.infer<typeof FlowGraphSchema>

function checkConditionRefs(
  condition: z.infer<typeof StageConditionSchema>,
  nodeIds: Set<string>,
  context: z.RefinementCtx,
  path: (string | number)[]
): void {
  if (condition.kind === 'review-passed') {
    if (!nodeIds.has(condition.reviewNodeId))
      context.addIssue({ code: 'custom', path, message: 'Condition reviewNodeId must reference a declared node' })
    return
  }
  if (!nodeIds.has(condition.stageKey))
    context.addIssue({ code: 'custom', path, message: 'Condition stageKey must reference a declared node' })
}

// ── 静态校验（图算法层，纯函数；schema 层之外的拓扑/参与/预算检查）──

export type FlowGraphErrorCode =
  | 'CYCLE_WITHOUT_LOOP'
  | 'UNREACHABLE_NODE'
  | 'EXIT_UNREACHABLE'
  | 'LOOP_BUDGET_EXCEEDED'
  | 'ENTRY_IS_EXIT'
  | 'LOOP_BODY_UNSUPPORTED'
  | 'NODE_KIND_UNSUPPORTED'
  | 'CAPABILITY_UNKNOWN'
  | 'CAPABILITY_NOT_SCHEDULABLE'
  | 'CAPABILITY_PARTICIPATION_BELOW_FLOOR'
  | 'CONDITION_NOT_EXCLUSIVE'
  | 'OTHERWISE_INVALID'
export interface FlowGraphError {
  code: FlowGraphErrorCode
  nodeId?: string
  message: string
}
export type FlowGraphValidation = { ok: true } | { ok: false; errors: FlowGraphError[] }

/** 邻接表（data + control 边都构成依赖）。 */
function adjacency(graph: FlowGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const node of graph.nodes) adj.set(node.nodeId, [])
  for (const edge of graph.edges) adj.get(edge.from.nodeId)!.push(edge.to.nodeId)
  return adj
}

/** Tarjan 强连通分量：用于环检测（任何环必须含一个有界循环载体）。 */
function stronglyConnectedComponents(adj: Map<string, string[]>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  const strongconnect = (v: string): void => {
    indices.set(v, index)
    lowlink.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(w)
      } while (w !== v)
      components.push(component)
    }
  }
  for (const v of adj.keys()) if (!indices.has(v)) strongconnect(v)
  return components
}

function reachable(adj: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    const v = queue.shift()!
    for (const w of adj.get(v) ?? [])
      if (!seen.has(w)) {
        seen.add(w)
        queue.push(w)
      }
  }
  return seen
}

/**
 * 静态校验入口（纯函数，GUI/CLI/MCP 与宿主共用口径）。
 * schema 层（FlowGraphSchema）已保证引用/参与/结构合法；本层补拓扑/预算：
 * 1) 循环只能用单节点 `loop` 声明、不画回边（BL-07）：含环的强连通分量（多节点环或自回边）
 *    若含 loop 载体 → LOOP_BODY_UNSUPPORTED（多节点循环体待 FlowGraph v2）；否则 CYCLE_WITHOUT_LOOP；
 * 2) 入口可达所有节点、出口可达（无孤岛）；
 * 3) 循环 maxIterations 不超过全局预算；
 * 4) 入口不能同时是出口（空流程）；
 * 5) 节点种类在图模式可分派白名单内、capability 在可编译能力目录内（BL-05，与运行准入同源）；
 * 6) 同源条件出边两两互斥、otherwise 用法合法（BL-04，见 conditionsExclusive）。
 */
export function validateFlowGraph(
  graph: FlowGraph,
  options: { catalog?: readonly CapabilityDescriptor[] } = {}
): FlowGraphValidation {
  const errors: FlowGraphError[] = []
  const adj = adjacency(graph)
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]))
  const catalog = options.catalog ?? buildCapabilityCatalog()
  const availableCapabilities = catalog
    .map((descriptor) => `${descriptor.capabilityRef.id}@${descriptor.capabilityRef.version}`)
    .join(', ')

  if (graph.exits.includes(graph.entry))
    errors.push({ code: 'ENTRY_IS_EXIT', nodeId: graph.entry, message: 'Entry must not also be an exit' })

  // BL-05 / BL-10：校验即准入——节点种类白名单与能力目录与 compile / 运行准入同一来源。
  for (const node of graph.nodes) {
    if (!isDispatchableFlowNodeKind(node.kind))
      errors.push({
        code: 'NODE_KIND_UNSUPPORTED',
        nodeId: node.nodeId,
        message: `Node kind ${node.kind} cannot be dispatched in graph mode (allowed: ${FLOW_GRAPH_DISPATCHABLE_KINDS.join(', ')})`
      })
    if (node.kind !== 'capability') continue
    const ref = flowNodeCapabilityRef(node)
    const descriptor = findCapability(catalog, ref)
    if (!ref || !descriptor) {
      errors.push({
        code: 'CAPABILITY_UNKNOWN',
        nodeId: node.nodeId,
        message: `Unknown capability ${ref ? `${ref.id}@${ref.version}` : '(missing)'} (available: ${availableCapabilities})`
      })
      continue
    }
    if (!descriptor.agentSchedulable) {
      errors.push({
        code: 'CAPABILITY_NOT_SCHEDULABLE',
        nodeId: node.nodeId,
        message: `Capability ${descriptor.capabilityRef.id}@${descriptor.capabilityRef.version} is not schedulable from a FlowGraph: ${descriptor.reason ?? 'no compile carrier'}`
      })
      continue
    }
    // NF-13.2：目录里的参与形态是下限，FlowGraph 只能更高。
    if (participationRank(node.participation) < participationRank(descriptor.participation))
      errors.push({
        code: 'CAPABILITY_PARTICIPATION_BELOW_FLOOR',
        nodeId: node.nodeId,
        message: `Capability ${descriptor.capabilityRef.id}@${descriptor.capabilityRef.version} requires at least ${descriptor.participation} participation (node declares ${node.participation})`
      })
  }

  // BL-04：同源条件出边必须两两互斥；otherwise 至多一条且须有条件兄弟边。
  for (const node of graph.nodes) {
    const outgoing = graph.edges.filter((edge) => edge.from.nodeId === node.nodeId)
    const conditional = outgoing.filter((edge) => (edge.condition?.length ?? 0) > 0)
    const otherwise = outgoing.filter((edge) => edge.otherwise)
    if (otherwise.length > 1)
      errors.push({ code: 'OTHERWISE_INVALID', nodeId: node.nodeId, message: `Node ${node.nodeId} declares more than one otherwise edge` })
    if (otherwise.length > 0 && conditional.length === 0)
      errors.push({ code: 'OTHERWISE_INVALID', nodeId: node.nodeId, message: `Otherwise edge from ${node.nodeId} needs at least one conditional sibling edge` })
    for (let i = 0; i < conditional.length; i++)
      for (let j = i + 1; j < conditional.length; j++) {
        const a = conditional[i]
        const b = conditional[j]
        if (a.to.nodeId === b.to.nodeId) continue
        if (!conditionsExclusive(a.condition!, b.condition!))
          errors.push({
            code: 'CONDITION_NOT_EXCLUSIVE',
            nodeId: node.nodeId,
            message: `Conditional edges ${node.nodeId}→${a.to.nodeId} and ${node.nodeId}→${b.to.nodeId} may both hold; make them mutually exclusive (e.g. exists/missing, equals different values, count ranges) or use an otherwise edge`
          })
      }
  }

  // 环检测：每个含环的强连通分量必须有一个有界循环载体。
  for (const component of stronglyConnectedComponents(adj)) {
    const hasCycle =
      component.length > 1 ||
      (adj.get(component[0]) ?? []).includes(component[0])
    if (!hasCycle) continue
    const carrier = component.find((nodeId) => nodeById.get(nodeId)?.loop)
    if (!carrier) {
      errors.push({
        code: 'CYCLE_WITHOUT_LOOP',
        nodeId: component[0],
        message: `Cycle [${component.join(', ')}] must contain a node declaring a bounded loop`
      })
      continue
    }
    // 路由器的 settled 语义下，环内其他节点要等载体 settled（即循环结束）才就绪，
    // 回边又让载体等环内节点——多节点环与自回边都无法执行，故静态拒绝。
    errors.push({
      code: 'LOOP_BODY_UNSUPPORTED',
      nodeId: carrier,
      message: `Cycle [${component.join(', ')}] is not executable: declare the loop on a single node via node.loop without back edges (multi-node loop bodies arrive with FlowGraph v2)`
    })
  }

  // 可达性：入口可达所有节点；每个出口可达。
  const fromEntry = reachable(adj, graph.entry)
  for (const node of graph.nodes)
    if (!fromEntry.has(node.nodeId))
      errors.push({ code: 'UNREACHABLE_NODE', nodeId: node.nodeId, message: `Node ${node.nodeId} is not reachable from entry` })
  for (const exit of graph.exits)
    if (!fromEntry.has(exit))
      errors.push({ code: 'EXIT_UNREACHABLE', nodeId: exit, message: `Exit ${exit} is not reachable from entry` })

  // 循环预算。
  for (const node of graph.nodes)
    if (node.loop && node.loop.maxIterations > graph.budgets.maxLoopIterations)
      errors.push({
        code: 'LOOP_BUDGET_EXCEEDED',
        nodeId: node.nodeId,
        message: `Loop maxIterations ${node.loop.maxIterations} exceeds budget ${graph.budgets.maxLoopIterations}`
      })

  return errors.length ? { ok: false, errors } : { ok: true }
}

// ── BL-04 条件互斥（声明式可判定子集，纯函数）──

function valueTypeOf(value: unknown): string {
  return Array.isArray(value) ? 'array' : typeof value
}

/**
 * 两个原子条件不可能同时成立。判定按「单值交付」：同一节点、同一路径的 equals 不同值 /
 * type 不同类型视为互斥；多值交付同时命中多个分支由路由器运行期报 ambiguous 兜底。
 * exists/equals/type 与 missing 互斥；output-count 的 gte/lte 区间不相交时互斥。
 * human-decision 与 review-passed 没有否定形式，无法互斥——需要二选一时用 otherwise 边。
 */
export function conditionAtomsContradict(a: StageCondition, b: StageCondition): boolean {
  if (a.kind === 'output-field' && b.kind === 'output-field') {
    if (a.stageKey !== b.stageKey || a.path !== b.path) return false
    const positive = (op: string): boolean => op === 'exists' || op === 'equals' || op === 'type'
    if ((a.op === 'missing' && positive(b.op)) || (b.op === 'missing' && positive(a.op))) return true
    if (a.op === 'equals' && b.op === 'equals')
      return canonicalFlowJson(a.value) !== canonicalFlowJson(b.value)
    if (a.op === 'type' && b.op === 'type') return a.valueType !== b.valueType
    if (a.op === 'equals' && b.op === 'type') return valueTypeOf(a.value) !== b.valueType
    if (a.op === 'type' && b.op === 'equals') return valueTypeOf(b.value) !== a.valueType
    return false
  }
  if (a.kind === 'output-count' && b.kind === 'output-count') {
    if (a.stageKey !== b.stageKey || a.op === b.op) return false
    const gte = a.op === 'gte' ? a.count : b.count
    const lte = a.op === 'lte' ? a.count : b.count
    return lte < gte
  }
  return false
}

/** 两条条件边（各自为合取）互斥 ⇔ 存在一对互相矛盾的原子条件。 */
export function conditionsExclusive(a: StageCondition[], b: StageCondition[]): boolean {
  return a.some((left) => b.some((right) => conditionAtomsContradict(left, right)))
}
