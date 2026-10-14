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
      inputs: z.array(AgentFlowAssetRefSchema).min(1).max(32)
    })
    .strict(),
  z
    .object({ kind: z.literal('finish'), outputs: z.array(AgentFlowAssetRefSchema).min(1).max(2) })
    .strict(),
  z.object({ kind: z.literal('wait') }).strict()
])
export type CoordinationDecision = z.infer<typeof CoordinationDecisionSchema>
export interface CoordinationContext {
  goal: string
  mode: 'collaborative' | 'autonomous'
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
export type ModelIdentity = Pick<
  AgentTaskSnapshot,
  'config' | 'projectId' | 'agentNodeId' | 'taskId' | 'traceId' | 'spanId'
>
