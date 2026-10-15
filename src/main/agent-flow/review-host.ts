import {
  sampleReviewAudioVideo,
  sampleReviewVideo,
  prepareAudioReview,
  prepareImageReview,
  reviewVideoValue
} from './video-review'
import type Database from 'better-sqlite3'
import type { ProjectFile } from '../../shared/types'
import {
  AgentNodeConfigSchema,
  AgentFlowAssetRefSchema,
  ReviewDecisionSchema,
  type ReviewDecision
} from '../../shared/agent-flow/node-contracts'
import {
  ReviewRequestSchema,
  ReviewModelVerdictSchema,
  type ReviewRequest
} from '../../shared/agent-flow/review'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import {
  FlowReviewStore,
  assertReviewEvidenceForMode,
  reviewBinding,
  reviewDigest
} from './review-store'
import { FlowAssetStore } from './asset-store'
import {
  DETERMINISTIC_PROJECTIONS,
  readPinnedOutputs
} from '../../shared/engine/deterministic-projections'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import type { NodeShape } from '../../shared/engine/executor-types'
import type { AgentModelPort } from './runtime'
import type { ModelIdentity } from '../../shared/agent-flow/coordination'
import { controlledReview } from './coordination-store'

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new AgentRuntimeError('AGENT_CANCELLED_OR_TIMED_OUT', 'review'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export class FlowReviewHost {
  private readonly active = new Map<string, AbortController>()
  cancel(projectId: string, nodeId: string): void {
    this.active.get(JSON.stringify([projectId, nodeId]))?.abort()
  }
  private readonly store: FlowReviewStore
  private readonly assets: FlowAssetStore
  constructor(
    private readonly db: Database.Database,
    private readonly open: (id: string) => ProjectFile | null,
    private readonly isActive: (id: string) => boolean,
    private readonly model: (
      identity: ModelIdentity,
      signal: AbortSignal
    ) => Promise<AgentModelPort>
  ) {
    this.store = new FlowReviewStore(db)
    this.assets = new FlowAssetStore(db, open)
  }
  async run(raw: ReviewRequest): Promise<ReviewDecision> {
    const input = ReviewRequestSchema.parse(raw),
      file = this.open(input.projectId)
    if (!file || !this.isActive(input.projectId))
      throw new AgentRuntimeError('FLOW_PROJECT_INACTIVE', 'review')
    const binding = reviewBinding(file, input.nodeId)
    const reviewMode = binding.config.reviewMode ?? 'text-json'
    const replay = this.store.forRequest(input.projectId, input.requestId)
    if (replay) {
      if (replay.nodeId !== input.nodeId || replay.signature !== binding.signature)
        throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'review')
      if (!assertReviewEvidenceForMode(this.db, input.projectId, reviewMode, replay.decision))
        throw new AgentRuntimeError('FLOW_REVIEW_NOT_READY', 'review')
      return replay.decision
    }
    const previous = this.store.latest(input.projectId, input.nodeId)
    if (previous?.signature === binding.signature) {
      if (!assertReviewEvidenceForMode(this.db, input.projectId, reviewMode, previous.decision))
        throw new AgentRuntimeError('FLOW_REVIEW_NOT_READY', 'review')
      return previous.decision
    }
    const rejected = this.store.rejectedRounds(input.projectId, input.nodeId, binding.cycleId)
    if (rejected > binding.config.maxReworks)
      throw new AgentRuntimeError('FLOW_REVIEW_BUDGET_EXHAUSTED', 'review')
    const occupied = !!this.db
      .prepare('SELECT 1 FROM flow_coordination_scope WHERE project_id=? AND node_id=?')
      .get(input.projectId, input.nodeId)
    if (occupied && !controlledReview(this.db, input.projectId, input.nodeId, input.requestId))
      throw new AgentRuntimeError('FLOW_CONTROL_OCCUPIED', 'review')
    if (
      previous?.cycleId === binding.cycleId &&
      !previous.decision.passed &&
      binding.config.rejectPolicy === 'stop'
    )
      throw new AgentRuntimeError('FLOW_REVIEW_STOPPED', 'review')
    const key = JSON.stringify([input.projectId, input.nodeId])
    if (this.active.has(key)) throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'review')
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000)
    this.active.set(key, controller)
    try {
      const snapshot = (
        file.tldrawSnapshot as {
          store: Record<string, NodeShape & { meta?: Record<string, unknown> }>
        }
      ).store
      const refs = binding.config.subjectSources.map((source, i) => {
        const pinned = snapshot[source.nodeId]?.meta?.flowAssetRef
        if (typeof pinned === 'string') {
          const ref = AgentFlowAssetRefSchema.parse(JSON.parse(pinned))
          const value = this.assets.resolveInputs(input.projectId, [ref])[0].value
          if (
            canonicalFlowJson(
              readPinnedOutputs(snapshot[source.nodeId].meta?.pinnedOutput)?.[source.portId]
            ) !== canonicalFlowJson(value)
          )
            throw new AgentRuntimeError('AGENT_INPUT_NOT_FIXED', 'review')
          return ref
        }
        const sourceShape = snapshot[source.nodeId]
        if (
          ['sampled-video', 'audio-video'].includes(reviewMode) &&
          sourceShape.props.nodeType === 'video'
        ) {
          const commandId = (sourceShape.meta?.nodeRun as { commandId?: string } | undefined)
            ?.commandId
          const receipt =
            commandId &&
            (this.db
              .prepare(
                "SELECT receipt_json FROM flow_commands WHERE project_id=? AND command_id=? AND target_node_id=? AND state='committed'"
              )
              .get(input.projectId, commandId, source.nodeId) as
              { receipt_json: string } | undefined)
          const outputs = receipt ? JSON.parse(receipt.receipt_json).outputRefs : []
          if (!Array.isArray(outputs) || outputs.length !== 1)
            throw new AgentRuntimeError('FLOW_VIDEO_REVIEW_NOT_FIXED', 'review')
          const ref = AgentFlowAssetRefSchema.parse(outputs[0])
          const value = this.assets.resolveInputs(input.projectId, [ref])[0].value
          if (
            ref.sourceNodeId !== source.nodeId ||
            ref.sourcePortId !== source.portId ||
            canonicalFlowJson(DETERMINISTIC_PROJECTIONS.video(sourceShape)[source.portId]) !==
              canonicalFlowJson(value)
          )
            throw new AgentRuntimeError('FLOW_VIDEO_REVIEW_NOT_FIXED', 'review')
          return ref
        }
        if (['text', 'json'].includes(sourceShape.props.nodeType)) {
          const latest = this.assets.list(input.projectId, source.nodeId, source.portId)[0]
          const value =
            DETERMINISTIC_PROJECTIONS[sourceShape.props.nodeType as 'text' | 'json'](sourceShape)[
              source.portId
            ]
          if (
            latest &&
            value &&
            canonicalFlowJson(this.assets.read(input.projectId, latest.ref.versionId).value) ===
              canonicalFlowJson(value)
          )
            return latest.ref
        }
        return this.assets.submit({
          projectId: input.projectId,
          nodeId: source.nodeId,
          portId: source.portId,
          submissionId: `review-${reviewDigest([input.nodeId, binding.signature, i]).slice(0, 32)}`,
          expectedGraphVersion: file.meta.graphVersion,
          traceId: input.traceId,
          spanId: input.spanId
        }).ref
      })
      const subjects = this.assets
        .resolveInputs(input.projectId, refs)
        .map((v) =>
          ['sampled-video', 'audio-video'].includes(reviewMode)
            ? reviewVideoValue(this.db, input.projectId, v.value, v.ref.sourceNodeId)
            : v.value
        )
      if (
        Buffer.byteLength(JSON.stringify({ criteria: binding.shape.props.text, subjects })) > 131072
      )
        throw new AgentRuntimeError('AGENT_CONTEXT_TOO_LARGE', 'review')
      const videoSamples =
        reviewMode === 'sampled-video'
          ? await sampleReviewVideo(this.db, input.projectId, subjects[0], controller.signal)
          : undefined
      const imageInput =
        reviewMode === 'image'
          ? await prepareImageReview(this.db, input.projectId, subjects[0], controller.signal)
          : undefined
      const audioInput =
        reviewMode === 'audio'
          ? await prepareAudioReview(this.db, input.projectId, subjects[0], controller.signal)
          : undefined
      const audioVideoInput =
        reviewMode === 'audio-video'
          ? await sampleReviewAudioVideo(this.db, input.projectId, subjects[0], controller.signal)
          : undefined
      const config = AgentNodeConfigSchema.parse({
        schemaVersion: 1,
        role: 'specialist',
        interactionMode: 'autonomous',
        modelDefinitionId: binding.config.modelDefinitionId,
        skills: [],
        tools: [],
        allowedNodeIds: [],
        maxSteps: 1,
        relations: []
      })
      const model = await abortable(
        this.model(
          {
            requiresImageInput: !!(videoSamples || imageInput || audioVideoInput),
            requiresAudioInput: !!(audioInput || audioVideoInput),
            projectId: input.projectId,
            agentNodeId: input.nodeId,
            taskId: input.requestId,
            config,
            traceId: input.traceId,
            spanId: input.spanId
          },
          controller.signal
        ),
        controller.signal
      )
      if (!model.review) throw new AgentRuntimeError('AGENT_MODEL_TOOL_UNVERIFIED', 'review')
      const verdict = ReviewModelVerdictSchema.parse(
        await abortable(
          model.review(
            {
              criteria: binding.shape.props.text,
              subjects,
              ...(videoSamples ? { videoSamples } : {}),
              ...(imageInput ? { imageInput } : {}),
              ...(audioInput ? { audioInput } : {}),
              ...(audioVideoInput ? { audioVideoInput } : {})
            },
            controller.signal
          ),
          controller.signal
        )
      )
      if (controller.signal.aborted)
        throw new AgentRuntimeError('AGENT_CANCELLED_OR_TIMED_OUT', 'review')
      if (occupied && !controlledReview(this.db, input.projectId, input.nodeId, input.requestId))
        throw new AgentRuntimeError('AGENT_CANCELLED', 'review')
      this.assets.resolveInputs(input.projectId, refs)
      const current = this.open(input.projectId)
      if (
        !current ||
        !this.isActive(input.projectId) ||
        reviewBinding(current, input.nodeId).signature !== binding.signature
      )
        throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'review')
      if (verdict.issues.some((issue) => !refs[issue.subjectIndex]))
        throw new AgentRuntimeError('AGENT_MODEL_ACTION_INVALID', 'review')
      const decision = ReviewDecisionSchema.parse({
        schemaVersion: 1,
        reviewId: `review-${reviewDigest([input.projectId, input.requestId]).slice(0, 24)}`,
        cycleId: binding.cycleId,
        reviewNodeId: input.nodeId,
        reviewRevision: rejected,
        rulesVersion: binding.config.rulesVersion,
        subjects: refs,
        passed: verdict.passed,
        feedback: verdict.feedback,
        evidenceScope:
          videoSamples
            ? 'sampled'
            : imageInput
              ? 'complete-image'
              : audioInput
                ? 'complete-audio'
                : audioVideoInput
                  ? 'audio-video-timeline'
                  : 'complete-text-json',
        ...(videoSamples ? { videoEvidence: videoSamples.evidence } : {}),
        ...(imageInput ? { imageEvidence: imageInput.evidence } : {}),
        ...(audioInput ? { audioEvidence: audioInput.evidence } : {}),
        ...(audioVideoInput ? { audioVideoEvidence: audioVideoInput.evidence } : {}),
        issues: verdict.issues.map((issue) => ({
          assetId: refs[issue.subjectIndex].assetId,
          versionId: refs[issue.subjectIndex].versionId,
          feedback: issue.feedback
        }))
      })
      if (!assertReviewEvidenceForMode(this.db, input.projectId, reviewMode, decision))
        throw new AgentRuntimeError('FLOW_REVIEW_NOT_READY', 'review')
      this.store.save({
        projectId: input.projectId,
        nodeId: input.nodeId,
        requestId: input.requestId,
        cycleId: binding.cycleId,
        round: rejected + 1,
        signature: binding.signature,
        decision
      })
      return decision
    } finally {
      clearTimeout(timer)
      this.active.delete(key)
    }
  }
}
