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
