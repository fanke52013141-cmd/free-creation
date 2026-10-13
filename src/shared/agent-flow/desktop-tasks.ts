import { z } from 'zod'
import type { FlowAssetValue } from './assets'
import { SkillBindingSchema } from './runtime-contracts'
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
  action: z.enum(['start', 'continue']),
  eventId: id.optional()
}).strict()
export type FlowAgentRun = z.infer<typeof FlowAgentRunSchema>
export interface FlowAgentView {
  taskId: string
  state: 'ready' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'cancelled'
  waitKind: 'human' | 'reconcile' | null
  waitRevision: number
  decisions: number
  tools: number
  code?: string
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
