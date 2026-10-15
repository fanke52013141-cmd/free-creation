import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import type { ProjectFile } from '../../shared/types'
import {
  AgentNodeConfigSchema,
  StateMachineNodeConfigSchema
} from '../../shared/agent-flow/node-contracts'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import type { AgentTaskSnapshot } from '../../shared/agent-flow/runtime-contracts'
import {
  FlowAgentRunSchema,
  type FlowAgentRun,
  type FlowAgentReply,
  type FlowAgentView
} from '../../shared/agent-flow/desktop-tasks'
import {
  CoordinationDecisionSchema,
  type AgentPublication,
  type ModelIdentity
} from '../../shared/agent-flow/coordination'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { agentOutputValue } from '../../shared/agent-flow/video-adapter'
import type { AgentModelPort } from './runtime'
import type { FlowAgentDesktopHost } from './desktop-host'
import { CoordinationStore, type CoordinationRun } from './coordination-store'
import { admitAssignments } from './parallel-admission'
import { FlowAssetStore } from './asset-store'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { projectSemanticRevision } from './command-intent'
import { FlowReviewStore, reviewBinding } from './review-store'
import { readStoredNodeRunStatus } from '../../shared/engine/run-status'
import {
  CoordinatorReviews,
  bindCoordinatorReviews,
  coordinationScopePayload,
  assertCoordinatorReviewOutput
} from './coordinator-reviews'

type Identity = { projectId: string; nodeId: string }
const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalFlowJson(value)).digest('hex')
function scopeRevision(
  file: ProjectFile,
  ids: string[],
  reviews: CoordinationRun['reviews'] = []
): string {
  return hash(coordinationScopePayload(file, ids, reviews))
}
function shape(
  file: ProjectFile,
  id: string
): { props: { nodeType: string; config: string; text: string }; meta?: Record<string, unknown> } {
  const item = (file.tldrawSnapshot as { store: Record<string, ReturnType<typeof shape>> }).store[
    id
  ]
  if (!item) throw new AgentRuntimeError('FLOW_NODE_MISSING', 'scope')
  return item
}
const terminal = (run: CoordinationRun): boolean =>
  ['completed', 'cancelled', 'failed'].includes(run.state)

/** One coordinator owns the saved scope. Specialists keep their own tasks and checkpoints. */
export class FlowCoordinatorHost {
  readonly store: CoordinationStore
  private readonly assets: FlowAssetStore
  private readonly active = new Map<string, AbortController>()
  private readonly reviews: CoordinatorReviews
  private readonly reports: FlowReviewStore
  constructor(
    db: Database.Database,
    private readonly open: (id: string) => ProjectFile | null,
    private readonly isActive: (id: string) => boolean,
    private readonly specialists: FlowAgentDesktopHost,
    private readonly model: (
      identity: ModelIdentity,
      signal: AbortSignal
    ) => Promise<AgentModelPort>,
    private readonly publish: (input: AgentPublication, signal: AbortSignal) => Promise<void>,
    private readonly cancelReview?: (projectId: string, nodeId: string) => void
  ) {
    this.store = new CoordinationStore(db)
    this.reports = new FlowReviewStore(db)
    this.assets = new FlowAssetStore(db, open)
    this.reviews = new CoordinatorReviews(db, open, specialists, publish, (run) => this.check(run))
  }
  private file(input: Identity): ProjectFile {
    const file = this.open(input.projectId)
    if (!this.isActive(input.projectId) || !file)
      throw new AgentRuntimeError('FLOW_PROJECT_INACTIVE', 'coordination')
    return file
  }
  private check(run: CoordinationRun): ProjectFile {
    const file = this.file(run)
    if (scopeRevision(file, run.scopeIds, run.reviews) !== run.scopeRevision)
      throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'coordination')
    return file
  }
  private view(run: CoordinationRun): FlowAgentView {
    return {
      taskId: run.taskId,
      state: run.state,
      waitKind: run.state === 'waiting' ? 'human' : null,
      waitRevision: run.waitRevision,
      decisions: run.decisions,
      tools: run.children.length,
      code: run.code,
      recovery: run.recovery,
      phase: run.phase,
      children: run.children.map(({ nodeId, taskId, state }) => {
        const live =
          state === 'ready' ? this.specialists.inspect({ projectId: run.projectId, nodeId }) : null
        return { nodeId, taskId, state: live?.taskId === taskId ? live.state : state }
      })
    }
  }
  inspect(input: Identity): FlowAgentView | null {
    this.file(input)
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run) return null
    if (run.state === 'running' && !this.active.has(run.taskId)) {
      run.state = 'blocked'
      run.code = 'AGENT_SESSION_LOST'
      this.store.save(run)
    }
    return this.view(run)
  }
  pause(input: Identity): FlowAgentView | null {
    this.file(input)
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run || terminal(run)) return run ? this.view(run) : null
    run.paused = true
    this.store.save(run)
    return this.view(run)
  }
  stop(input: Identity): FlowAgentView | null {
    this.file(input)
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run || terminal(run)) return run ? this.view(run) : null
    this.active.get(run.taskId)?.abort()
    for (const review of run.reviews ?? []) this.cancelReview?.(run.projectId, review.nodeId)
    for (const child of run.children.filter(
      (c) => !['completed', 'cancelled', 'failed'].includes(c.state)
    )) {
      const saved = this.specialists.inspect({ projectId: run.projectId, nodeId: child.nodeId })
      if (saved?.taskId === child.taskId && saved.state === 'completed') {
        const assignment = this.specialists.assignment(
          { projectId: run.projectId, nodeId: child.nodeId },
          run.taskId
        )
        child.state = 'completed'
        child.outputs = assignment?.outputRefs ?? []
      } else {
        this.specialists.stop({ projectId: run.projectId, nodeId: child.nodeId })
        child.state = 'cancelled'
      }
    }
    run.state = 'cancelled'
    run.code = 'AGENT_CANCELLED'
    this.store.save(run)
    this.store.release(run)
    return this.view(run)
  }
  private bind(input: FlowAgentRun): CoordinationRun {
    const file = this.file(input),
      root = shape(file, input.nodeId)
    const config = AgentNodeConfigSchema.parse(JSON.parse(root.props.config))
    if (
      root.props.nodeType !== 'agent' ||
      config.role !== 'coordinator' ||
      !root.props.text.trim() ||
      !config.modelDefinitionId
    )
      throw new AgentRuntimeError('FLOW_COORDINATOR_CONFIG_INVALID', 'admission')
    if (
      !config.tools.some((t) => t.id === 'agent.dispatch' && t.version === '1') ||
      config.tools.some(
        (t) => !['agent.dispatch', 'review.execute'].includes(t.id) || t.version !== '1'
      ) ||
      config.skills.length
    )
      throw new AgentRuntimeError('AGENT_TOOL_UNSUPPORTED', 'admission')
    if (
      !config.allowedNodeIds.length ||
      new Set(config.allowedNodeIds).size !== config.allowedNodeIds.length
    )
      throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
    const controls = new Set([input.nodeId])
    const reviewIds = config.allowedNodeIds.filter(
      (id) => shape(file, id).props.nodeType === 'ai-review'
    )
    const childIds = config.allowedNodeIds.filter((id) => !reviewIds.includes(id))
    if (
      !childIds.length ||
      (reviewIds.length &&
        !config.tools.some((tool) => tool.id === 'review.execute' && tool.version === '1'))
    )
      throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
    for (const id of reviewIds) controls.add(id)
    for (const id of childIds) {
      const child = shape(file, id),
        cfg = AgentNodeConfigSchema.parse(JSON.parse(child.props.config))
      if (child.props.nodeType !== 'agent' || cfg.role !== 'specialist' || id === input.nodeId)
        throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
      for (const target of [id, ...cfg.allowedNodeIds]) {
        if (controls.has(target)) throw new AgentRuntimeError('FLOW_CONTROL_OCCUPIED', 'scope')
        controls.add(target)
      }
      const task = this.specialists.inspect({ projectId: input.projectId, nodeId: id })
      if (task && !['completed', 'cancelled', 'failed'].includes(task.state))
        throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'scope')
    }
    const states = config.relations.filter(
      (r) =>
        r.kind === 'observes' &&
        r.sourceNodeId === input.nodeId &&
        shape(file, r.targetNodeId).props.nodeType === 'state-machine'
    )
    if (states.length !== 1) throw new AgentRuntimeError('FLOW_STATE_REQUIRED', 'scope')
    const stateNodeId = states[0].targetNodeId
    const stateConfig = StateMachineNodeConfigSchema.parse(
      JSON.parse(shape(file, stateNodeId).props.config)
    )
    controls.add(stateNodeId)
    const reviews = bindCoordinatorReviews(file, reviewIds, childIds, controls, input.requestId)
    const scopeIds = [
      ...new Set([
        ...controls,
        ...file.edges.filter((e) => controls.has(e.to.nodeId)).map((e) => e.from.nodeId)
      ])
    ]
    const run: CoordinationRun = {
      projectId: input.projectId,
      nodeId: input.nodeId,
      taskId: input.requestId,
      goal: root.props.text,
      config,
      stateNodeId,
      stateConfig,
      scopeIds,
      scopeRevision: scopeRevision(file, scopeIds),
      childIds,
      reviews,
      controlSteps: 0,
      state: 'running',
      phase: stateConfig.initialState,
      revision: 0,
      waitRevision: 0,
      decisions: 0,
      paused: false,
      children: [],
      outputs: [],
      traceId: input.traceId,
      spanId: input.spanId
    }
    this.store.create(run, [...controls])
    return run
  }
  private reply(run: CoordinationRun): FlowAgentReply {
    const outputs: FlowAgentReply['outputs'] = {}
    if (run.state === 'completed')
      for (const ref of run.outputs) {
        const value = agentOutputValue(this.assets.resolveInputs(run.projectId, [ref])[0].value)
        const key = value.kind === 'json' ? 'out-json' : 'out-text'
        if (outputs[key]) throw new AgentRuntimeError('AGENT_OUTPUT_CARDINALITY', 'output')
        outputs[key] = value.kind === 'markdown' ? { kind: 'text', text: value.text } : value
      }
    return { task: this.view(run), refs: run.state === 'completed' ? run.outputs : [], outputs }
  }
  async run(raw: unknown): Promise<FlowAgentReply> {
    const input = FlowAgentRunSchema.parse(raw)
    this.file(input)
    let run = this.store.latest(input.projectId, input.nodeId)
    if (input.action === 'reconcile' || input.action === 'restore') return this.recover(input)
    if (run && input.action === 'start' && run.taskId === input.requestId) return this.reply(run)
    if (run && !terminal(run) && input.action === 'start')
      throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'admission')
    if (input.action === 'continue') {
      if (
        !run ||
        run.state !== 'waiting' ||
        run.taskId !== input.expectedTaskId ||
        run.waitRevision !== input.expectedWaitRevision
      )
        throw new AgentRuntimeError('RESUME_CONFLICT', 'resume')
      this.check(run)
    } else run = this.bind(input)
    const fixed = run!
    if (this.active.has(fixed.taskId))
      throw new AgentRuntimeError('AGENT_TASK_BUSY', 'coordination')
    const controller = new AbortController()
    this.active.set(fixed.taskId, controller)
    const context = {
      projectId: fixed.projectId,
      nodeId: fixed.nodeId,
      taskId: fixed.taskId,
      traceId: input.traceId,
      spanId: input.spanId
    }
    emitGatewayEvent('agent.coordination.started', '主 Agent 协调开始', context, {
      attributes: input.action === 'continue' ? { resumesTraceId: fixed.traceId } : {}
    })
    try {
      const event = input.action === 'start' ? 'flow.started' : 'human.continue'
      this.store.event(fixed, input.eventId ?? `${fixed.taskId}:start`, event, fixed.revision)
      fixed.state = 'running'
      fixed.paused = false
      fixed.traceId = input.traceId
      fixed.spanId = input.spanId
      this.store.save(fixed, false)
      const model = await this.model({ ...fixed, agentNodeId: fixed.nodeId }, controller.signal)
      if (!model.coordinate) throw new AgentRuntimeError('AGENT_TOOL_UNSUPPORTED', 'coordination')
      const Graph = Annotation.Root({
        again: Annotation<boolean>({ reducer: (_, value) => value, default: () => true })
      })
      const graph = new StateGraph(Graph)
        .addNode('coordinate', async () => ({
          again: await this.step(fixed, input, model, controller.signal)
        }))
        .addEdge(START, 'coordinate')
        .addConditionalEdges('coordinate', (state) => (state.again ? 'coordinate' : END))
        .compile()
      await graph.invoke({}, { recursionLimit: 130 })
      const current = this.store.latest(fixed.projectId, fixed.nodeId)!
      if (terminal(current)) this.store.release(current)
      emitGatewayEvent('agent.coordination.completed', '主 Agent 协调结束', context, {
        status: 'success'
      })
      return this.reply(current)
    } catch (error) {
      const current = this.store.latest(fixed.projectId, fixed.nodeId)!
      if (current.state !== 'cancelled') {
        current.state = 'blocked'
        current.code = error instanceof AgentRuntimeError ? error.code : 'FLOW_COORDINATION_FAILED'
        this.store.save(current)
      }
      emitGatewayEvent('agent.coordination.failed', '主 Agent 协调未确认', context, {
        status: 'failed',
        attributes: { phase: 'coordination', code: current.code }
      })
      if (current.state === 'cancelled') return this.reply(current)
      throw error
    } finally {
      this.active.delete(fixed.taskId)
    }
  }
  private async step(
    run: CoordinationRun,
    input: FlowAgentRun,
    model: AgentModelPort,
    signal: AbortSignal
  ): Promise<boolean> {
    const stored = this.store.latest(run.projectId, run.nodeId)!
    if (signal.aborted || stored.state === 'cancelled') return false
    this.check(run)
    if (stored.paused) return this.wait(run, 'flow.paused')
    const control = await this.reviews.step(run, signal)
    if (control === 'again') return true
    const pendingChildren = run.children.filter(
      (c) =>
        c.state === 'waiting' &&
        !run.reviews?.some(
          (review) => review.responsibleNodeId === c.nodeId && review.state === 'human-wait'
        )
    )
    let pendingWait = false
    let pendingProgress = false
    let pendingFailure: unknown
    for (const pending of pendingChildren) {
      try {
        const state = this.specialists.inspect({ projectId: run.projectId, nodeId: pending.nodeId })
        if (state?.taskId !== pending.taskId) {
          const revised = this.specialists.assignment(
            { projectId: run.projectId, nodeId: pending.nodeId },
            run.taskId
          )
          if (!revised || revised.snapshot.parentTaskId !== pending.taskId)
            throw new AgentRuntimeError('RESUME_CONFLICT', 'handoff')
          pending.taskId = revised.snapshot.taskId
          this.store.save(run)
        }
        if (!state) throw new AgentRuntimeError('RESUME_CONFLICT', 'handoff')
        if (state.state === 'ready' || state.state === 'waiting') {
          pendingWait = true
          continue
        }
        if (state.state !== 'completed')
          throw new AgentRuntimeError(state.code ?? 'FLOW_CHILD_BLOCKED', 'handoff')
        const reply = await this.specialists.run({
          projectId: run.projectId,
          traceId: run.traceId,
          spanId: run.spanId,
          nodeId: pending.nodeId,
          action: 'start',
          requestId: pending.taskId,
          expectedTaskId: pending.taskId
        })
        pending.state = reply.task.state
        pending.outputs = reply.refs
        this.store.save(run)
        await this.publishChild(run, pending.nodeId, reply, signal)
        this.store.event(run, `${pending.taskId}:completed`, 'agent.completed', run.revision)
        pendingProgress = true
      } catch (error) {
        pendingFailure ??= error
      }
      if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
        return false
    }
    if (pendingFailure) throw pendingFailure
    if (pendingProgress) return true
    if (pendingWait || control === 'wait') return this.wait(run, 'human.wait')
    if (stored.paused) return this.wait(run, 'flow.paused')
    if (run.decisions + (run.controlSteps ?? 0) >= run.config.maxSteps)
      throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'coordination')
    const available = [] as Array<{ nodeId: string; goal: string; inputs: FlowAgentReply['refs'] }>
    const candidates = new Map<string, AgentTaskSnapshot>()
    // Pending review gates are stable within this synchronous admission pass; parse each once.
    const scopeFile = this.check(run)
    const pendingGates =
      run.reviews
        ?.filter((review) => review.state !== 'passed')
        .map((review) => {
          const config = JSON.parse(shape(scopeFile, review.nodeId).props.config) as {
            gatedNodeIds?: string[]
          }
          return new Set(config.gatedNodeIds ?? [])
        }) ?? []
    for (const id of run.childIds.filter((id) => !run.children.some((c) => c.nodeId === id))) {
      if (pendingGates.some((gates) => gates.has(id))) continue
      try {
        const child = this.specialists.describeAssignment({
          ...input,
          nodeId: id,
          action: 'start',
          requestId: hash([run.taskId, id])
        })
        candidates.set(id, child)
        available.push({ nodeId: id, goal: child.goal, inputs: child.directInputs })
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'ASSET_OUTPUT_UNAVAILABLE') throw error
      }
    }
    run.decisions++
    run.decisionPending = true
    this.store.save(run)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const decision = CoordinationDecisionSchema.parse(
      await Promise.race([
        model.coordinate!(
          {
            goal: run.goal,
            mode: run.config.interactionMode,
            maxParallelTasks: run.config.maxParallelTasks ?? 1,
            available,
            completed: run.children
              .filter((c) => c.state === 'completed')
              .map((c) => ({ nodeId: c.nodeId, taskId: c.taskId, outputs: c.outputs }))
          },
          signal
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new AgentRuntimeError('AGENT_MODEL_FAILED', 'coordination-timeout')),
            30000
          )
          timeout.unref()
        })
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })
    )
    this.check(run)
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
      return false
    if (this.store.latest(run.projectId, run.nodeId)!.paused) {
      run.decisionPending = false
      return this.wait(run, 'flow.paused')
    }
    if (decision.kind === 'wait') {
      if (run.config.interactionMode !== 'collaborative')
        throw new AgentRuntimeError('HUMAN_WAIT_DENIED', 'coordination')
      run.decisionPending = false
      return this.wait(run, 'human.wait')
    }
    if (decision.kind === 'finish') {
      const allowed = new Set(
        run.children
          .filter((c) => c.state === 'completed')
          .flatMap((c) => c.outputs)
          .map(canonicalFlowJson)
      )
      if (
        run.children.length !== run.childIds.length ||
        run.reviews?.some((review) => review.state !== 'passed') ||
        run.children.some((c) => c.state !== 'completed') ||
        decision.outputs.some((r) => !allowed.has(canonicalFlowJson(r))) ||
        new Set(decision.outputs.map(canonicalFlowJson)).size !== decision.outputs.length
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'coordination')
      const values = this.assets.resolveInputs(run.projectId, decision.outputs)
      if (
        new Set(
          values.map((value) => (agentOutputValue(value.value).kind === 'json' ? 'json' : 'text'))
        ).size !== values.length
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_CARDINALITY', 'output')
      run.outputs = decision.outputs
      run.decisionPending = false
      this.store.event(run, `${run.taskId}:completed`, 'flow.completed', run.revision)
      run.state = 'completed'
      this.store.save(run)
      return false
    }
    const assignments = admitAssignments(run, decision, candidates, this.check(run))
    const children = assignments.map((assignment) => ({
      nodeId: assignment.nodeId,
      taskId: hash([run.taskId, assignment.nodeId]),
      goal: assignment.goal,
      completion: assignment.completion,
      inputs: assignment.inputs,
      state: 'ready',
      outputs: [] as FlowAgentReply['refs']
    }))
    run.children.push(...children)
    run.controlSteps = (run.controlSteps ?? 0) + children.length - 1
    run.decisionPending = false
    // All task identities and fixed inputs survive interruption before the first effect.
    this.store.save(run)
    for (const child of children)
      this.store.event(run, `${child.taskId}:dispatch`, 'agent.dispatched', run.revision)
    const replies = await Promise.allSettled(
      children.map((child) =>
        // Each specialist owns a root checkpointer, isolated from controller and siblings.
        AsyncLocalStorageProviderSingleton.runWithConfig(
          {},
          () => {
            if (signal.aborted) throw new AgentRuntimeError('AGENT_CANCELLED', 'handoff')
            return this.specialists.runAssignment(
              {
                projectId: run.projectId,
                action: 'start',
                nodeId: child.nodeId,
                requestId: child.taskId,
                traceId: run.traceId,
                spanId: run.spanId
              },
              child,
              run.taskId,
              candidates.get(child.nodeId)
            )
          },
          true
        )
      )
    )
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
      return false
    let failure: unknown
    for (const [index, result] of replies.entries()) {
      const child = children[index]
      if (result.status === 'rejected') {
        child.state = 'blocked'
        failure ??= result.reason
        this.store.save(run)
        continue
      }
      const reply = result.value
      // Keep completed facts even if public projection fails; recovery verifies them.
      child.state = reply.task.state
      child.outputs = reply.refs
      this.store.save(run)
      try {
        if (child.state === 'completed') {
          await this.publishChild(run, child.nodeId, reply, signal)
          this.store.event(run, `${child.taskId}:completed`, 'agent.completed', run.revision)
        } else if (child.state !== 'waiting')
          throw new AgentRuntimeError(reply.task.code ?? 'FLOW_CHILD_BLOCKED', 'handoff')
      } catch (error) {
        failure ??= error
      }
      if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
        return false
    }
    if (failure) throw failure
    if (children.some((child) => child.state === 'waiting')) return this.wait(run, 'human.wait')
    return true
  }

  /** Read saved execution facts first; restoration republishes only already committed results. */
  private async recover(input: FlowAgentRun): Promise<FlowAgentReply> {
    const run = this.store.latest(input.projectId, input.nodeId)
    if (
      !run ||
      run.taskId !== input.expectedTaskId ||
      run.waitRevision !== input.expectedWaitRevision
    )
      throw new AgentRuntimeError('RESUME_CONFLICT', 'recovery')
    if (this.active.has(run.taskId)) throw new AgentRuntimeError('AGENT_TASK_BUSY', 'recovery')
    const context = {
      projectId: run.projectId,
      nodeId: run.nodeId,
      taskId: run.taskId,
      traceId: input.traceId,
      spanId: input.spanId
    }
    let failed = false
    const controller = new AbortController()
    this.active.set(run.taskId, controller)
    emitGatewayEvent('agent.coordination.started', '主控执行事实核对开始', context, {
      attributes: { phase: input.action, resumesTraceId: run.traceId }
    })
    try {
      this.check(run)
      if (terminal(run) || run.state === 'waiting') return this.reply(run)
      const reasons: string[] = []
      let canRestore = false
      let observed = false
      if (run.decisionPending) reasons.push('FLOW_MODEL_OUTCOME_UNKNOWN')
      const savedResult = (id: string): Record<string, unknown> | null => {
        try {
          return JSON.parse(String(shape(this.check(run), id).meta?.nodeResult ?? 'null'))
        } catch {
          return null
        }
      }
      for (const cycle of run.reviews ?? []) {
        if (cycle.state === 'passed' && !this.reports.approval(this.check(run), cycle.nodeId))
          reasons.push('FLOW_REVIEW_NOT_READY')
        if (cycle.state !== 'pending') continue
        const file = this.check(run),
          record = this.reports.forRequest(run.projectId, cycle.requestId)
        if (!record || record.signature !== reviewBinding(file, cycle.nodeId).signature) {
          reasons.push('FLOW_REVIEW_OUTCOME_UNKNOWN')
          continue
        }
        try {
          assertCoordinatorReviewOutput(
            file,
            cycle.nodeId,
            record.decision,
            run.children.find((child) => child.nodeId === cycle.responsibleNodeId)?.outputs ?? []
          )
        } catch {
          reasons.push('FLOW_REVIEW_NOT_READY')
          continue
        }
        observed = true
        const projected = (): boolean => {
          const meta = shape(this.check(run), cycle.nodeId).meta
          return (
            readStoredNodeRunStatus(meta?.nodeRun) === 'success' &&
            (meta?.nodeRun as { runId?: string })?.runId === cycle.requestId &&
            canonicalFlowJson(savedResult(cycle.nodeId)) === canonicalFlowJson(record.decision)
          )
        }
        if (!projected() && input.action === 'restore') {
          const existing = savedResult(cycle.nodeId)
          if (
            existing &&
            canonicalFlowJson(existing) !== canonicalFlowJson(record.decision) &&
            canonicalFlowJson(existing) !== canonicalFlowJson(cycle.decision)
          )
            throw new AgentRuntimeError('FLOW_PROJECTION_CONFLICT', 'recovery')
          run.state = 'running'
          this.store.save(run)
          await this.publish(
            {
              kind: 'review',
              projectId: run.projectId,
              nodeId: cycle.nodeId,
              taskId: cycle.requestId,
              semanticRevision: projectSemanticRevision(file),
              traceId: input.traceId,
              spanId: input.spanId
            },
            controller.signal
          )
        }
        if (!projected()) {
          reasons.push('FLOW_ASSET_PROJECTION_MISSING')
          canRestore = true
          continue
        }
        cycle.decision = record.decision
        cycle.originalInputs ??= record.decision.subjects
        cycle.state = record.decision.passed ? 'passed' : 'rejected'
        this.store.event(
          run,
          `${cycle.requestId}:${record.decision.passed ? 'review.passed' : 'review.rejected'}`,
          record.decision.passed ? 'review.passed' : 'review.rejected',
          run.revision
        )
      }
      for (const child of run.children) {
        const record = this.specialists.assignment(
          { projectId: run.projectId, nodeId: child.nodeId },
          run.taskId
        )
        if (!record || record.snapshot.taskId !== child.taskId) {
          reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
          continue
        }
        if (
          record.state === 'waiting' ||
          (record.state === 'ready' && record.snapshot.parentTaskId)
        ) {
          observed = true
          child.state = 'waiting'
          continue
        }
        if (record.state !== 'completed') {
          reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
          continue
        }
        observed = true
        const values = this.assets.resolveInputs(run.projectId, record.outputRefs)
        const expectedOutputs = Object.fromEntries(
          values.map((asset) => [
            agentOutputValue(asset.value).kind === 'json' ? 'out-json' : 'out-text',
            agentOutputValue(asset.value)
          ])
        )
        const projected = (): boolean => {
          const meta = shape(this.check(run), child.nodeId).meta,
            result = savedResult(child.nodeId)
          return (
            readStoredNodeRunStatus(meta?.nodeRun) === 'success' &&
            (meta?.nodeRun as { runId?: string })?.runId === child.taskId &&
            result?.taskId === child.taskId &&
            canonicalFlowJson(result.refs) === canonicalFlowJson(record.outputRefs) &&
            canonicalFlowJson(result.outputs) === canonicalFlowJson(expectedOutputs)
          )
        }
        if (!projected() && input.action === 'restore') {
          const existing = savedResult(child.nodeId)
          if (
            existing &&
            (existing.taskId !== child.taskId ||
              canonicalFlowJson(existing.refs) !== canonicalFlowJson(record.outputRefs) ||
              canonicalFlowJson(existing.outputs) !== canonicalFlowJson(expectedOutputs))
          )
            throw new AgentRuntimeError('FLOW_PROJECTION_CONFLICT', 'recovery')
          await this.publish(
            {
              projectId: run.projectId,
              nodeId: child.nodeId,
              taskId: child.taskId,
              semanticRevision: projectSemanticRevision(this.check(run)),
              traceId: input.traceId,
              spanId: input.spanId
            },
            controller.signal
          )
        }
        if (!projected()) {
          reasons.push('FLOW_ASSET_PROJECTION_MISSING')
          canRestore = true
          continue
        }
        if (child.state !== 'completed') {
          child.state = 'completed'
          child.outputs = record.outputRefs
          this.store.event(run, `${child.taskId}:completed`, 'agent.completed', run.revision)
        }
      }
      if (!observed) reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
      if (controller.signal.aborted) throw new AgentRuntimeError('AGENT_CANCELLED', 'recovery')
      run.recovery = { reasons: [...new Set(reasons)], canRestore }
      if (!reasons.length) {
        if (this.store.hasEvent(run, `${run.taskId}:completed`, 'flow.completed')) {
          const allowed = new Set(
            run.children.flatMap((child) => child.outputs).map(canonicalFlowJson)
          )
          if (
            !run.outputs.length ||
            run.children.length !== run.childIds.length ||
            run.children.some((child) => child.state !== 'completed') ||
            run.reviews?.some((review) => review.state !== 'passed') ||
            run.outputs.some((ref) => !allowed.has(canonicalFlowJson(ref)))
          )
            throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'recovery')
          this.assets.resolveInputs(run.projectId, run.outputs)
          run.state = 'completed'
          run.code = undefined
          this.store.save(run)
          this.store.release(run)
          return this.reply(run)
        }
        if (
          run.phase !==
          run.stateConfig.transitions.find(
            (t) => t.from === run.phase && t.event === 'human.continue'
          )?.from
        )
          this.store.event(run, `${input.eventId}:recovery-wait`, 'human.wait', run.revision)
        run.state = 'waiting'
        run.waitRevision++
        run.code = undefined
      } else {
        run.state = 'blocked'
        run.code = reasons[0]
      }
      this.store.save(run)
      return this.reply(run)
    } catch (error) {
      failed = true
      const current = this.store.latest(run.projectId, run.nodeId)
      if (current?.state === 'cancelled') {
        emitGatewayEvent('agent.coordination.completed', '主控核对已取消', context, {
          status: 'cancelled',
          attributes: { phase: input.action, code: 'AGENT_CANCELLED' }
        })
        return this.reply(current)
      }
      if (!current || !terminal(current)) {
        run.state = 'blocked'
        run.code = error instanceof AgentRuntimeError ? error.code : 'FLOW_RECOVERY_FAILED'
        run.recovery = { reasons: [run.code], canRestore: false }
        this.store.save(run)
      }
      emitGatewayEvent('agent.coordination.failed', '主控执行事实核对失败', context, {
        status: 'failed',
        attributes: {
          phase: input.action,
          code: error instanceof AgentRuntimeError ? error.code : 'FLOW_RECOVERY_FAILED'
        }
      })
      throw error
    } finally {
      this.active.delete(run.taskId)
      if (!failed)
        emitGatewayEvent('agent.coordination.completed', '主控执行事实核对结束', context, {
          status: 'success',
          attributes: { phase: input.action, code: run.code }
        })
    }
  }
  private wait(run: CoordinationRun, event: string): false {
    this.store.event(run, `${run.taskId}:wait:${run.waitRevision + 1}`, event, run.revision)
    run.state = 'waiting'
    run.waitRevision++
    this.store.save(run)
    return false
  }
  private async publishChild(
    run: CoordinationRun,
    nodeId: string,
    reply: FlowAgentReply,
    signal: AbortSignal
  ): Promise<void> {
    await this.publish(
      {
        projectId: run.projectId,
        nodeId,
        taskId: reply.task.taskId,
        semanticRevision: projectSemanticRevision(this.check(run)),
        traceId: run.traceId,
        spanId: run.spanId
      },
      signal
    )
    this.check(run)
  }
}
