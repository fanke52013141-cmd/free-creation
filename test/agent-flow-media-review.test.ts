import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import { FlowReviewHost } from '../src/main/agent-flow/review-host'
import { assertReviewEvidenceForMode, FlowReviewStore, reviewBinding } from '../src/main/agent-flow/review-store'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import type { ProjectFile } from '../src/shared/types'
import type { ReviewContext } from '../src/shared/agent-flow/review'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../src/main/store/db', () => ({ getDataDir: () => state.root }))

let db: Database.Database
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'canvas-media-review-test-'))
  mkdirSync(join(state.root, 'projects/p/media'), { recursive: true })
  db = new Database(':memory:')
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run(
    'p',
    'media-review-test'
  )
})
afterEach(() => {
  vi.unstubAllEnvs()
  db.close()
  if (
    resolve(state.root, '..') !== resolve(tmpdir()) ||
    !basename(state.root).startsWith('canvas-media-review-test-')
  )
    throw new Error('CLEANUP_REJECTED')
  rmSync(state.root, { recursive: true, force: true })
})

type ReviewMode = 'image' | 'audio' | 'audio-video'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYawAAAAASUVORK5CYII=',
  'base64'
)
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function fixture(mode: ReviewMode) {
  const kind = mode === 'image' ? 'image' : mode === 'audio' ? 'audio' : 'video'
  const nodeType = kind === 'video' ? 'video-asset' : kind
  const portId = kind === 'image' ? 'out-image' : kind === 'audio' ? 'out-audio' : 'out-video'
  const inputPortId = kind === 'image' ? 'in-image' : kind === 'audio' ? 'in-audio' : 'in-video'
  const mime = kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/wav' : 'video/mp4'
  const extension = kind === 'image' ? 'png' : kind === 'audio' ? 'wav' : 'mp4'
  const mediaId = `fixture-${kind}`
  const mediaPath = `projects/p/media/${mediaId}.${extension}`
  const filePath = join(state.root, mediaPath)
  const sourceBytes =
    kind === 'image'
      ? png
      : kind === 'audio'
        ? readFileSync(join('test/fixtures', 'agent-audio.wav'))
        : (() => {
            const output = filePath
            execFileSync(
              process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim() || 'ffmpeg',
              [
                '-hide_banner',
                '-loglevel',
                'error',
                '-nostdin',
                '-y',
                '-i',
                join('test/fixtures', 'agent-review-red.mp4'),
                '-i',
                join('test/fixtures', 'agent-audio.wav'),
                '-map',
                '0:v:0',
                '-map',
                '1:a:0',
                '-c:v',
                'copy',
                '-c:a',
                'aac',
                '-shortest',
                '-movflags',
                '+faststart',
                output
              ],
              { windowsHide: true, stdio: 'ignore' }
            )
            return readFileSync(output)
          })()
  if (kind !== 'video') writeFileSync(filePath, sourceBytes)
  db.prepare(
    'INSERT INTO media(id,kind,mime,path,size_bytes,created_at) VALUES (?,?,?,?,?,0)'
  ).run(mediaId, kind, mime, mediaPath, sourceBytes.length)

  const sourceShape = {
    id: 'source',
    type: 'node-card',
    props: {
      nodeType,
      title: 'fixed subject',
      config: '',
      text: '',
      mediaId,
      mediaPath,
      mediaMime: mime,
      exec: '',
      w: 240,
      h: 160
    },
    meta: {} as Record<string, unknown>
  }
  const reviewShape = {
    id: 'review',
    type: 'node-card',
    props: {
      nodeType: 'ai-review',
      title: 'review',
      config: JSON.stringify({
        schemaVersion: 1,
        modelDefinitionId: 'fixture-model',
        rulesVersion: '1',
        reviewMode: mode,
        rejectPolicy: 'stop',
        maxReworks: 0,
        subjectSources: [{ nodeId: 'source', portId }],
        gatedNodeIds: [],
        relations: []
      }),
      text: 'Check the complete fixed input.',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: '',
      w: 240,
      h: 160
    },
    meta: {} as Record<string, unknown>
  }
  const file = {
    version: 1,
    meta: { id: 'p', name: 'p', graphVersion: 0, createdAt: 0, updatedAt: 0 },
    nodes: [
      {
        id: 'source',
        type: nodeType,
        contractVersion: 1,
        ports: [{ id: portId, type: kind, dir: 'out', cardinality: 'one', required: true }],
        params: {}
      },
      { id: 'review', type: 'ai-review', contractVersion: 1, ports: [], params: {} }
    ],
    edges: [
      {
        id: 'review-input',
        from: { nodeId: 'source', portId },
        to: { nodeId: 'review', portId: inputPortId }
      }
    ],
    groups: [],
    tldrawSnapshot: { store: { source: sourceShape, review: reviewShape } }
  } as unknown as ProjectFile
  const assets = new FlowAssetStore(db, () => file)
  const version = assets.submit({
    projectId: 'p',
    nodeId: 'source',
    portId,
    submissionId: 'seed',
    expectedGraphVersion: 0,
    traceId: 'trace',
    spanId: 'span'
  })
  sourceShape.meta.flowAssetRef = JSON.stringify(version.ref)
  sourceShape.meta.pinnedOutput = JSON.stringify({ version: 1, outputs: { [portId]: version.value } })

  let received: ReviewContext | undefined
  const model: AgentModelPort = {
    decide: async () => ({ kind: 'wait' }),
    review: async (context) => {
      received = context
      return { passed: true, feedback: 'accepted complete evidence', issues: [] }
    }
  }
  const host = new FlowReviewHost(
    db,
    () => file,
    () => true,
    async (identity) => {
      expect(identity.requiresImageInput).toBe(mode === 'image' || mode === 'audio-video')
      expect(identity.requiresAudioInput).toBe(mode === 'audio' || mode === 'audio-video')
      return model
    }
  )
  const publish = (decision: unknown): void => {
    reviewShape.meta.nodeResult = JSON.stringify(decision)
    reviewShape.meta.nodeRun = { status: 'success', runId: 'review-run', startedAt: 0, inputs: [] }
  }
  return { mode, file, filePath, sourceBytes, host, received: () => received, publish }
}

describe('fixed image, audio and audiovisual review', () => {
  it('MED-04 rejects inconsistent audio duration/end evidence at the saved-review media guard', async () => {
    const f = fixture('audio-video')
    const decision = await f.host.run({
      projectId: 'p', nodeId: 'review', requestId: 'av-inconsistent-end',
      traceId: 'trace', spanId: 'span'
    })
    expect(assertReviewEvidenceForMode(db, 'p', 'audio-video', decision)).toBe(true)
    const evidence = decision.audioVideoEvidence!
    expect(evidence.audioEndMs).toBe(evidence.audioStartMs + evidence.audioDurationMs)
    const inconsistent = {
      ...decision,
      audioVideoEvidence: {
        ...evidence,
        audioEndMs: evidence.audioEndMs + 100,
        audioEndDeltaMs: evidence.audioEndDeltaMs + 100
      }
    }
    expect(() => assertReviewEvidenceForMode(db, 'p', 'audio-video', inconsistent)).toThrow()
  })
  it('sends the full image bytes and invalidates a cached approval after source mutation', async () => {
    const f = fixture('image')
    const decision = await f.host.run({
      projectId: 'p',
      nodeId: 'review',
      requestId: 'image-review',
      traceId: 'trace',
      spanId: 'span'
    })
    expect(f.received()?.imageInput?.bytes).toEqual(f.sourceBytes)
    expect(decision).toMatchObject({ evidenceScope: 'complete-image', imageEvidence: { method: 'full-image-v1' } })
    f.publish(decision)
    const imageRecord = new FlowReviewStore(db).latest('p', 'review')!
    expect(imageRecord.signature).toBe(reviewBinding(f.file, 'review').signature)
    expect(assertReviewEvidenceForMode(db, 'p', 'image', decision)).toBe(true)
    expect(new FlowReviewStore(db).approval(f.file, 'review')).toEqual(
      expect.objectContaining({ decision })
    )
    const changed = Buffer.from(f.sourceBytes)
    changed[changed.length - 1] ^= 1
    writeFileSync(f.filePath, changed)
    expect(new FlowReviewStore(db).approval(f.file, 'review')).toBeNull()
    await expect(
      f.host.run({ projectId: 'p', nodeId: 'review', requestId: 'image-replay', traceId: 'trace', spanId: 'span' })
    ).rejects.toMatchObject({ code: 'ASSET_IMAGE_CHANGED' })
  })

  it('decodes and sends the complete bounded audio track, then invalidates its cached approval on mutation', async () => {
    const f = fixture('audio')
    const decision = await f.host.run({
      projectId: 'p',
      nodeId: 'review',
      requestId: 'audio-review',
      traceId: 'trace',
      spanId: 'span'
    })
    const input = f.received()?.audioInput
    expect(input?.mediaType).toBe('audio/wav')
    expect(input?.bytes.subarray(0, 12).toString()).toContain('RIFF')
    expect(decision).toMatchObject({ evidenceScope: 'complete-audio', audioEvidence: { method: 'full-audio-v1', durationMs: 1000, sampleRate: 16000, channels: 1 } })
    f.publish(decision)
    const audioRecord = new FlowReviewStore(db).latest('p', 'review')!
    expect(audioRecord.signature).toBe(reviewBinding(f.file, 'review').signature)
    expect(assertReviewEvidenceForMode(db, 'p', 'audio', decision)).toBe(true)
    expect(new FlowReviewStore(db).approval(f.file, 'review')).toEqual(
      expect.objectContaining({ decision })
    )
    const changed = Buffer.from(f.sourceBytes)
    changed[changed.length - 1] ^= 1
    writeFileSync(f.filePath, changed)
    expect(new FlowReviewStore(db).approval(f.file, 'review')).toBeNull()
    await expect(
      f.host.run({ projectId: 'p', nodeId: 'review', requestId: 'audio-replay', traceId: 'trace', spanId: 'span' })
    ).rejects.toMatchObject({ code: 'ASSET_AUDIO_CHANGED' })
  })

  it('sends the complete audio and frame-time digest with four explicit visual samples', async () => {
    const f = fixture('audio-video')
    const decision = await f.host.run({
      projectId: 'p',
      nodeId: 'review',
      requestId: 'av-review',
      traceId: 'trace',
      spanId: 'span'
    })
    const input = f.received()?.audioVideoInput
    expect(input?.frames).toHaveLength(4)
    expect(input?.frames.every((frame) => frame[0] === 255 && frame[1] === 216)).toBe(true)
    expect(input?.audioBytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(input?.evidence.videoFrameCount).toBeGreaterThan(4)
    expect(input?.evidence.frameTimelineSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(input?.evidence.audioDurationMs).toBeGreaterThan(0)
    expect(input?.evidence.frames.map((frame) => frame.timeMs)).toEqual(
      [...(input?.evidence.frames.map((frame) => frame.timeMs) ?? [])].sort((a, b) => a - b)
    )
    expect(decision).toMatchObject({
      evidenceScope: 'audio-video-timeline',
      audioVideoEvidence: { method: 'audio-video-timeline-v1' }
    })
    f.publish(decision)
    const avRecord = new FlowReviewStore(db).latest('p', 'review')!
    expect(avRecord.signature).toBe(reviewBinding(f.file, 'review').signature)
    expect(assertReviewEvidenceForMode(db, 'p', 'audio-video', decision)).toBe(true)
    expect(new FlowReviewStore(db).approval(f.file, 'review')).toEqual(
      expect.objectContaining({ decision })
    )
    const changed = Buffer.from(f.sourceBytes)
    changed[changed.length - 1] ^= 1
    writeFileSync(f.filePath, changed)
    expect(new FlowReviewStore(db).approval(f.file, 'review')).toBeNull()
    await expect(
      f.host.run({ projectId: 'p', nodeId: 'review', requestId: 'av-replay', traceId: 'trace', spanId: 'span' })
    ).rejects.toMatchObject({ code: 'ASSET_VIDEO_CHANGED' })
  })
})
