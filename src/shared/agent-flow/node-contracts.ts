import { z } from 'zod'
import { VideoReviewEvidenceSchema } from './video-review'
import {
  AudioReviewEvidenceSchema,
  AudioVideoTimelineEvidenceSchema,
  ImageReviewEvidenceSchema
} from './media-review'

// C1 protocol foundation for configuration-only NodeTypeSpecs; not a production scheduler.
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
const revision = z.number().int().nonnegative()
export const AgentFlowAssetRefSchema = z
  .object({
    assetId: id,
    versionId: id,
    sourceNodeId: id,
    sourcePortId: id
  })
  .strict()
export const AgentFlowRelationSchema = z
  .object({
    relationId: id,
    kind: z.enum(['controls', 'observes', 'review-gate', 'rework']),
    sourceNodeId: id,
    targetNodeId: id
  })
  .strict()
  .refine((value) => value.sourceNodeId !== value.targetNodeId, 'Self relations are not allowed')
const versionedBinding = z.object({ id, version: id }).strict()
export const AgentNodeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: z.enum(['builder', 'coordinator', 'specialist']),
    interactionMode: z.enum(['collaborative', 'autonomous']),
    modelDefinitionId: id.optional(),
    skills: z.array(versionedBinding).max(32),
    tools: z.array(versionedBinding).max(32),
    allowedNodeIds: z.array(id).max(128),
    maxSteps: z.number().int().min(1).max(64),
    maxParallelTasks: z.number().int().min(1).max(4).optional(),
    relations: z.array(AgentFlowRelationSchema).max(256)
  })
  .strict()
export function getAgentModelBindingStatus(
  rawConfig: unknown
): 'invalid' | 'missing' | 'configured' {
  let value = rawConfig
  if (typeof rawConfig === 'string') {
    try {
      value = JSON.parse(rawConfig)
    } catch {
      return 'invalid'
    }
  }
  const parsed = AgentNodeConfigSchema.safeParse(value)
  if (!parsed.success) return 'invalid'
  return parsed.data.modelDefinitionId?.trim() ? 'configured' : 'missing'
}
export const ReviewNodeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    rulesVersion: id,
    reviewMode: z.enum(['text-json', 'sampled-video', 'image', 'audio', 'audio-video']).optional(),
    modelDefinitionId: id.optional(),
    rejectPolicy: z.enum(['rework', 'stop']),
    maxReworks: z.number().int().min(0).max(10),
    responsibleNodeId: id.optional(),
    subjectSources: z.array(z.object({ nodeId: id, portId: id }).strict()).max(128),
    gatedNodeIds: z.array(id).max(128),
    relations: z.array(AgentFlowRelationSchema).max(256)
  })
  .strict()
export const StateMachineNodeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    initialState: id,
    states: z.array(id).min(1).max(64),
    transitions: z.array(z.object({ from: id, event: id, to: id }).strict()).max(256),
    relations: z.array(AgentFlowRelationSchema).max(256)
  })
  .strict()
  .superRefine((config, context) => {
    const states = new Set(config.states)
    if (states.size !== config.states.length || !states.has(config.initialState)) {
      context.addIssue({
        code: 'custom',
        message: 'States must be unique and include initialState'
      })
    }
    const transitions = new Set<string>()
    for (const item of config.transitions) {
      const key = JSON.stringify([item.from, item.event])
      if (!states.has(item.from) || !states.has(item.to) || transitions.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'Transitions must reference states and be deterministic'
        })
      }
      transitions.add(key)
    }
  })
export const ReviewDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewId: id,
    cycleId: id,
    reviewNodeId: id,
    reviewRevision: revision,
    rulesVersion: id,
    subjects: z.array(AgentFlowAssetRefSchema).min(1).max(128),
    passed: z.boolean(),
    feedback: z.string().min(1).max(16384),
    evidenceScope: z.enum([
      'complete-text-json',
      'complete-image',
      'complete-audio',
      'sampled',
      'audio-video-timeline',
      'partial'
    ]),
    videoEvidence: VideoReviewEvidenceSchema.optional(),
    imageEvidence: ImageReviewEvidenceSchema.optional(),
    audioEvidence: AudioReviewEvidenceSchema.optional(),
    audioVideoEvidence: AudioVideoTimelineEvidenceSchema.optional(),
    issues: z
      .array(
        z.object({ assetId: id, versionId: id, feedback: z.string().min(1).max(4096) }).strict()
      )
      .max(128)
  })
  .strict()
  .superRefine((report, context) => {
    const refs = new Set(
      report.subjects.map((item) => JSON.stringify([item.assetId, item.versionId]))
    )
    if (
      (report.videoEvidence &&
        (report.evidenceScope !== 'sampled' || report.subjects.length !== 1)) ||
      (report.imageEvidence &&
        (report.evidenceScope !== 'complete-image' || report.subjects.length !== 1)) ||
      (report.audioEvidence &&
        (report.evidenceScope !== 'complete-audio' || report.subjects.length !== 1)) ||
      (report.audioVideoEvidence &&
        (report.evidenceScope !== 'audio-video-timeline' || report.subjects.length !== 1)) ||
      [report.videoEvidence, report.imageEvidence, report.audioEvidence, report.audioVideoEvidence]
        .filter(Boolean).length > 1 ||
      refs.size !== report.subjects.length ||
      report.issues.some((issue) => !refs.has(JSON.stringify([issue.assetId, issue.versionId])))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Review evidence must address unique submitted versions'
      })
    }
  })
export const FlowStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: id,
    stateNodeId: id,
    revision,
    state: id,
    lastEventId: id.optional()
  })
  .strict()

export type FlowState = z.infer<typeof FlowStateSchema>

export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>
export type AgentFlowAssetRef = z.infer<typeof AgentFlowAssetRefSchema>

/** An approval is valid only for the identical submitted version set and rules revision. */
export function matchesReviewApproval(
  report: unknown,
  expected: {
    reviewNodeId: string
    reviewRevision: number
    rulesVersion: string
    subjects: AgentFlowAssetRef[]
  }
): boolean {
  const parsed = ReviewDecisionSchema.safeParse(report)
  if (!parsed.success || !parsed.data.passed || parsed.data.evidenceScope !== 'complete-text-json')
    return false
  const decision = parsed.data
  if (
    decision.reviewNodeId !== expected.reviewNodeId ||
    decision.reviewRevision !== expected.reviewRevision ||
    decision.rulesVersion !== expected.rulesVersion
  )
    return false
  const keys = (values: AgentFlowAssetRef[]): string[] =>
    values
      .map((item) =>
        JSON.stringify([item.assetId, item.versionId, item.sourceNodeId, item.sourcePortId])
      )
      .sort()
  return JSON.stringify(keys(decision.subjects)) === JSON.stringify(keys(expected.subjects))
}

export const DEFAULT_AGENT_NODE_CONFIG = AgentNodeConfigSchema.parse({
  schemaVersion: 1,
  role: 'specialist',
  interactionMode: 'collaborative',
  skills: [],
  tools: [],
  allowedNodeIds: [],
  maxSteps: 12,
  relations: []
})
export const DEFAULT_REVIEW_NODE_CONFIG = ReviewNodeConfigSchema.parse({
  schemaVersion: 1,
  rulesVersion: 'rules-1',
  rejectPolicy: 'rework',
  maxReworks: 3,
  subjectSources: [],
  gatedNodeIds: [],
  relations: []
})
export const DEFAULT_STATE_NODE_CONFIG = StateMachineNodeConfigSchema.parse({
  schemaVersion: 1,
  initialState: 'draft',
  states: ['draft', 'working', 'reviewing', 'completed', 'stopped'],
  transitions: [],
  relations: []
})
