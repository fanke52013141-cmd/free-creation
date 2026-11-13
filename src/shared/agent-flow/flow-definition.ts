import { z } from 'zod'
import { FlowStagesSchema, type FlowStage } from './stage-contracts'
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
