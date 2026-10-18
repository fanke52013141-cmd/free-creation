import { describe, expect, it } from 'vitest'
import {
  ImageReviewEvidenceSchema,
  AudioReviewEvidenceSchema,
  AudioVideoTimelineEvidenceSchema
} from '../src/shared/agent-flow/media-review'
import { VideoReviewEvidenceSchema } from '../src/shared/agent-flow/video-review'

const hash = 'a'.repeat(64)
const frames = [0, 250, 500, 750].map((timeMs) => ({ timeMs, contentSha256: hash }))
const image = { method: 'full-image-v1', contentSha256: hash, mime: 'image/png', byteLength: 1 }
const audio = {
  method: 'full-audio-v1',
  sourceSha256: hash,
  contentSha256: hash,
  sourceMime: 'audio/wav',
  durationMs: 1000,
  sampleRate: 16000,
  channels: 1,
  byteLength: 32044
}
const timeline = {
  method: 'audio-video-timeline-v1',
  videoSha256: hash,
  videoDurationMs: 1000,
  videoFrameCount: 30,
  frameTimelineSha256: hash,
  videoStartMs: 0,
  audioStartMs: 100,
  audioDurationMs: 1000,
  audioEndMs: 1100,
  audioOffsetMs: 100,
  audioEndDeltaMs: 100,
  audioContentSha256: hash,
  audioByteLength: 32044,
  frames
}

describe('MED-01 image evidence size and format admission', () => {
  it.each([
    [20 * 1024 * 1024 - 1, true],
    [20 * 1024 * 1024, true],
    [20 * 1024 * 1024 + 1, false],
    [0, false]
  ])('bytes=%i accepted=%s', (byteLength, expected) => {
    expect(ImageReviewEvidenceSchema.safeParse({ ...image, byteLength }).success).toBe(expected)
  })
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'text/plain'])(
    'MIME=%s',
    (mime) => {
      expect(ImageReviewEvidenceSchema.safeParse({ ...image, mime }).success).toBe(
        ['image/png', 'image/jpeg', 'image/webp'].includes(mime)
      )
    }
  )
})
describe('MED-02 normalized audio evidence boundaries', () => {
  it.each([
    [59000, true],
    [60000, true],
    [61000, false]
  ])('duration=%i accepted=%s', (durationMs, expected) => {
    expect(AudioReviewEvidenceSchema.safeParse({ ...audio, durationMs }).success).toBe(expected)
  })
  it.each([
    [16000, 1, true],
    [44100, 1, false],
    [16000, 2, false],
    [48000, 2, false]
  ])('rate=%i channels=%i accepted=%s', (sampleRate, channels, expected) => {
    expect(AudioReviewEvidenceSchema.safeParse({ ...audio, sampleRate, channels }).success).toBe(
      expected
    )
  })
})
describe('MED-03 four-frame evidence admission', () => {
  const video = { method: 'four-frames-v1', contentSha256: hash, durationMs: 1000, frames }
  it('accepts four strictly ordered timestamps inside the fixed video', () => {
    expect(VideoReviewEvidenceSchema.safeParse(video).success).toBe(true)
  })
  it.each([
    ['three', frames.slice(0, 3)],
    ['five', [...frames, { timeMs: 900, contentSha256: hash }]],
    ['reversed', [...frames].reverse()],
    ['duplicate', [frames[0], frames[1], frames[1], frames[3]]],
    ['end-exclusive', [...frames.slice(0, 3), { timeMs: 1000, contentSha256: hash }]],
    ['negative', [{ timeMs: -1, contentSha256: hash }, ...frames.slice(1)]]
  ])('rejects %s frames', (_label, candidate) => {
    expect(VideoReviewEvidenceSchema.safeParse({ ...video, frames: candidate }).success).toBe(false)
  })
})
describe('MED-04 internally consistent audio/video evidence', () => {
  it('accepts an accurately represented delayed audio track', () => {
    expect(AudioVideoTimelineEvidenceSchema.safeParse(timeline).success).toBe(true)
  })
  it.each([
    ['offset', { audioOffsetMs: 101 }],
    ['end-delta', { audioEndDeltaMs: 101 }],
    ['unordered', { frames: [...frames].reverse() }],
    ['frame-end', { frames: [...frames.slice(0, 3), { timeMs: 1000, contentSha256: hash }] }]
  ])('rejects inconsistent %s', (_label, change) => {
    expect(AudioVideoTimelineEvidenceSchema.safeParse({ ...timeline, ...change }).success).toBe(
      false
    )
  })
  it('rejects an end timestamp inconsistent with audio start plus duration even if end-delta agrees', () => {
    expect(
      AudioVideoTimelineEvidenceSchema.safeParse({
        ...timeline,
        audioEndMs: 1200,
        audioEndDeltaMs: 200
      }).success
    ).toBe(false)
  })
  it.each([
    [3, false],
    [4, true],
    [6000, true],
    [6001, false]
  ])('frame count=%i accepted=%s', (videoFrameCount, expected) => {
    expect(
      AudioVideoTimelineEvidenceSchema.safeParse({ ...timeline, videoFrameCount }).success
    ).toBe(expected)
  })
})
