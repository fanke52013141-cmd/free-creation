import { z } from 'zod'

/** Closed set of buildable capabilities; the host owns every node/port/config mapping. */
export const FLOW_BUILDER_CAPABILITY_CATALOG = [
  { id: 'text-template@1', input: 'text', output: 'text' },
  { id: 'image-gen@3', input: 'text', output: 'image' },
  { id: 'image-edit@2', input: 'image', output: 'image' },
  { id: 'video@7', input: 'text', output: 'video' },
  { id: 'speech@4', input: 'text', output: 'audio' },
  { id: 'tts@4', input: 'audio', output: 'json' }
] as const

export const BuildCapabilitySchema = z.enum(
  FLOW_BUILDER_CAPABILITY_CATALOG.map((item) => item.id) as [string, ...string[]]
)
export type BuildCapability = z.infer<typeof BuildCapabilitySchema>

const buildReview = z
  .object({
    criteria: z.string().trim().min(1).max(4096),
    rejectPolicy: z.enum(['rework', 'stop']).default('rework'),
    maxReworks: z.number().int().min(0).max(3).default(1)
  })
  .strict()

const buildStep = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(4096),
    mode: z.enum(['autonomous', 'collaborative']),
    capability: BuildCapabilitySchema.default('text-template@1'),
    template: z.string().min(1).max(4096).optional(),
    instruction: z.string().trim().min(1).max(4000).optional(),
    review: buildReview.optional()
  })
  .strict()
  .superRefine((step, context) => {
    if (step.capability === 'text-template@1' && !step.template?.includes('{{value}}'))
      context.addIssue({ code: 'custom', message: 'Text templates must include {{value}}' })
    if (['image-gen@3', 'image-edit@2', 'video@7'].includes(step.capability) && !step.instruction)
      context.addIssue({
        code: 'custom',
        message: 'Media generation and edit capabilities require an instruction'
      })
    if (step.capability !== 'text-template@1' && step.template !== undefined)
      context.addIssue({ code: 'custom', message: 'Only text-template accepts template' })
    if (step.review && !['text-template@1', 'video@7'].includes(step.capability))
      context.addIssue({
        code: 'custom',
        message: 'Review is currently supported only for text-template and sampled video outputs'
      })
  })

export const BuildPlanSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    topology: z.enum(['sequential', 'parallel-fork']).default('sequential'),
    steps: z.array(buildStep).min(1).max(4)
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.topology === 'parallel-fork' && plan.steps.length < 2)
      context.addIssue({ code: 'custom', message: 'Parallel fork requires at least two branches' })
    if (plan.topology === 'sequential') {
      let output: 'text' | 'image' | 'video' | 'audio' | 'json' = 'text'
      for (const [index, step] of plan.steps.entries()) {
        const capability = FLOW_BUILDER_CAPABILITY_CATALOG.find(
          (item) => item.id === step.capability
        )!
        if (capability.input !== output)
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'capability'],
            message: `${step.capability} cannot follow ${output}`
          })
        output = capability.output
      }
    } else {
      for (const [index, step] of plan.steps.entries())
        if (!['text-template@1', 'image-gen@3', 'video@7', 'speech@4'].includes(step.capability))
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'capability'],
            message: `${step.capability} cannot start from a text branch`
          })
    }
  })
export type BuildPlan = z.infer<typeof BuildPlanSchema>
export interface BuildContext {
  goal: string
  capabilityCatalog: typeof FLOW_BUILDER_CAPABILITY_CATALOG
  topologies: readonly ['sequential', 'parallel-fork']
}
export interface BuildNode {
  id: string
  type:
    | 'agent'
    | 'processor'
    | 'state-machine'
    | 'image-gen'
    | 'image-edit'
    | 'video'
    | 'speech'
    | 'tts'
    | 'ai-review'
  title: string
  text: string
  config: string
  contractVersion: 1 | 2 | 3 | 4 | 7
  x: number
  y: number
}
export interface BuildEdge {
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}
export interface BuildPreview {
  buildId: string
  projectId: string
  nodeId: string
  semanticRevision: string
  state: 'preview' | 'committed' | 'discarded'
  plan: BuildPlan
  nodes: BuildNode[]
  edges: BuildEdge[]
}
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
export const BuildRequestSchema = z
  .object({
    projectId: id,
    nodeId: id,
    action: z.enum(['inspect', 'propose', 'authorize', 'confirm', 'discard']),
    requestId: id.optional(),
    traceId: id.optional(),
    spanId: id.optional(),
    buildId: id.optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.action === 'propose' && !v.requestId) ||
      (!['inspect', 'propose'].includes(v.action) && !v.buildId)
    )
      ctx.addIssue({ code: 'custom', message: 'Missing operation identity' })
  })
export type BuildRequest = z.infer<typeof BuildRequestSchema>
