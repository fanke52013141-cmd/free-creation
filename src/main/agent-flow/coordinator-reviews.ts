import type Database from 'better-sqlite3'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import type { ProjectFile } from '../../shared/types'
import type { NodeShape } from '../../shared/engine/executor-types'
import {
  AgentNodeConfigSchema,
  ReviewNodeConfigSchema,
  type ReviewDecision
} from '../../shared/agent-flow/node-contracts'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import {
  canonicalFlowJson,
  semanticProjectPayload
} from '../../shared/agent-flow/semantic-revision'
import { DETERMINISTIC_PROJECTIONS } from '../../shared/engine/deterministic-projections'
import type { AgentPublication } from '../../shared/agent-flow/coordination'
import {
  CoordinationStore,
  type CoordinationRun,
  type CoordinationReview
} from './coordination-store'
import { FlowReviewStore, reviewBinding, reviewDigest } from './review-store'
import { FlowAssetStore } from './asset-store'
import type { FlowAgentDesktopHost } from './desktop-host'
import { projectSemanticRevision } from './command-intent'
import { emitGatewayEvent } from '../diagnostics/gateway-events'

function saved(file: ProjectFile, id: string): NodeShape {
  const node = (file.tldrawSnapshot as { store: Record<string, NodeShape> }).store[id]
  if (!node) throw new AgentRuntimeError('FLOW_NODE_MISSING', 'review-scope')
  return node
}

/** Normal execution and read-only recovery must agree on the specialist's exact output version. */
export function assertCoordinatorReviewOutput(
  file: ProjectFile,
  nodeId: string,
  decision: ReviewDecision,
  outputs: ReviewDecision['subjects']
): void {
  const config = ReviewNodeConfigSchema.parse(JSON.parse(saved(file, nodeId).props.config))
  if (
    config.reviewMode === 'sampled-video' &&
    (decision.subjects.length !== 1 ||
      !outputs.some((ref) => canonicalFlowJson(ref) === canonicalFlowJson(decision.subjects[0])))
  )
    throw new AgentRuntimeError('FLOW_REVIEW_NOT_READY', 'review-control')
}

export function bindCoordinatorReviews(
  file: ProjectFile,
  reviewIds: string[],
  childIds: string[],
  controls: Set<string>,
  taskId: string
): CoordinationReview[] {
  const responsible = new Set<string>()
  return reviewIds.map((nodeId) => {
    const config = ReviewNodeConfigSchema.parse(JSON.parse(saved(file, nodeId).props.config))
    const video = config.reviewMode === 'sampled-video'
    const owner = config.responsibleNodeId
    if (
      !owner ||
      !config.modelDefinitionId ||
      !config.subjectSources.length ||
      !config.gatedNodeIds.length ||
      (!video && config.subjectSources.some((source) => source.nodeId !== owner)) ||
      responsible.has(owner) ||
      config.gatedNodeIds.some((id) => !controls.has(id) || id === owner || id === nodeId)
    )
      throw new AgentRuntimeError('FLOW_REWORK_SCOPE_INVALID', 'review-scope')
    const type = saved(file, owner).props.nodeType
    if (type === 'agent' ? !childIds.includes(owner) : !['text', 'json'].includes(type))
      throw new AgentRuntimeError('FLOW_REWORK_TARGET_UNSUPPORTED', 'review-scope')
    if (video) {
      const specialist =
        type === 'agent'
          ? AgentNodeConfigSchema.parse(JSON.parse(saved(file, owner).props.config))
          : null
      const source = config.subjectSources[0]
      const target = file.nodes.find((node) => node.id === source.nodeId)
      if (
        !specialist ||
        specialist.role !== 'specialist' ||
        config.subjectSources.length !== 1 ||
        source.portId !== 'out-video' ||
        target?.type !== 'video' ||
        target.contractVersion !== 7 ||
        saved(file, source.nodeId).props.nodeType !== 'video' ||
        !specialist.allowedNodeIds.includes(source.nodeId) ||
        !controls.has(source.nodeId) ||
        config.gatedNodeIds.includes(source.nodeId)
      )
        throw new AgentRuntimeError('FLOW_REWORK_TARGET_UNSUPPORTED', 'review-scope')
    }
    responsible.add(owner)
    controls.add(owner)
    return {
      nodeId,
      responsibleNodeId: owner,
      requestId: reviewDigest([taskId, nodeId, 0]),
      state: 'ready',
      round: 0
    }
  })
}

/** Permit only the waiting manual source's body; all other graph semantics remain fixed. */
export function coordinationScopePayload(
  file: ProjectFile,
  ids: string[],
  reviews: CoordinationReview[] = []
): unknown {
  const payload = semanticProjectPayload(file) as {
    nodes: Array<{ id: string; text: unknown; content: unknown }>
    edges: Array<{ from: { nodeId: string }; to: { nodeId: string } }>
  }
  return {
    nodes: payload.nodes
      .filter((node) => ids.includes(node.id))
      .map((node) => {
        const manual = reviews.find(
          (review) => review.state === 'manual-wait' && review.responsibleNodeId === node.id
        )?.manualDefinition
        return manual ? { ...node, text: manual.text, content: manual.content } : node
      }),
    edges: payload.edges.filter((edge) => ids.includes(edge.to.nodeId))
  }
}

/** Deterministic control loop. Models provide verdicts; they never choose permissions or budgets. */
export class CoordinatorReviews {
  private readonly store: CoordinationStore
  private readonly reports: FlowReviewStore
  private readonly assets: FlowAssetStore
  constructor(
    db: Database.Database,
    private readonly open: (id: string) => ProjectFile | null,
    private readonly specialists: FlowAgentDesktopHost,
    private readonly publish: (grant: AgentPublication, signal: AbortSignal) => Promise<void>,
    private readonly check: (run: CoordinationRun) => ProjectFile
  ) {
    this.store = new CoordinationStore(db)
    this.reports = new FlowReviewStore(db)
    this.assets = new FlowAssetStore(db, open)
  }
  private reserve(run: CoordinationRun): void {
    if (run.decisions + (run.controlSteps ?? 0) >= run.config.maxSteps)
      throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'review-control')
    run.controlSteps = (run.controlSteps ?? 0) + 1
    this.store.save(run)
  }
  private event(run: CoordinationRun, cycle: CoordinationReview, event: string): void {
    this.store.event(run, `${cycle.requestId}:${event}`, event, run.revision)
    emitGatewayEvent(
      'agent.coordination.stage',
      '审核返工控制阶段',
      {
        projectId: run.projectId,
        nodeId: cycle.nodeId,
        taskId: run.taskId,
        requestId: cycle.requestId,
        traceId: run.traceId,
        spanId: run.spanId
      },
      {
        attributes: {
          phase: event,
          code: 'FLOW_REVIEW_CONTROL',
          reviewId: cycle.decision?.reviewId,
          reworkTaskId: cycle.reworkTaskId,
          versionId: cycle.decision?.subjects[0]?.versionId,
          round: cycle.round,
          subjectCount: cycle.decision?.subjects.length ?? 0
        }
      }
    )
  }
  private ensureLive(run: CoordinationRun, signal: AbortSignal): void {
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)?.state === 'cancelled')
      throw new AgentRuntimeError('AGENT_CANCELLED', 'review-control')
    this.check(run)
  }
  async step(run: CoordinationRun, signal: AbortSignal): Promise<'none' | 'again' | 'wait'> {
    let waiting = false
    for (const cycle of run.reviews ?? []) {
      this.ensureLive(run, signal)
      const file = this.check(run)
      const config = ReviewNodeConfigSchema.parse(
        JSON.parse(saved(file, cycle.nodeId).props.config)
      )
      const owner = cycle.responsibleNodeId!
      const child = run.children.find((entry) => entry.nodeId === owner)
      if (cycle.state === 'passed') {
        if (!this.reports.approval(file, cycle.nodeId))
          throw new AgentRuntimeError('FLOW_REVIEW_NOT_READY', 'review-control')
        assertCoordinatorReviewOutput(file, cycle.nodeId, cycle.decision!, child?.outputs ?? [])
        continue
      }
      if (cycle.state === 'human-wait') {
        const record = this.specialists.assignment(
          { projectId: run.projectId, nodeId: owner },
          run.taskId
        )
        if (!record || !child) throw new AgentRuntimeError('FLOW_CHILD_BLOCKED', 'rework')
        if (record.snapshot.taskId !== cycle.reworkTaskId) {
          if (
            record.snapshot.parentTaskId !== cycle.reworkTaskId ||
            !record.snapshot.rework ||
            record.snapshot.rework.reviewId !== cycle.decision?.reviewId
          )
            throw new AgentRuntimeError('RESUME_CONFLICT', 'rework')
          cycle.reworkTaskId = record.snapshot.taskId
          child.taskId = record.snapshot.taskId
          this.store.save(run)
        }
        if (['ready', 'waiting'].includes(record.state)) {
          waiting = true
          continue
        }
        if (record.state !== 'completed')
          throw new AgentRuntimeError(record.code ?? 'FLOW_CHILD_BLOCKED', 'rework')
        await this.publish(
          {
            projectId: run.projectId,
            nodeId: owner,
            taskId: record.snapshot.taskId,
            semanticRevision: projectSemanticRevision(file),
            traceId: run.traceId,
            spanId: run.spanId
          },
          signal
        )
        this.ensureLive(run, signal)
        child.state = 'completed'
        child.outputs = record.outputRefs
        cycle.state = 'ready'
        this.store.save(run)
        return 'again'
      }
      if (cycle.state === 'manual-wait') {
        const node = saved(file, owner)
        const port = config.subjectSources[0].portId
        const projection = DETERMINISTIC_PROJECTIONS[node.props.nodeType as 'text' | 'json']
        const current = projection?.(node)[port]
        const latest = this.assets.list(run.projectId, owner, port)[0]
        if (
          !current ||
          !latest ||
          cycle.decision?.subjects.some((ref) => ref.versionId === latest.ref.versionId) ||
          canonicalFlowJson(this.assets.read(run.projectId, latest.ref.versionId).value) !==
            canonicalFlowJson(current)
        ) {
          waiting = true
          continue
        }
        cycle.state = 'ready'
        run.scopeRevision = reviewDigest(coordinationScopePayload(file, run.scopeIds, run.reviews))
        this.store.save(run)
        return 'again'
      }
      if (cycle.state === 'rejected') {
        if (!cycle.decision || config.rejectPolicy === 'stop')
          throw new AgentRuntimeError('FLOW_REVIEW_STOPPED', 'review-control')
        if (cycle.round >= config.maxReworks)
          throw new AgentRuntimeError('FLOW_REVIEW_BUDGET_EXHAUSTED', 'review-control')
        this.reserve(run)
        cycle.round++
        cycle.requestId = reviewDigest([run.taskId, cycle.nodeId, cycle.round])
        const responsible = saved(file, owner)
        if (['text', 'json'].includes(responsible.props.nodeType)) {
          if (config.subjectSources.length !== 1)
            throw new AgentRuntimeError('FLOW_REWORK_TARGET_UNSUPPORTED', 'rework')
          const definition = (
            semanticProjectPayload(file) as {
              nodes: Array<{ id: string; text: unknown; content: unknown }>
            }
          ).nodes.find((node) => node.id === owner)!
          cycle.manualDefinition = { text: definition.text, content: definition.content }
          cycle.state = 'manual-wait'
          this.event(run, cycle, 'rework.created')
          this.store.save(run)
          waiting = true
          continue
        }
        if (!child || child.state !== 'completed')
          throw new AgentRuntimeError('FLOW_CHILD_BLOCKED', 'rework')
        const taskId = reviewDigest([run.taskId, owner, cycle.decision.reviewId, cycle.round])
        const previous = this.specialists.assignment(
          { projectId: run.projectId, nodeId: owner },
          run.taskId
        )!
        const record = this.specialists.prepareRework(
          { projectId: run.projectId, nodeId: owner },
          run.taskId,
          child.taskId,
          taskId,
          {
            originalTaskId: previous.snapshot.rework?.originalTaskId ?? child.taskId,
            reviewId: cycle.decision.reviewId,
            reviewNodeId: cycle.nodeId,
            rulesVersion: cycle.decision.rulesVersion,
            rejectedOutputs: cycle.decision.subjects,
            criteria: saved(file, cycle.nodeId).props.text,
            feedback: cycle.decision.feedback,
            round: cycle.round,
            ...(config.reviewMode === 'sampled-video'
              ? { videoTargetNodeId: config.subjectSources[0].nodeId }
              : {})
          }
        )
        cycle.reworkTaskId = taskId
        cycle.state = 'human-wait'
        child.taskId = taskId
        child.state = 'waiting'
        child.outputs = []
        this.event(run, cycle, 'rework.created')
        this.store.save(run)
        if (record.snapshot.config.interactionMode === 'collaborative') {
          waiting = true
          continue
        }
        // Rework is a new specialist root, with its own interrupt/checkpoint namespace.
        const reply = await AsyncLocalStorageProviderSingleton.runWithConfig(
          {},
          () =>
            this.specialists.run({
              projectId: run.projectId,
              nodeId: owner,
              action: 'start',
              requestId: taskId,
              expectedTaskId: taskId,
              traceId: run.traceId,
              spanId: run.spanId
            }),
          true
        )
        this.ensureLive(run, signal)
        if (reply.task.state !== 'completed') {
          waiting = true
          continue
        }
        return 'again'
      }
      if (cycle.state === 'pending')
        throw new AgentRuntimeError('FLOW_REVIEW_OUTCOME_UNKNOWN', 'review-control')
      if (saved(file, owner).props.nodeType === 'agent' && child?.state !== 'completed') continue
      if (config.reviewMode === 'sampled-video') {
        const source = config.subjectSources[0]
        if (
          !child?.outputs.some(
            (ref) => ref.sourceNodeId === source.nodeId && ref.sourcePortId === source.portId
          )
        )
          throw new AgentRuntimeError('FLOW_REVIEW_NOT_READY', 'review-control')
      }
      const binding = reviewBinding(file, cycle.nodeId)
      this.reserve(run)
      cycle.state = 'pending'
      this.event(run, cycle, 'review.started')
      this.store.save(run)
      await this.publish(
        {
          kind: 'review',
          projectId: run.projectId,
          nodeId: cycle.nodeId,
          taskId: cycle.requestId,
          semanticRevision: projectSemanticRevision(file),
          traceId: run.traceId,
          spanId: run.spanId
        },
        signal
      )
      this.ensureLive(run, signal)
      const current = this.open(run.projectId)!
      const record =
        this.reports.forRequest(run.projectId, cycle.requestId) ??
        this.reports.latest(run.projectId, cycle.nodeId)
      if (
        !record ||
        record.signature !== reviewBinding(current, cycle.nodeId).signature ||
        binding.cycleId !== record.cycleId ||
        canonicalFlowJson(JSON.parse(saved(current, cycle.nodeId).meta?.nodeResult ?? '{}')) !==
          canonicalFlowJson(record.decision)
      )
        throw new AgentRuntimeError('FLOW_REVIEW_NOT_READY', 'review-control')
      assertCoordinatorReviewOutput(current, cycle.nodeId, record.decision, child?.outputs ?? [])
      cycle.decision = record.decision
      cycle.originalInputs ??= record.decision.subjects
      cycle.state = record.decision.passed ? 'passed' : 'rejected'
      this.event(run, cycle, record.decision.passed ? 'review.passed' : 'review.rejected')
      this.store.save(run)
      return 'again'
    }
    return waiting ? 'wait' : 'none'
  }
}
