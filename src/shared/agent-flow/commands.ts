import { z } from 'zod'
import { AgentFlowAssetRefSchema } from './node-contracts'
import { ExecutionEnvelopeSchema } from './execution-envelope'

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
const NodeExecuteCommandObjectSchema = z
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
    videoRework: z
      .object({
        reviewId: id,
        round: z.number().int().min(1).max(10),
        prompt: z.string().trim().min(1).max(4096).optional()
      })
      .strict()
      .optional(),
    /** AF-03：执行信封（阶段目标/方法/人工意见/返工反馈），公共内容执行器显式消费。 */
    envelope: ExecutionEnvelopeSchema.optional(),
    /**
     * BL-40 / AF-10.4：能力节点上下文超限时，人工补料的精简文本。
     * 只由协调器在「等待补料 → 继续」时写入；渲染层把它作为该输入端口的文本值注入，
     * 不再走固定资产引用。缺省不出现，旧命令与服务端行为不变。
     */
    contextMaterial: z
      .object({
        targetPortId: id,
        text: z.string().trim().min(1).max(65536)
      })
      .strict()
      .optional(),
    scopedHumanTask: z.literal(true).optional(),
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
/**
 * JSON parsing preserves an own `__proto__` key, while object schema parsing may
 * drop it before strict-key validation. Reject that reserved key on the raw
 * value so malformed commands cannot reach ledger persistence or dispatch.
 */
export const NodeExecuteCommandSchema = z.preprocess((value, context) => {
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, '__proto__')
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Reserved prototype key' })
  }
  return value
}, NodeExecuteCommandObjectSchema)
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
  handoffNote?: string
  graphVersion?: number
  code?: string
}
export interface FlowCommandGrant {
  compositeResume?: {
    resumeRunId: string
    completedSteps: string[]
    stepOutputs: NonNullable<import('../engine/composite-run-contract').CompositeRunRequest['stepOutputs']>
    humanSubmissions: NonNullable<import('../engine/composite-run-contract').CompositeRunRequest['humanSubmissions']>
  }
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
