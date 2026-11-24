import { z } from 'zod'
import { planCapabilityCatalog, planCapabilitySurface } from './capability-catalog'

/**
 * 计划面（上帝 Agent 可用的建图能力）从统一能力目录生成（BL-10 / NF-13.3）：
 * 这里不再维护第二份 7 项白名单，只投影目录里声明了计划面的能力。
 */
export const FLOW_BUILDER_CAPABILITY_CATALOG = planCapabilityCatalog().map(({ id, plan }) => ({
  id,
  input: plan.inputType,
  output: plan.outputType
}))

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
    const surface = planCapabilitySurface(step.capability)
    if (!surface) {
      context.addIssue({ code: 'custom', message: `Unknown build capability ${step.capability}` })
      return
    }
    if (surface.template === 'required' && !step.template?.includes('{{value}}'))
      context.addIssue({ code: 'custom', message: 'Text templates must include {{value}}' })
    if (surface.template === 'forbidden' && step.template !== undefined)
      context.addIssue({ code: 'custom', message: `Capability ${step.capability} does not accept template` })
    if (surface.instruction === 'required' && !step.instruction)
      context.addIssue({
        code: 'custom',
        message: 'Media generation and edit capabilities require an instruction'
      })
    if (surface.instruction === 'forbidden' && step.instruction !== undefined)
      context.addIssue({
        code: 'custom',
        message: `Capability ${step.capability} does not accept an instruction`
      })
    if (step.review && !surface.reviewable)
      context.addIssue({
        code: 'custom',
        message: 'Review is currently supported only for text-template and sampled video outputs'
      })
  })

export const BuildPlanSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    topology: z.enum(['sequential', 'parallel-fork']).default('sequential'),
    steps: z.array(buildStep).min(1).max(8)
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
        if (
          !['text-template@1', 'text-pass@1', 'image-gen@3', 'video@7', 'speech@4'].includes(
            step.capability
          )
        )
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
