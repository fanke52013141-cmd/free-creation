import { assertVideoReviewEvidence } from './video-review'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { ProjectFile } from '../../shared/types'
import type { NodeShape } from '../../shared/engine/executor-types'
import {
  ReviewNodeConfigSchema,
  ReviewDecisionSchema,
  type ReviewDecision
} from '../../shared/agent-flow/node-contracts'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { readStoredNodeRunStatus } from '../../shared/engine/run-status'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'

export const reviewDigest = (value: unknown): string =>
  createHash('sha256').update(canonicalFlowJson(value)).digest('hex')
export interface ReviewRecord {
  projectId: string
  nodeId: string
  requestId: string
  signature: string
  cycleId: string
  round: number
  decision: ReviewDecision
}
export function reviewBinding(
  file: ProjectFile,
  nodeId: string
): {
  signature: string
  cycleId: string
  config: ReturnType<typeof ReviewNodeConfigSchema.parse>
  shape: NodeShape
} {
  const store = (
    file.tldrawSnapshot as { store: Record<string, NodeShape & { meta?: Record<string, unknown> }> }
  ).store
  const shape = store[nodeId]
  if (shape?.props.nodeType !== 'ai-review')
    throw new AgentRuntimeError('FLOW_REVIEW_CONFIG_INVALID', 'review')
  const config = ReviewNodeConfigSchema.parse(JSON.parse(shape.props.config))
  if (!config.subjectSources.length || !shape.props.text.trim() || !config.modelDefinitionId)
    throw new AgentRuntimeError('FLOW_REVIEW_CONFIG_INVALID', 'review')
  if (new Set(config.subjectSources.map(canonicalFlowJson)).size !== config.subjectSources.length)
    throw new AgentRuntimeError('FLOW_REVIEW_CONFIG_INVALID', 'review')
  const videoReview = config.reviewMode === 'sampled-video'
  if (videoReview && config.subjectSources.length !== 1)
    throw new AgentRuntimeError('FLOW_REVIEW_SUBJECT_INVALID', 'review')
  const sources = config.subjectSources.map((source) => {
    const node = file.nodes.find((n) => n.id === source.nodeId),
      saved = store[source.nodeId]
    const port = node?.ports.find((p) => p.id === source.portId && p.dir === 'out')
    const connections = file.edges.filter(
      (e) =>
        e.from.nodeId === source.nodeId && e.from.portId === source.portId && e.to.nodeId === nodeId
    )
    if (
      !saved ||
      !port ||
      !(videoReview ? port.type === 'video' : ['text', 'json', 'any'].includes(port.type)) ||
      !connections.length ||
      connections.some(
        (e) =>
          !(videoReview ? e.to.portId === 'in-video' : ['in-text', 'in-json'].includes(e.to.portId))
      )
    )
      throw new AgentRuntimeError('FLOW_REVIEW_SUBJECT_INVALID', 'review')
    // Include result/run identity: a different attempt with identical text still needs a new review.
    return {
      source,
      ...(videoReview
        ? { media: [saved.props.mediaId, saved.props.mediaPath, saved.props.mediaMime] }
        : {}),
      type: node!.type,
      contractVersion: node!.contractVersion,
      config: saved.props.config,
      text: saved.props.text,
      pinned: saved.meta?.pinnedOutput,
      fixedRef: saved.meta?.flowAssetRef,
      result: saved.meta?.nodeResult,
      run: saved.meta?.nodeRun,
      edges: connections.map(({ from, to }) => ({ from, to }))
    }
  })
  const cycleId = `review-cycle-${reviewDigest({ nodeId, config, criteria: shape.props.text }).slice(0, 24)}`
  return { signature: reviewDigest({ cycleId, sources }), cycleId, config, shape }
}
export class FlowReviewStore {
  constructor(private readonly db: Database.Database) {}
  latest(projectId: string, nodeId: string): ReviewRecord | null {
    const row = this.db
      .prepare(
        'SELECT body_json FROM flow_reviews WHERE project_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(projectId, nodeId) as { body_json: string } | undefined
    return row ? JSON.parse(row.body_json) : null
  }
  forRequest(projectId: string, requestId: string): ReviewRecord | null {
    const row = this.db
      .prepare('SELECT body_json FROM flow_reviews WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as { body_json: string } | undefined
    return row ? JSON.parse(row.body_json) : null
  }
  rejectedRounds(projectId: string, nodeId: string, cycleId: string): number {
    return (
      this.db
        .prepare(
          "SELECT count(*) AS count FROM flow_reviews WHERE project_id=? AND node_id=? AND json_extract(body_json,'$.cycleId')=? AND json_extract(body_json,'$.decision.passed')=0"
        )
        .get(projectId, nodeId, cycleId) as { count: number }
    ).count
  }
  save(record: ReviewRecord): void {
    ReviewDecisionSchema.parse(record.decision)
    this.db
      .prepare('INSERT INTO flow_reviews(project_id,node_id,request_id,body_json) VALUES (?,?,?,?)')
      .run(record.projectId, record.nodeId, record.requestId, JSON.stringify(record))
  }
  approval(file: ProjectFile, nodeId: string): ReviewRecord | null {
    try {
      const current = reviewBinding(file, nodeId),
        record = this.latest(file.meta.id, nodeId)
      if (
        !record ||
        record.signature !== current.signature ||
        !record.decision.passed ||
        readStoredNodeRunStatus(current.shape.meta?.nodeRun) !== 'success'
      )
        return null
      if (current.config.reviewMode === 'sampled-video')
        assertVideoReviewEvidence(this.db, file.meta.id, record.decision)
      else if (
        record.decision.evidenceScope !== 'complete-text-json' ||
        record.decision.videoEvidence
      )
        return null
      return canonicalFlowJson(JSON.parse(current.shape.meta?.nodeResult ?? '{}')) ===
        canonicalFlowJson(record.decision)
        ? record
        : null
    } catch {
      return null
    }
  }
}
