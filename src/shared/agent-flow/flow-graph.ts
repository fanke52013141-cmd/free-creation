import { z } from 'zod'
import { StageConditionSchema, StageInputsSchema } from './stage-contracts'

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
    /** capability 节点专用（复用建图能力目录 id）。 */
    capability: z.string().min(1).max(80).optional(),
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
    /** 编译后承载的真实画布节点（编译器填，外部生成时缺省）。 */
    carrierNodeId: id.optional()
  })
  .strict()
  .superRefine((node, context) => {
    if (node.participation === 'human' && node.kind !== 'human-task')
      context.addIssue({ code: 'custom', message: 'human participation requires a human-task node' })
    if (node.kind === 'human-task' && node.participation !== 'human')
      context.addIssue({ code: 'custom', message: 'human-task node must use human participation' })
    if (node.participation === 'collaborative' && (node.kind !== 'agent' || !node.decisions))
      context.addIssue({
        code: 'custom',
        message: 'collaborative node must be an agent with decisions'
      })
    if (node.participation === 'autonomous' && node.decisions)
      context.addIssue({ code: 'custom', message: 'autonomous node must not declare decisions' })
    if (node.kind === 'capability' && !node.capability)
      context.addIssue({ code: 'custom', message: 'capability node requires a capability id' })
    if (node.kind === 'review' && !node.review)
      context.addIssue({ code: 'custom', message: 'review node requires review config' })
  })
export type FlowNode = z.infer<typeof FlowNodeSchema>

export const FlowEdgeSchema = z
  .object({
    from: z.object({ nodeId: id, portId: id }).strict(),
    to: z.object({ nodeId: id, portId: id }).strict(),
    kind: z.enum(['data', 'control']).default('data'),
    /** 条件边：全部满足才流转（复用 evaluateStageEntry 口径）。 */
    condition: z.array(StageConditionSchema).max(16).optional(),
    /** 汇合策略：多入边节点等待所有/任一入边交付。 */
    joinPolicy: z.enum(['all', 'any']).optional()
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
 * 1) 任何环必须含一个声明 loop 的载体节点（防无界循环）；
 * 2) 入口可达所有节点、出口可达（无孤岛）；
 * 3) 循环 maxIterations 不超过全局预算；
 * 4) 入口不能同时是出口（空流程）。
 * 条件互斥的完整可满足性检查（D6）属 P2/P3，本层不做。
 */
export function validateFlowGraph(graph: FlowGraph): FlowGraphValidation {
  const errors: FlowGraphError[] = []
  const adj = adjacency(graph)
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]))

  if (graph.exits.includes(graph.entry))
    errors.push({ code: 'ENTRY_IS_EXIT', nodeId: graph.entry, message: 'Entry must not also be an exit' })

  // 环检测：每个含环的强连通分量必须有一个有界循环载体。
  for (const component of stronglyConnectedComponents(adj)) {
    const hasCycle =
      component.length > 1 ||
      (adj.get(component[0]) ?? []).includes(component[0])
    if (!hasCycle) continue
    const hasLoopCarrier = component.some((nodeId) => nodeById.get(nodeId)?.loop)
    if (!hasLoopCarrier)
      errors.push({
        code: 'CYCLE_WITHOUT_LOOP',
        nodeId: component[0],
        message: `Cycle [${component.join(', ')}] must contain a node declaring a bounded loop`
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