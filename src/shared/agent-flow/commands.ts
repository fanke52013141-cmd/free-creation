import { z } from 'zod'
import { AgentFlowAssetRefSchema } from './node-contracts'

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
export const FixedNodeInputSchema = z
  .object({
    targetPortId: id,
    assets: z.array(AgentFlowAssetRefSchema).min(1).max(128)
  })
  .strict()

/** Intent only. Parsing never authorizes dispatch or replaces the registered node contract. */
export const NodeExecuteCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('node.execute'),
    commandId: id,
    projectId: id,
    taskId: id,
    agentNodeId: id,
    targetNodeId: id,
    expectedSemanticRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    contractVersion: z.number().int().positive(),
    inputs: z.array(FixedNodeInputSchema).max(128),
    traceId: id,
    spanId: id
  })
  .strict()
  .superRefine((command, context) => {
    const ports = new Set<string>()
    let count = 0
    for (const input of command.inputs) {
      if (ports.has(input.targetPortId)) {
        context.addIssue({ code: 'custom', message: 'Duplicate target input port' })
      }
      ports.add(input.targetPortId)
      count += input.assets.length
    }
    if (count > 128) {
      context.addIssue({ code: 'custom', message: 'Too many fixed asset references' })
    }
    if (command.agentNodeId === command.targetNodeId) {
      context.addIssue({ code: 'custom', message: 'Agent cannot execute itself' })
    }
  })
export type NodeExecuteCommand = z.infer<typeof NodeExecuteCommandSchema>

export const CommandLookupSchema = z.object({ projectId: id, commandId: id }).strict()
export const NodeAvailabilitySchema = z
  .object({ projectId: id, nodeId: id, controlledRequestId: id.optional() })
  .strict()
export const FlowCanvasSchema = z.object({ projectId: id }).strict()
export const CommandLeaseSchema = CommandLookupSchema.extend({ leaseId: id }).strict()
export type CommandLookup = z.infer<typeof CommandLookupSchema>
export type CommandLease = z.infer<typeof CommandLeaseSchema>
export type FlowCommandState =
  'pending' | 'unknown' | 'committed' | 'failed' | 'cancelled' | 'skipped'
export interface FlowCommandReceipt {
  commandId: string
  projectId: string
  taskId: string
  targetNodeId: string
  state: FlowCommandState
  runId: string
  nodeExecutionId?: string
  inputFingerprint?: string
  inputs: NodeExecuteCommand['inputs']
  outputRefs: z.infer<typeof AgentFlowAssetRefSchema>[]
  graphVersion?: number
  code?: string
}
export interface FlowCommandGrant {
  command: NodeExecuteCommand
  leaseId: string
  runId: string
  inputs: Array<{
    targetPortId: string
    versions: import('./assets').FlowAssetVersion[]
    sources?: Array<{ nodeId: string; portId: string }>
  }>
}
export type FlowCommandPrepareResult =
  | { state: 'ready'; grant: FlowCommandGrant }
  | { state: FlowCommandState; receipt: FlowCommandReceipt }
export class FlowCommandError extends Error {
  constructor(
    public readonly code: string,
    public readonly phase: string
  ) {
    super(code)
  }
}
