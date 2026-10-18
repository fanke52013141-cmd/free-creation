import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowReviewHost } from '../src/main/agent-flow/review-host'
import { FlowReviewStore } from '../src/main/agent-flow/review-store'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import {
  bindCoordinatorReviews,
  CoordinatorReviews,
  assertCoordinatorReviewOutput
} from '../src/main/agent-flow/coordinator-reviews'
import type { CoordinationRun } from '../src/main/agent-flow/coordination-store'
import type { FlowAgentDesktopHost } from '../src/main/agent-flow/desktop-host'
import { videoReworkPrompt } from '../src/main/agent-flow/video-rework'
import { AgentTaskSnapshotSchema } from '../src/shared/agent-flow/runtime-contracts'
import { FlowTaskStore } from '../src/main/agent-flow/task-store'
import { nodeCommandIntentSignature } from '../src/main/agent-flow/command-intent'
import type { NodeExecuteCommand } from '../src/shared/agent-flow/commands'
import {
  sampleReviewVideo,
  assertVideoReviewEvidence,
  reviewVideoValue
} from '../src/main/agent-flow/video-review'
import { supportsSampledVideoReview } from '../src/shared/agent-flow/video-review'
import { supportsReviewAudioInput } from '../src/shared/agent-flow/media-review'
import type { ProjectFile } from '../src/shared/types'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import type { ReviewModelVerdict } from '../src/shared/agent-flow/review'
const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../src/main/store/db', () => ({ getDataDir: () => state.root }))
let db: Database.Database
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'canvas-video-review-'))
  mkdirSync(join(state.root, 'projects/p/media'), { recursive: true })
  db = new Database(':memory:')
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run(
    'p',
    'isolated'
  )
})
afterEach(() => {
  vi.unstubAllEnvs()
  db.close()
  if (
    resolve(state.root, '..') !== resolve(tmpdir()) ||
    !basename(state.root).startsWith('canvas-video-review-')
  )
    throw new Error('CLEANUP_REJECTED')
  rmSync(state.root, { recursive: true, force: true })
})
const request = {
  projectId: 'p',
  nodeId: 'review',
  requestId: 'first',
  traceId: 'trace',
  spanId: 'span'
}
function fixture(review?: AgentModelPort['review']) {
  const media = (id: string, file: string): void => {
    const bytes = readFileSync(join('test/fixtures', file))
    writeFileSync(join(state.root, `projects/p/media/${id}.mp4`), bytes)
    db.prepare(
      'INSERT INTO media(id,kind,mime,path,size_bytes,created_at) VALUES (?,?,?,?,?,0)'
    ).run(id, 'video', 'video/mp4', `projects/p/media/${id}.mp4`, bytes.length)
  }
  media('blue', 'agent-video.mp4')
  media('red', 'agent-review-red.mp4')
  const store = {
    source: {
      id: 'source',
      type: 'node-card',
      props: {
        nodeType: 'video-asset',
        title: 'source',
        config: '',
        text: '',
        mediaId: 'blue',
        mediaPath: 'projects/p/media/blue.mp4',
        mediaMime: 'video/mp4'
      },
      meta: {}
    },
    review: {
      id: 'review',
      type: 'node-card',
      props: {
        nodeType: 'ai-review',
        title: 'review',
        text: 'private-review-criteria',
        config: JSON.stringify({
          schemaVersion: 1,
          modelDefinitionId: 'model',
          rulesVersion: '1',
          reviewMode: 'sampled-video',
          rejectPolicy: 'rework',
          maxReworks: 1,
          responsibleNodeId: 'source',
          subjectSources: [{ nodeId: 'source', portId: 'out-video' }],
          gatedNodeIds: ['target'],
          relations: []
        })
      },
      meta: {} as Record<string, unknown>
    }
  }
  const file = {
    version: 1,
    meta: { id: 'p', name: 'p', graphVersion: 0, createdAt: 0, updatedAt: 0 },
    nodes: [
      {
        id: 'source',
        type: 'video-asset',
        contractVersion: 1,
        ports: [{ id: 'out-video', type: 'video', dir: 'out', cardinality: 'one', required: true }],
        params: {}
      },
      { id: 'review', type: 'ai-review', contractVersion: 1, ports: [], params: {} },
      { id: 'target', type: 'processor', contractVersion: 1, ports: [], params: {} }
    ],
    edges: [
      {
        id: 'edge',
        from: { nodeId: 'source', portId: 'out-video' },
        to: { nodeId: 'review', portId: 'in-video' }
      }
    ],
    groups: [],
    tldrawSnapshot: { store }
  } as unknown as ProjectFile
  let calls = 0
  const model: AgentModelPort = {
    decide: async () => ({ kind: 'wait' }),
    review:
      review ??
      (async (context) => {
        calls++
        expect(context.videoSamples?.images).toHaveLength(4)
        expect(
          context.videoSamples!.images.every((image) => image[0] === 255 && image[1] === 216)
        ).toBe(true)
        return {
          passed: store.source.props.mediaId === 'red',
          feedback: 'private-model-feedback',
          issues: []
        }
      })
  }
  const host = new FlowReviewHost(
    db,
    () => file,
    () => true,
    async (identity) => {
      expect(identity.requiresImageInput).toBe(true)
      return model
    }
  )
  const ledger = new FlowCommandLedger(db, () => file)
  const assets = new FlowAssetStore(db, () => file)
  const version = () =>
    assets.submit({
      projectId: 'p',
      nodeId: 'source',
      portId: 'out-video',
      expectedGraphVersion: 0,
      submissionId: 'input',
      traceId: 'trace',
      spanId: 'span'
    })
  const publish = (decision: unknown): void => {
    store.review.meta.nodeResult = JSON.stringify(decision)
    store.review.meta.nodeRun = { status: 'success', runId: 'review', startedAt: 0, inputs: [] }
  }
  return { store, file, host, ledger, assets, version, publish, calls: () => calls }
}
describe('fixed video sampled visual review', () => {
  it('decodes four real JPEGs, persists a negative report, replays without a model call, and admits only the new approved version', async () => {
    const f = fixture()
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).toThrow(
      'FLOW_REVIEW_NOT_READY'
    )
    const first = await f.host.run(request)
    expect(first).toMatchObject({
      passed: false,
      evidenceScope: 'sampled',
      videoEvidence: { method: 'four-frames-v1' }
    })
    f.publish(first)
    expect(await f.host.run(request)).toEqual(first)
    expect(f.calls()).toBe(1)
    Object.assign(f.store.source.props, { mediaId: 'red', mediaPath: 'projects/p/media/red.mp4' })
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).toThrow(
      'FLOW_REVIEW_NOT_READY'
    )
    await expect(f.host.run(request)).rejects.toMatchObject({ code: 'FLOW_REVISION_CONFLICT' })
    const approved = await f.host.run({ ...request, requestId: 'second' })
    expect(approved.passed).toBe(true)
    expect(approved.reviewRevision).toBe(1)
    expect(approved.subjects[0].versionId).not.toBe(first.subjects[0].versionId)
    f.publish(approved)
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).not.toThrow()
    const body = JSON.stringify(new FlowReviewStore(db).latest('p', 'review'))
    expect(body).not.toContain('data:image')
    expect(body).not.toContain(state.root)
    writeFileSync(join(state.root, 'projects/p/media/red.mp4'), 'changed')
    expect(() => f.ledger.assertNodeAvailable({ projectId: 'p', nodeId: 'target' })).toThrow(
      'FLOW_REVIEW_NOT_READY'
    )
    await expect(f.host.run({ ...request, requestId: 'cached' })).rejects.toThrow(
      'ASSET_VIDEO_CHANGED'
    )
  })
  it('does not commit a verdict after the fixed bytes change while the model is in flight', async () => {
    const f = fixture(async () => {
      writeFileSync(join(state.root, 'projects/p/media/blue.mp4'), 'changed')
      return { passed: true, feedback: 'late', issues: [] }
    })
    await expect(f.host.run(request)).rejects.toThrow('ASSET_VIDEO_CHANGED')
    expect(new FlowReviewStore(db).latest('p', 'review')).toBeNull()
  })
  it('reviews the exact committed generated-video ref without creating an unpermitted duplicate version', async () => {
    const f = fixture(),
      version = f.version()
    const { contentSha256, ...legacy } = version.value
    const body = JSON.stringify(legacy)
    db.prepare('UPDATE flow_asset_versions SET value_json=?,digest=? WHERE version_id=?').run(
      body,
      createHash('sha256').update(body).digest('hex'),
      version.ref.versionId
    )
    f.store.source.props.nodeType = 'video'
    f.store.source.props.title = ''
    Object.assign(f.store.source.meta, {
      nodeRun: { status: 'success', runId: 'generated-run', commandId: 'generated-command' },
      nodeResult: JSON.stringify({
        kind: 'media-source',
        version: 1,
        results: [
          {
            mediaId: 'blue',
            mediaPath: 'projects/p/media/blue.mp4',
            mime: 'video/mp4',
            createdAt: 0
          }
        ]
      })
    })
    Object.assign(
      f.file.nodes.find((node) => node.id === 'source')!,
      { type: 'video', contractVersion: 7 }
    )
    await expect(f.host.run(request)).rejects.toThrow('FLOW_VIDEO_REVIEW_NOT_FIXED')
    db.prepare('INSERT INTO flow_command_tasks VALUES (?,?,?,?)').run(
      'generated-task',
      'p',
      'specialist',
      8
    )
    db.prepare(
      'INSERT INTO flow_commands(project_id,command_id,signature,command_json,target_node_id,task_id,lease_id,owner_session,run_id,state,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)'
    ).run(
      'p',
      'generated-command',
      'signature',
      '{}',
      'source',
      'generated-task',
      'lease',
      'session',
      'generated-run',
      'committed',
      JSON.stringify({ outputRefs: [version.ref] })
    )
    db.prepare(
      "INSERT INTO tasks(id,provider_id,model_id,node_id,project_id,kind,status,input,output,created_at,updated_at) VALUES ('generated-video','provider','model','source','p','video','success','{}',?,0,0)"
    ).run(
      JSON.stringify({
        mediaId: 'blue',
        videoMaterialization: { phase: 'committed', digest: contentSha256 }
      })
    )
    const report = await f.host.run(request)
    expect(report.subjects).toEqual([version.ref])
    expect(report.videoEvidence?.contentSha256).toBe(contentSha256)
    expect(db.prepare('SELECT * FROM flow_asset_versions').all()).toHaveLength(1)
    expect(f.assets.read('p', version.ref.versionId).value).toEqual(legacy)
  })
  it('rejects video on text mode and multiple video sources before model invocation', async () => {
    const f = fixture()
    expect(() =>
      bindCoordinatorReviews(f.file, ['review'], [], new Set(['target']), 'task')
    ).toThrow('FLOW_REWORK_TARGET_UNSUPPORTED')
    const config = JSON.parse(f.store.review.props.config)
    f.store.review.props.config = JSON.stringify({ ...config, reviewMode: 'text-json' })
    await expect(f.host.run(request)).rejects.toMatchObject({ code: 'FLOW_REVIEW_SUBJECT_INVALID' })
    f.store.review.props.config = JSON.stringify({
      ...config,
      subjectSources: [...config.subjectSources, ...config.subjectSources]
    })
    await expect(f.host.run(request)).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
  it('rejects missing, oversized, MIME-mismatched and corrupt video without producing an approval', async () => {
    const f = fixture(),
      value = f.version().value
    db.prepare("UPDATE media SET size_bytes=20971521 WHERE id='blue'").run()
    await expect(sampleReviewVideo(db, 'p', value, new AbortController().signal)).rejects.toThrow(
      'ASSET_VIDEO_CHANGED'
    )
    db.prepare("UPDATE media SET size_bytes=?,mime='video/webm' WHERE id='blue'").run(
      readFileSync(join(state.root, 'projects/p/media/blue.mp4')).length
    )
    await expect(sampleReviewVideo(db, 'p', value, new AbortController().signal)).rejects.toThrow(
      'ASSET_VIDEO_CHANGED'
    )
    unlinkSync(join(state.root, 'projects/p/media/blue.mp4'))
    await expect(sampleReviewVideo(db, 'p', value, new AbortController().signal)).rejects.toThrow(
      'ASSET_VIDEO_CHANGED'
    )
    writeFileSync(join(state.root, 'projects/p/media/blue.mp4'), 'not-video')
    db.prepare("UPDATE media SET size_bytes=9,mime='video/mp4' WHERE id='blue'").run()
    const corrupt = {
      ...value,
      contentSha256: createHash('sha256').update('not-video').digest('hex')
    }
    await expect(
      sampleReviewVideo(db, 'p', corrupt, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'FLOW_VIDEO_REVIEW_DECODE_FAILED' })
  })
  it('requires a retained, committed digest for generated legacy versions and checks its actual bytes', async () => {
    const f = fixture(),
      version = f.version(),
      value = { ...version.value, contentSha256: undefined }
    expect(() => reviewVideoValue(db, 'p', value, 'generated')).toThrow(
      'FLOW_VIDEO_REVIEW_NOT_FIXED'
    )
    // A legacy version cannot gain evidence merely by reading today's mutable media file.
    expect(() =>
      assertVideoReviewEvidence(db, 'p', {
        evidenceScope: 'sampled',
        subjects: [version.ref]
      } as never)
    ).toThrow()
    const output = {
      mediaId: 'blue',
      videoMaterialization: { phase: 'prepared', digest: version.value.contentSha256 }
    }
    db.prepare(
      "INSERT INTO tasks(id,provider_id,model_id,node_id,project_id,kind,status,input,output,created_at,updated_at) VALUES ('generated-task','provider','model','generated','p','video','success','{}',?,0,0)"
    ).run(JSON.stringify(output))
    expect(() => reviewVideoValue(db, 'p', value, 'generated')).toThrow(
      'FLOW_VIDEO_REVIEW_NOT_FIXED'
    )
    output.videoMaterialization.phase = 'committed'
    db.prepare("UPDATE tasks SET output=? WHERE id='generated-task'").run(JSON.stringify(output))
    const fixed = reviewVideoValue(db, 'p', value, 'generated')
    expect(fixed.contentSha256).toBe(version.value.contentSha256)
    expect(
      (await sampleReviewVideo(db, 'p', fixed, new AbortController().signal)).images
    ).toHaveLength(4)
    writeFileSync(join(state.root, 'projects/p/media/blue.mp4'), 'changed')
    await expect(sampleReviewVideo(db, 'p', fixed, new AbortController().signal)).rejects.toThrow(
      'ASSET_VIDEO_CHANGED'
    )
  })
  it('cancels actual local sampling before any approval', async () => {
    const f = fixture(),
      signal = new AbortController(),
      value = f.version().value
    const sampling = sampleReviewVideo(db, 'p', value, signal.signal)
    signal.abort()
    await expect(sampling).rejects.toMatchObject({ code: 'AGENT_CANCELLED_OR_TIMED_OUT' })
    expect(new FlowReviewStore(db).latest('p', 'review')).toBeNull()
  })
  it('fails safely when the local decoder is unavailable', async () => {
    const f = fixture()
    vi.stubEnv('CANVAS_STUDIO_FFMPEG_PATH', join(state.root, 'missing-ffmpeg.exe'))
    await expect(
      sampleReviewVideo(db, 'p', f.version().value, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'FLOW_VIDEO_REVIEW_TOOL_UNAVAILABLE' })
  })
  it('requires both declared image input and current operation validation', () => {
    const model = {
      enabled: true,
      capabilities: [
        {
          operation: 'text.generate' as const,
          asynchronous: false,
          streaming: true,
          acceptedAssetKinds: ['image' as const],
          producedAssetKinds: [],
          controls: {}
        }
      ],
      validation: { 'text.generate': { status: 'verified' as const } }
    }
    expect(supportsSampledVideoReview(model)).toBe(true)
    expect(supportsSampledVideoReview({ ...model, enabled: false })).toBe(false)
    expect(supportsSampledVideoReview({ ...model, validation: {} })).toBe(false)
    expect(
      supportsSampledVideoReview({
        ...model,
        capabilities: [{ ...model.capabilities[0], acceptedAssetKinds: [] }]
      })
    ).toBe(false)
  })
  it('requires declared audio input and current operation validation', () => {
    const model = {
      enabled: true,
      capabilities: [
        {
          operation: 'text.generate' as const,
          asynchronous: false,
          streaming: true,
          acceptedAssetKinds: ['audio' as const],
          producedAssetKinds: [],
          controls: {}
        }
      ],
      validation: { 'text.generate': { status: 'verified' as const } }
    }
    expect(supportsReviewAudioInput(model)).toBe(true)
    expect(supportsReviewAudioInput({ ...model, enabled: false })).toBe(false)
    expect(supportsReviewAudioInput({ ...model, validation: {} })).toBe(false)
    expect(
      supportsReviewAudioInput({
        ...model,
        capabilities: [{ ...model.capabilities[0], acceptedAssetKinds: [] }]
      })
    ).toBe(false)
    expect(
      supportsReviewAudioInput({
        ...model,
        capabilities: [{ ...model.capabilities[0], acceptedAssetKinds: ['image'] }]
      })
    ).toBe(false)
  })
})

async function reworkFixture() {
  const f = fixture()
  const decision = await f.host.run(request)
  const snapshot = AgentTaskSnapshotSchema.parse({
    runtimeVersion: 1,
    projectId: 'p',
    agentNodeId: 'specialist',
    taskId: 'rework',
    parentTaskId: 'initial',
    coordinatorTaskId: 'flow',
    semanticRevision: `sha256:${'a'.repeat(64)}`,
    config: {
      schemaVersion: 1,
      role: 'specialist',
      interactionMode: 'autonomous',
      modelDefinitionId: 'model',
      skills: [],
      tools: [{ id: 'node.execute', version: '1' }],
      allowedNodeIds: ['source'],
      maxSteps: 8,
      relations: []
    },
    goal: 'private-goal',
    targets: [{ nodeId: 'source', contractVersion: 7, inputs: [] }],
    traceId: 'trace',
    spanId: 'span',
    rework: {
      originalTaskId: 'initial',
      reviewId: decision.reviewId,
      reviewNodeId: 'review',
      rulesVersion: decision.rulesVersion,
      rejectedOutputs: decision.subjects,
      criteria: 'private-review-criteria',
      feedback: decision.feedback,
      round: 1,
      videoTargetNodeId: 'source'
    }
  })
  new FlowTaskStore(db).create(snapshot, [])
  db.prepare("UPDATE flow_agent_tasks SET state='running' WHERE task_id='rework'").run()
  db.prepare('INSERT INTO flow_coordination_runs VALUES (?,?,?,?)').run(
    'p',
    'main',
    'flow',
    JSON.stringify({
      state: 'running',
      reviews: [{ responsibleNodeId: 'specialist', reworkTaskId: 'rework' }]
    })
  )
  const command: NodeExecuteCommand = {
    schemaVersion: 1,
    kind: 'node.execute',
    commandId: 'command',
    projectId: 'p',
    agentNodeId: 'specialist',
    taskId: 'rework',
    targetNodeId: 'source',
    contractVersion: 7,
    inputs: [],
    expectedSemanticRevision: snapshot.semanticRevision,
    traceId: 'trace',
    spanId: 'span',
    videoRework: { reviewId: decision.reviewId, round: 1 }
  }
  return { ...f, command, snapshot }
}

describe('authorized sampled video rework', () => {
  it('uses the same exact-version guard in normal review and saved-report recovery', async () => {
    const f = await reworkFixture(),
      decision = new FlowReviewStore(db).latest('p', 'review')!.decision
    expect(() =>
      assertCoordinatorReviewOutput(f.file, 'review', decision, decision.subjects)
    ).not.toThrow()
    expect(() => assertCoordinatorReviewOutput(f.file, 'review', decision, [])).toThrow(
      'FLOW_REVIEW_NOT_READY'
    )
    expect(() =>
      assertCoordinatorReviewOutput(f.file, 'review', decision, [
        { ...decision.subjects[0], versionId: 'another-version' }
      ])
    ).toThrow('FLOW_REVIEW_NOT_READY')
    expect(() =>
      assertCoordinatorReviewOutput(f.file, 'review', decision, [
        { ...decision.subjects[0], sourceNodeId: 'foreign' }
      ])
    ).toThrow('FLOW_REVIEW_NOT_READY')
  })
  it.each(['stop', 'round-limit', 'total-budget', 'cancelled'])(
    'keeps the video downstream blocked for %s without starting another specialist',
    async (reason) => {
      const f = await reworkFixture()
      const decision = new FlowReviewStore(db).latest('p', 'review')!.decision
      f.store.review.props.config = JSON.stringify({
        ...JSON.parse(f.store.review.props.config),
        responsibleNodeId: 'specialist',
        rejectPolicy: reason === 'stop' ? 'stop' : 'rework'
      })
      const run = {
        projectId: 'p',
        nodeId: 'main',
        taskId: 'flow',
        state: 'running',
        config: f.snapshot.config,
        decisions: reason === 'total-budget' ? f.snapshot.config.maxSteps : 0,
        children: [],
        reviews: [
          {
            nodeId: 'review',
            responsibleNodeId: 'specialist',
            requestId: 'review',
            state: 'rejected',
            round: reason === 'round-limit' ? 1 : 0,
            decision
          }
        ]
      } as unknown as CoordinationRun
      const prepareRework = vi.fn(),
        start = vi.fn(),
        publish = vi.fn()
      const control = new CoordinatorReviews(
        db,
        () => f.file,
        { prepareRework, run: start } as unknown as FlowAgentDesktopHost,
        publish,
        () => f.file
      )
      const signal = new AbortController()
      if (reason === 'cancelled') signal.abort()
      await expect(control.step(run, signal.signal)).rejects.toMatchObject({
        code:
          reason === 'stop'
            ? 'FLOW_REVIEW_STOPPED'
            : reason === 'round-limit'
              ? 'FLOW_REVIEW_BUDGET_EXHAUSTED'
              : reason === 'total-budget'
                ? 'AGENT_BUDGET_EXHAUSTED'
                : 'AGENT_CANCELLED'
      })
      expect(prepareRework).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    }
  )
  it('binds one controlled video target to its specialist, and rejects foreign, manual and self-gated targets', () => {
    const f = fixture()
    const agent = {
      id: 'specialist',
      type: 'node-card',
      props: {
        nodeType: 'agent',
        title: 'specialist',
        text: 'goal',
        config: JSON.stringify({
          schemaVersion: 1,
          role: 'specialist',
          interactionMode: 'autonomous',
          modelDefinitionId: 'model',
          skills: [],
          tools: [{ id: 'node.execute', version: '1' }],
          allowedNodeIds: ['source'],
          maxSteps: 8,
          relations: []
        })
      },
      meta: {}
    }
    Object.assign((f.file.tldrawSnapshot as { store: Record<string, unknown> }).store, {
      specialist: agent
    })
    f.file.nodes.find((node) => node.id === 'source')!.type = 'video'
    f.store.source.props.nodeType = 'video'
    f.file.nodes.find((node) => node.id === 'source')!.contractVersion = 7
    const config = { ...JSON.parse(f.store.review.props.config), responsibleNodeId: 'specialist' }
    f.store.review.props.config = JSON.stringify(config)
    expect(
      bindCoordinatorReviews(
        f.file,
        ['review'],
        ['specialist'],
        new Set(['source', 'target']),
        'flow'
      )[0].responsibleNodeId
    ).toBe('specialist')
    for (const controls of [new Set(['target']), new Set(['source'])])
      expect(() =>
        bindCoordinatorReviews(f.file, ['review'], ['specialist'], controls, 'flow')
      ).toThrow()
    f.store.review.props.config = JSON.stringify({ ...config, gatedNodeIds: ['source'] })
    expect(() =>
      bindCoordinatorReviews(
        f.file,
        ['review'],
        ['specialist'],
        new Set(['source', 'target']),
        'flow'
      )
    ).toThrow('FLOW_REWORK_TARGET_UNSUPPORTED')
  })
  it('adds only persisted criteria and feedback to a new bounded prompt without mutating the original task or command', async () => {
    const f = await reworkFixture(),
      before = JSON.stringify(f.command)
    const result = videoReworkPrompt(db, f.command, 'private-base')
    expect(result).toContain('private-base')
    expect(result).toContain('private-review-criteria')
    expect(result).toContain('private-model-feedback')
    expect(result).toContain('四张抽样画面')
    expect(JSON.stringify(f.command)).toBe(before)
    expect(videoReworkPrompt(db, { ...f.command, videoRework: undefined }, 'private-base')).toBe(
      'private-base'
    )
    expect(nodeCommandIntentSignature(f.command)).not.toBe(
      nodeCommandIntentSignature({ ...f.command, videoRework: undefined })
    )
    expect(() => videoReworkPrompt(db, f.command, 'x'.repeat(32768))).toThrow(
      'FLOW_VIDEO_REWORK_INVALID'
    )
  })
  it('uses a command-bound revision proposal while retaining the fixed goal, material and review feedback', async () => {
    const f = await reworkFixture(),
      before = JSON.stringify(f.snapshot)
    const proposed = {
      ...f.command,
      videoRework: { ...f.command.videoRework!, prompt: 'private-revision: make the scene red' }
    }
    const result = videoReworkPrompt(db, proposed, 'private-base')
    for (const text of [
      'private-base',
      'private-revision: make the scene red',
      'private-review-criteria',
      'private-model-feedback'
    ])
      expect(result).toContain(text)
    expect(nodeCommandIntentSignature(proposed)).not.toBe(nodeCommandIntentSignature(f.command))
    expect(JSON.stringify(f.snapshot)).toBe(before)
    expect(f.command.videoRework!.prompt).toBeUndefined()
  })
  it.each([
    'wrong-round',
    'wrong-review',
    'wrong-target',
    'stopped',
    'tampered-feedback',
    'changed-media'
  ])('blocks %s before a new supplier task', async (reason) => {
    const f = await reworkFixture()
    if (reason === 'wrong-round') f.command.videoRework!.round = 2
    if (reason === 'wrong-review') f.command.videoRework!.reviewId = 'foreign'
    if (reason === 'wrong-target') f.command.targetNodeId = 'foreign'
    if (reason === 'stopped')
      db.prepare('UPDATE flow_coordination_runs SET body_json=?').run(
        JSON.stringify({ state: 'cancelled' })
      )
    if (reason === 'tampered-feedback') {
      f.snapshot.rework!.feedback = 'forged'
      db.prepare('UPDATE flow_agent_tasks SET snapshot_json=?').run(JSON.stringify(f.snapshot))
    }
    if (reason === 'changed-media')
      writeFileSync(join(state.root, 'projects/p/media/blue.mp4'), 'changed')
    expect(() => videoReworkPrompt(db, f.command, 'base')).toThrow('FLOW_VIDEO_REWORK_INVALID')
  })
})
