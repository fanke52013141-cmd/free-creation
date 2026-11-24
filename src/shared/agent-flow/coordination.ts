import { z } from 'zod'
import { AgentFlowAssetRefSchema } from './node-contracts'
import type { AgentTaskSnapshot } from './runtime-contracts'
import type { FlowAgentReply, FlowAgentView } from './desktop-tasks'

export const CoordinationDecisionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('dispatch'),
      nodeId: z.string().min(1).max(128),
      goal: z.string().min(1).max(8192),
      completion: z.string().min(1).max(4096),
      // 二-1：inputs 允许为空——所选专家没有固定上游输入时仍可分派。
      // "有固定输入则至少选一条"的条件约束由主控模型端口在决策解析后校验
      // （runtime-model.coordinate），schema 层无法感知候选的可用输入。
      inputs: z.array(AgentFlowAssetRefSchema).min(0).max(32)
    })
    .strict(),
  z
    .object({
      kind: z.literal('finish'),
      outputs: z.array(AgentFlowAssetRefSchema).min(1).max(128)
    })
    .strict(),
  z.object({ kind: z.literal('wait') }).strict(),
  z
    .object({
      kind: z.literal('dispatch-many'),
      assignments: z
        .array(
          z
            .object({
              nodeId: z.string().min(1).max(128),
              goal: z.string().min(1).max(8192),
              completion: z.string().min(1).max(4096),
              inputs: z.array(AgentFlowAssetRefSchema).min(0).max(32)
            })
            .strict()
        )
        .min(2)
        .max(4)
    })
    .strict()
])
export type CoordinationDecision = z.infer<typeof CoordinationDecisionSchema>

/**
 * 二-1：条件化最小输入校验（纯函数，GUI/CLI/MCP 与模型端口共用口径）。
 * 所选候选有固定输入时，分派必须至少携带一条（逐字复制由 exactRefs 保证）；
 * 候选没有固定输入时允许空清单——无输入专家可分派。
 * finish/wait 决策不涉及 inputs，恒满足。
 */
export function dispatchInputsSatisfied(
  decision: CoordinationDecision,
  available: CoordinationContext['available']
): boolean {
  const assignments =
    decision.kind === 'dispatch'
      ? [decision]
      : decision.kind === 'dispatch-many'
        ? decision.assignments
        : []
  return assignments.every((assignment) => {
    const candidate = available.find((item) => item.nodeId === assignment.nodeId)
    return !(assignment.inputs.length === 0 && candidate && candidate.inputs.length > 0)
  })
}
export interface CoordinationContext {
  goal: string
  mode: 'collaborative' | 'autonomous'
  maxParallelTasks?: number
  available: Array<{
    nodeId: string
    goal: string
    inputs: z.infer<typeof AgentFlowAssetRefSchema>[]
  }>
  completed: Array<{ nodeId: string; taskId: string; outputs: FlowAgentReply['refs'] }>
}
export interface CoordinatorPort {
  run(raw: unknown): Promise<FlowAgentReply>
  inspect(input: { projectId: string; nodeId: string }): FlowAgentView | null
  stop(input: { projectId: string; nodeId: string }): FlowAgentView | null
  pause(input: { projectId: string; nodeId: string }): FlowAgentView | null
  /** AF-02：预览阶段输入编制（只读，固定顺序模式）；旧模式宿主可不实现。 */
  previewStageContext?(
    input: { projectId: string; nodeId: string },
    stageKey: string,
    includeBody?: boolean
  ): StageContextPreview | null
  /** C 组：预览阶段返工影响（只读，固定顺序模式）；不修改任何运行事实。 */
  previewStageRework?(
    input: { projectId: string; nodeId: string },
    stageKey: string
  ): FlowStageReworkImpact | null
}
/** C 组：返工/摒弃影响预览与确认所需的只读事实。 */
export interface FlowStageReworkImpact {
  stageKey: string
  /** 1 起的阶段序号，与画布上的阶段编号一致。 */
  stageIndex: number
  round: number
  nextRound: number
  maxRounds: number
  /** 将被重跑的阶段（该阶段及下游）。 */
  willRerunStages: Array<{ stageKey: string; nodeId: string }>
  /** 将被标为过期（stale）并移入历史的既有交付。 */
  staleDeliveries: Array<{
    stageKey: string
    nodeId: string
    acceptedAt: number
    outputCount: number
  }>
  /** 不受影响、继续保留的交付数量。 */
  keptDeliveries: number
  /** 受影响范围内尚未完成的子任务数量（会一并作废）。 */
  activeChildCount: number
  /** 当前能否执行返工；false 时 blockReason 给出稳定原因码。 */
  canRework: boolean
  blockedReason?: string
}
export interface StageContextPreview {
  stageKey: string
  manifestHash: string
  entries: Array<{
    sourceStageKey: string
    path: string
    kind: string
    bytes: number
    required: boolean
    purpose?: string
    value?: unknown
  }>
  missing: Array<{ sourceStageKey: string; path: string; required: boolean; code: string }>
  dropped: Array<{ sourceStageKey: string; path: string; required: boolean; code: string }>
  budget: { limitBytes: number; usedBytes: number; exceeded: boolean }
  blocking: boolean
}
export interface AgentPublication {
  kind?: 'review'
  projectId: string
  nodeId: string
  taskId: string
  semanticRevision: string
  traceId: string
  spanId: string
}
export type ModelIdentity = { requiresImageInput?: boolean; requiresAudioInput?: boolean } & Pick<
  AgentTaskSnapshot,
  'config' | 'projectId' | 'agentNodeId' | 'taskId' | 'traceId' | 'spanId'
>
