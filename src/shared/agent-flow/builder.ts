import { z } from 'zod'

// The first builder capability is a sequential text workflow, not arbitrary graph mutation.
export const BuildPlanSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    steps: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            goal: z.string().trim().min(1).max(4096),
            mode: z.enum(['autonomous', 'collaborative']),
            template: z
              .string()
              .min(1)
              .max(4096)
              .refine((s) => s.includes('{{value}}'))
          })
          .strict()
      )
      .min(1)
      .max(4)
  })
  .strict()
export type BuildPlan = z.infer<typeof BuildPlanSchema>
export interface BuildContext {
  goal: string
  capability: 'sequential-text-template@1'
}
export interface BuildNode {
  id: string
  type: 'agent' | 'processor' | 'state-machine'
  title: string
  text: string
  config: string
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
