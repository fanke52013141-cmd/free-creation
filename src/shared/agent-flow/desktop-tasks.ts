import { z } from 'zod'
import { HandoffNoteSchema } from './stage-contracts'
import type { FlowAssetValue } from './assets'
import { SkillBindingSchema } from './runtime-contracts'
import { AgentFlowAssetRefSchema as importedAssetRef } from './node-contracts'

export interface FlowPhaseProjection {
  taskId: string
  phase: string
  revision: number
}
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
export const FlowAgentQuerySchema = z.object({ projectId: id, nodeId: id }).strict()
export const FlowAgentRunSchema = FlowAgentQuerySchema.extend({
  requestId: id,
  traceId: id,
  spanId: id,
  action: z.enum(['start', 'continue', 'reconcile', 'restore']),
  eventId: id.optional(),
  expectedTaskId: id.optional(),
  expectedWaitRevision: z.number().int().nonnegative().optional(),
  /**
   * P0-2/P0-3：人工继续的来源证据。只有可信入口能填：
   * - 'gui'：渲染器里人亲自点了继续；
   * - 'desktop-confirm'：外部调用已在 main 经 desktop.ask 由人确认。
   * 缺省表示没有人工确认证据——人工等待的继续必须被拒，不能默认当作"人已采用"。
   */
  humanConfirmed: z.enum(['gui', 'desktop-confirm']).optional(),
  contextMaterial: HandoffNoteSchema.optional(),
  /** O4-P3/AF-02: router-selected canvas inbound edges for this assignment. */
  routedInputEdgeIds: z.array(id).max(256).optional(),
  runOrigin: z.literal('external').optional(),
  externalClientId: z.string().regex(/^(?:cli|mcp(?:-[a-f0-9]{16})?)$/).optional()
})
  .strict()
  .superRefine((input, context) => {
    if (input.contextMaterial && (input.action !== 'continue' || !input.humanConfirmed))
      context.addIssue({
        code: 'custom', path: ['contextMaterial'], message: 'Context material requires a confirmed continuation'
      })
    if (input.externalClientId && input.runOrigin !== 'external')
      context.addIssue({ code: 'custom', path: ['externalClientId'], message: 'External origin required' })
    if (
      ['continue', 'reconcile', 'restore'].includes(input.action) &&
      (!input.expectedTaskId ||
        input.expectedWaitRevision === undefined ||
        !input.eventId ||
        (input.action === 'continue' && input.expectedWaitRevision < 1))
    )
      context.addIssue({
        code: 'custom',
        message: 'Continue requires the observed task and wait revision'
      })
  })
export type FlowAgentRun = z.infer<typeof FlowAgentRunSchema>
export interface FlowAgentView {
  taskId: string
  state: 'ready' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'cancelled'
  waitKind: 'human' | 'reconcile' | null
  /**
   * A3：等待的真实原因。只有 'human' 代表确实在等人处理；
   * 其余（在途子任务、待审核、受阻、已暂停）都不是人工待办，不得计入收件箱。
   */
  waitReason?: 'human' | 'active-child' | 'pending-review' | 'blocked' | 'paused'
  waitRevision: number
  decisions: number
  tools: number
  code?: string
  recovery?: { reasons: string[]; canRestore: boolean }
  prepared?: boolean
  phase?: string
  children?: Array<{ nodeId: string; taskId: string; state: string }>
  reviewFeedback?: {
    reviewNodeId: string
    reviewId: string
    feedback: string
    round: number
    state: string
    subjects: import('zod').infer<typeof importedAssetRef>[]
  }
}
export const FlowAgentCollaborationSchema = FlowAgentQuerySchema.extend({
  taskId: id,
  waitRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  eventId: id,
  action: z.enum(['note', 'discuss', 'submit', 'revise']),
  text: z.string().max(4096),
  accepted: z.boolean().optional(),
  handoffNote: HandoffNoteSchema.optional(),
  selectedOutputs: z.array(importedAssetRef).max(128).optional(),
  selectedInputs: z.array(importedAssetRef).max(128).optional()
})
  .strict()
  .superRefine((input, context) => {
    if (input.handoffNote && (input.action !== 'submit' || input.accepted !== true))
      context.addIssue({ code: 'custom', path: ['handoffNote'], message: 'Handoff requires an accepted submission' })
    const refs = input.selectedOutputs ?? []
    if (new Set(refs.map((ref) => JSON.stringify(ref))).size !== refs.length)
      context.addIssue({ code: 'custom', message: 'Selected outputs must be unique references' })
  })
export type FlowAgentCollaboration = z.infer<typeof FlowAgentCollaborationSchema>

const externalClientId = z.string().regex(/^(?:cli|mcp(?:-[a-f0-9]{16})?)$/)
/** Trusted bridge envelope; origin is deliberately outside the strict business input. */
export const FlowAgentCollaborationEnvelopeSchema = z.object({
  input: FlowAgentCollaborationSchema,
  origin: z.object({ kind: z.literal('external'), clientId: externalClientId }).strict()
}).strict()
export const CollaborationActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), roleId: id }).strict(),
  z.object({ kind: z.literal('external'), clientId: externalClientId }).strict()
])
export type CollaborationActor = z.infer<typeof CollaborationActorSchema>
export interface FlowAgentCollaborationView {
  task: FlowAgentView
  goal: string
  revision: number
  messages: Array<{ eventId: string; kind: string; text: string; reply?: string; handoffNote?: string; actor?: CollaborationActor }>
  inputs: Array<{ sourceNodeId: string; sourcePortId: string; versionId: string }>
  candidates: import('zod').infer<typeof importedAssetRef>[]
  /** AF-04：当前工作稿（最近一次已提交候选成果正文）；无候选时为 undefined。 */
  workingDraft?: string
}
export interface FlowAgentReply {
  refs: import('zod').infer<typeof import('./node-contracts').AgentFlowAssetRefSchema>[]
  task: FlowAgentView
  outputs: Partial<Record<'out-text' | 'out-json', FlowAssetValue>>
}
export interface FlowAgentCatalog {
  skills: Array<z.infer<typeof SkillBindingSchema> & { name: string; description: string }>
  models: Array<{ id: string; name: string; imageInput?: boolean; audioInput?: boolean }>
  tools: Array<{ id: string; version: string; name: string }>
}
