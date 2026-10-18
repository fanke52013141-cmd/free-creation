import type { ModelDefinition } from '@free-creation/model-contracts'
import { z } from 'zod'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const ImageReviewEvidenceSchema = z
  .object({
    method: z.literal('full-image-v1'),
    contentSha256: sha256,
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    byteLength: z.number().int().positive().max(20 * 1024 * 1024)
  })
  .strict()
export type ImageReviewEvidence = z.infer<typeof ImageReviewEvidenceSchema>
export interface ImageReviewInput {
  bytes: Uint8Array
  evidence: ImageReviewEvidence
}

export const AudioReviewEvidenceSchema = z
  .object({
    method: z.literal('full-audio-v1'),
    sourceSha256: sha256,
    contentSha256: sha256,
    sourceMime: z.string().regex(/^audio\/[a-z0-9.+-]+$/),
    durationMs: z.number().int().min(1).max(60000),
    sampleRate: z.literal(16000),
    channels: z.literal(1),
    byteLength: z.number().int().positive().max(2_000_044)
  })
  .strict()
export type AudioReviewEvidence = z.infer<typeof AudioReviewEvidenceSchema>
export interface AudioReviewInput {
  bytes: Uint8Array
  mediaType: 'audio/wav'
  evidence: AudioReviewEvidence
}

export const AudioVideoTimelineEvidenceSchema = z
  .object({
    method: z.literal('audio-video-timeline-v1'),
    videoSha256: sha256,
    videoDurationMs: z.number().int().min(100).max(60000),
    videoFrameCount: z.number().int().min(4).max(6000),
    frameTimelineSha256: sha256,
    videoStartMs: z.number().int().min(-60000).max(60000),
    audioStartMs: z.number().int().min(-60000).max(60000),
    audioDurationMs: z.number().int().min(1).max(60000),
    audioEndMs: z.number().int().min(-60000).max(120000),
    audioOffsetMs: z.number().int().min(-60000).max(60000),
    audioEndDeltaMs: z.number().int().min(-60000).max(60000),
    audioContentSha256: sha256,
    audioByteLength: z.number().int().positive().max(2_000_044),
    frames: z
      .array(
        z.object({ timeMs: z.number().int().nonnegative(), contentSha256: sha256 }).strict()
      )
      .length(4)
  })
  .strict()
  .refine(
    (value) =>
      value.audioOffsetMs === value.audioStartMs - value.videoStartMs &&
      value.audioEndMs === value.audioStartMs + value.audioDurationMs &&
      value.audioEndDeltaMs === value.audioEndMs - (value.videoStartMs + value.videoDurationMs) &&
      value.frames.every(
        (frame, index) =>
          frame.timeMs < value.videoDurationMs &&
          (!index || frame.timeMs > value.frames[index - 1].timeMs)
      ),
    'Audio/video timestamps must be internally consistent and ordered'
  )
export type AudioVideoTimelineEvidence = z.infer<typeof AudioVideoTimelineEvidenceSchema>
export interface AudioVideoReviewInput {
  frames: Uint8Array[]
  audioBytes: Uint8Array
  evidence: AudioVideoTimelineEvidence
}

/** Model capabilities are declared and probed separately; arbitrary text models are never assumed to hear audio. */
export function supportsReviewAudioInput(
  model: Pick<ModelDefinition, 'enabled' | 'capabilities' | 'validation'>
): boolean {
  return (
    model.enabled &&
    model.capabilities.some(
      (capability) =>
        capability.operation === 'text.generate' && capability.acceptedAssetKinds.includes('audio')
    ) &&
    model.validation['text.generate']?.status === 'verified'
  )
}
