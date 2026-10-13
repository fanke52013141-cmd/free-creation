import { z } from 'zod'
import { ReviewDecisionSchema } from './node-contracts'
import type { NodeShape } from '../engine/executor-types'
import type { RawNodeOutputs } from '../engine/values'
import type { FlowAssetValue } from './assets'
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
export const ReviewRequestSchema = z
  .object({ projectId: id, nodeId: id, requestId: id, traceId: id, spanId: id })
  .strict()
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>
export const ReviewModelVerdictSchema = z
  .object({
    passed: z.boolean(),
    feedback: z.string().trim().min(1).max(16384),
    issues: z
      .array(
        z
          .object({
            subjectIndex: z.number().int().nonnegative(),
            feedback: z.string().trim().min(1).max(4096)
          })
          .strict()
      )
      .max(128)
  })
  .strict()
export type ReviewModelVerdict = z.infer<typeof ReviewModelVerdictSchema>
export interface ReviewContext {
  criteria: string
  subjects: FlowAssetValue[]
}
export function projectReviewOutputs(shape: NodeShape): RawNodeOutputs {
  try {
    const decision = ReviewDecisionSchema.parse(JSON.parse(shape.meta?.nodeResult ?? ''))
    return {
      'out-review': { kind: 'json', data: decision },
      'out-feedback': { kind: 'text', text: decision.feedback }
    }
  } catch {
    return {}
  }
}
