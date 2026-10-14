import { z } from 'zod'
import { AgentFlowAssetRefSchema, AgentNodeConfigSchema } from './node-contracts'
import { FixedNodeInputSchema } from './commands'

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
export const SkillBindingSchema = z.object({ id, version: id }).strict()
export const SkillPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    version: id,
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    instructions: z.string().min(1).max(32768),
    requiredTools: z.array(SkillBindingSchema).max(32),
    resources: z.record(z.string().regex(/^[a-zA-Z0-9_-]+\.md$/), z.string().max(32768))
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Object.keys(value.resources).length > 16 ||
      JSON.stringify(value).length > 131072 ||
      new Set(value.requiredTools.map((item) => item.id)).size !== value.requiredTools.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Skill package exceeds limits or duplicates tools'
      })
    }
  })
export type SkillPackage = z.infer<typeof SkillPackageSchema>
export interface FixedSkill extends SkillPackage {
  contentHash: string
}

export const AgentTaskSnapshotSchema = z
  .object({
    runtimeVersion: z.literal(1),
    projectId: id,
    agentNodeId: id,
    taskId: id,
    semanticRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    config: AgentNodeConfigSchema,
    goal: z.string().min(1).max(32768),
    scopeRevision: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    parentTaskId: id.optional(),
    coordinatorTaskId: id.optional(),
    humanFeedback: z.string().max(4096).optional(),
    rework: z
      .object({
        originalTaskId: id,
        reviewId: id,
        reviewNodeId: id,
        rulesVersion: id,
        rejectedOutputs: z.array(AgentFlowAssetRefSchema).min(1).max(128),
        criteria: z.string().min(1).max(32768),
        feedback: z.string().min(1).max(16384),
        round: z.number().int().min(1).max(10)
      })
      .strict()
      .optional(),
    directInputs: z.array(AgentFlowAssetRefSchema).max(128).default([]),
    targets: z
      .array(
        z
          .object({
            nodeId: id,
            contractVersion: z.union([z.literal(1), z.literal(7)]),
            inputs: z.array(FixedNodeInputSchema).max(128)
          })
          .strict()
      )
      .min(1)
      .max(128),
    maxDecisions: z.number().int().min(1).max(64).default(12),
    maxTools: z.number().int().min(1).max(64).default(20),
    maxActiveMs: z.number().int().min(1).max(600000).default(600000),
    traceId: id,
    spanId: id
  })
  .strict()
  .superRefine((value, context) => {
    const references =
      value.directInputs.length +
      value.targets.reduce(
        (total, target) =>
          total + target.inputs.reduce((count, port) => count + port.assets.length, 0),
        0
      )
    if (
      references > 128 ||
      new Set(value.targets.map((item) => item.nodeId)).size !== value.targets.length ||
      value.targets.some(
        (item) =>
          !value.config.allowedNodeIds.includes(item.nodeId) || item.nodeId === value.agentNodeId
      ) ||
      new Set(value.config.skills.map((item) => item.id)).size !== value.config.skills.length ||
      new Set(value.config.tools.map((item) => item.id)).size !== value.config.tools.length
    ) {
      context.addIssue({ code: 'custom', message: 'Task scope or bindings invalid' })
    }
  })
export type AgentTaskSnapshot = z.infer<typeof AgentTaskSnapshotSchema>
export const AgentDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('execute'), targetNodeId: id }).strict(),
  z
    .object({
      kind: z.literal('load-skill'),
      skillId: id,
      resource: z.string().max(128).optional()
    })
    .strict(),
  z.object({ kind: z.literal('wait') }).strict(),
  z
    .object({
      kind: z.literal('finish'),
      outputs: z.array(AgentFlowAssetRefSchema).min(1).max(128)
    })
    .strict()
])
export type AgentDecision = z.infer<typeof AgentDecisionSchema>
export const AgentResumeSchema = z
  .object({
    taskId: id,
    semanticRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    waitRevision: z.number().int().positive(),
    eventId: id,
    kind: z.enum(['human', 'reconcile']),
    accepted: z.boolean().optional(),
    feedback: z.string().max(4096).optional(),
    selectedOutputs: z.array(AgentFlowAssetRefSchema).max(2).optional()
  })
  .strict()
export type AgentResume = z.infer<typeof AgentResumeSchema>
export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: string,
    public readonly phase: string
  ) {
    super(code)
  }
}
