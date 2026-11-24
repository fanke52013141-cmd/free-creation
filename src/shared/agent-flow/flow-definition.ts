import { z } from 'zod'
import { FlowStagesSchema, type FlowStage } from './stage-contracts'
import { FlowGraphSchema, type FlowGraph, type FlowNode } from './flow-graph'
import { canonicalFlowJson } from './semantic-revision'

/**
 * AF-06 复用与评测：流程定义版本（与运行分离）。
 * 定义是固定顺序主控的可复用快照（阶段/方法/输入/进入条件），不可变；
 * 一次调用使用某定义版本创建独立运行，不改模板。contentHash 由宿主计算。
 */
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)

export const FlowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    definitionId: id,
    version: z.number().int().positive(),
    name: z.string().min(1).max(120),
    coordinatorGoal: z.string().min(1).max(32768),
    stages: FlowStagesSchema,
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative()
  })
  .strict()
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>

/** 定义内容（不含版本/时间/hash）——用于计算 contentHash 与差异比较。 */
export function definitionContent(input: {
  name: string
  coordinatorGoal: string
  stages: FlowStage[]
}): { name: string; coordinatorGoal: string; stages: FlowStage[] } {
  return { name: input.name, coordinatorGoal: input.coordinatorGoal, stages: input.stages }
}

export interface StageDiff {
  stageKey: string
  change: 'added' | 'removed' | 'changed'
  fields?: string[]
}
export interface DefinitionDiff {
  nameChanged: boolean
  goalChanged: boolean
  stages: StageDiff[]
}

const STAGE_FIELDS: Array<keyof FlowStage> = [
  'goal',
  'completion',
  'requireHumanDecision',
  'entry',
  'inputs',
  'method',
  'nodeId'
]

/** 纯函数差异预览：比较两个定义版本的名称/目标/阶段（增删改及变更字段）。 */
export function diffDefinitions(
  before: { name: string; coordinatorGoal: string; stages: FlowStage[] },
  after: { name: string; coordinatorGoal: string; stages: FlowStage[] }
): DefinitionDiff {
  const beforeByKey = new Map(before.stages.map((stage) => [stage.stageKey, stage]))
  const afterByKey = new Map(after.stages.map((stage) => [stage.stageKey, stage]))
  const stages: StageDiff[] = []
  for (const [key, stage] of afterByKey) {
    const prior = beforeByKey.get(key)
    if (!prior) {
      stages.push({ stageKey: key, change: 'added' })
      continue
    }
    const fields = STAGE_FIELDS.filter(
      (field) => canonicalFlowJson(prior[field] ?? null) !== canonicalFlowJson(stage[field] ?? null)
    )
    if (fields.length) stages.push({ stageKey: key, change: 'changed', fields })
  }
  for (const key of beforeByKey.keys())
    if (!afterByKey.has(key)) stages.push({ stageKey: key, change: 'removed' })
  return {
    nameChanged: before.name !== after.name,
    goalChanged: before.coordinatorGoal !== after.coordinatorGoal,
    stages
  }
}

/**
 * ④P6：FlowGraph 定义版本（与运行分离，不可变）。图模式的可复用快照——存 FlowGraph IR，
 * contentHash 由宿主计算；一次调用用某定义版本经建图提案管线创建独立运行，不改模板。
 */
export interface FlowGraphSource {
  definitionId: string
  version: number
  contentHash: string
}

export const FlowGraphDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    definitionId: id,
    version: z.number().int().positive(),
    name: z.string().min(1).max(120),
    graph: FlowGraphSchema,
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative()
  })
  .strict()
export type FlowGraphDefinition = z.infer<typeof FlowGraphDefinitionSchema>

/** 图定义内容（不含版本/时间/hash）——用于 contentHash 与差异比较。 */
export function graphDefinitionContent(input: {
  name: string
  graph: FlowGraph
}): { name: string; graph: FlowGraph } {
  return { name: input.name, graph: input.graph }
}

export interface GraphNodeDiff {
  nodeId: string
  change: 'added' | 'removed' | 'changed'
  fields?: string[]
}
export interface GraphDefinitionDiff {
  nameChanged: boolean
  goalChanged: boolean
  nodes: GraphNodeDiff[]
  edgesAdded: Array<{ from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string } }>
  edgesRemoved: Array<{ from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string } }>
}

const GRAPH_NODE_FIELDS: Array<keyof FlowNode> = [
  'title',
  'participation',
  'kind',
  'goal',
  'completion',
  'inputs',
  'decisions',
  'capability',
  'review',
  'loop'
]

/** 纯函数图定义差异：比较名称/总目标/节点（增删改及变更字段）/数据边（增删）。 */
export function diffGraphDefinitions(
  before: { name: string; graph: FlowGraph },
  after: { name: string; graph: FlowGraph }
): GraphDefinitionDiff {
  const beforeById = new Map(before.graph.nodes.map((node) => [node.nodeId, node]))
  const afterById = new Map(after.graph.nodes.map((node) => [node.nodeId, node]))
  const nodes: GraphNodeDiff[] = []
  for (const [nodeId, node] of afterById) {
    const prior = beforeById.get(nodeId)
    if (!prior) {
      nodes.push({ nodeId, change: 'added' })
      continue
    }
    const fields = GRAPH_NODE_FIELDS.filter(
      (field) => canonicalFlowJson(prior[field] ?? null) !== canonicalFlowJson(node[field] ?? null)
    )
    if (fields.length) nodes.push({ nodeId, change: 'changed', fields })
  }
  for (const nodeId of beforeById.keys())
    if (!afterById.has(nodeId)) nodes.push({ nodeId, change: 'removed' })
  const edgeKey = (edge: { from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string } }): string =>
    canonicalFlowJson(edge)
  const beforeEdges = new Set(before.graph.edges.map(edgeKey))
  const afterEdges = new Set(after.graph.edges.map(edgeKey))
  return {
    nameChanged: before.name !== after.name,
    goalChanged: before.graph.goal !== after.graph.goal,
    nodes,
    edgesAdded: after.graph.edges.filter((edge) => !beforeEdges.has(edgeKey(edge))),
    edgesRemoved: before.graph.edges.filter((edge) => !afterEdges.has(edgeKey(edge)))
  }
}
