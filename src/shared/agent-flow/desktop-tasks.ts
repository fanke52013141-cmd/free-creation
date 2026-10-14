import { z } from 'zod'
import type { FlowAssetValue } from './assets'
import { SkillBindingSchema } from './runtime-contracts'
import { AgentFlowAssetRefSchema as importedAssetRef } from './node-contracts'
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
  expectedWaitRevision: z.number().int().nonnegative().optional()
})
  .strict()
  .superRefine((input, context) => {
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
  selectedOutputs: z.array(importedAssetRef).max(2).optional(),
  selectedInputs: z.array(importedAssetRef).max(128).optional()
}).strict()
export type FlowAgentCollaboration = z.infer<typeof FlowAgentCollaborationSchema>
export interface FlowAgentCollaborationView {
  task: FlowAgentView
  goal: string
  revision: number
  messages: Array<{ eventId: string; kind: string; text: string; reply?: string }>
  inputs: Array<{ sourceNodeId: string; sourcePortId: string; versionId: string }>
  candidates: import('zod').infer<typeof importedAssetRef>[]
}
export interface FlowAgentReply {
  refs: import('zod').infer<typeof import('./node-contracts').AgentFlowAssetRefSchema>[]
  task: FlowAgentView
  outputs: Partial<Record<'out-text' | 'out-json', FlowAssetValue>>
}
export interface FlowAgentCatalog {
  skills: Array<z.infer<typeof SkillBindingSchema> & { name: string; description: string }>
  models: Array<{ id: string; name: string }>
  tools: Array<{ id: string; version: string; name: string }>
}
