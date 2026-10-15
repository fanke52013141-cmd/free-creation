import type { ModelDefinition } from '@free-creation/model-contracts'
import { z } from 'zod'

/** Visual samples only: no audio, motion continuity or exhaustive-frame claim. */
export const VideoReviewEvidenceSchema = z
  .object({
    method: z.literal('four-frames-v1'),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    durationMs: z.number().int().min(1).max(60000),
    frames: z
      .array(
        z
          .object({
            timeMs: z.number().int().nonnegative(),
            contentSha256: z.string().regex(/^[a-f0-9]{64}$/)
          })
          .strict()
      )
      .length(4)
  })
  .strict()
  .refine(
    (evidence) =>
      evidence.frames.every(
        (frame, index) =>
          frame.timeMs < evidence.durationMs &&
          (!index || frame.timeMs > evidence.frames[index - 1].timeMs)
      ),
    'Video samples must be ordered and inside the video'
  )
export type VideoReviewEvidence = z.infer<typeof VideoReviewEvidenceSchema>
export interface VideoReviewSamples {
  evidence: VideoReviewEvidence
  images: Uint8Array[]
}

/** A registered and currently verified image-input operation; tool probes remain mandatory. */
export function supportsSampledVideoReview(
  model: Pick<ModelDefinition, 'enabled' | 'capabilities' | 'validation'>
): boolean {
  return (
    model.enabled &&
    model.capabilities.some(
      (capability) =>
        capability.operation === 'text.generate' && capability.acceptedAssetKinds.includes('image')
    ) &&
    model.validation['text.generate']?.status === 'verified'
  )
}
