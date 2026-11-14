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
  type CoordinationDecision,
  type AgentPublication,
  type ModelIdentity
} from '../../shared/agent-flow/coordination'
import {
  evaluateStageEntry,
  StageDeliveryRecordSchema,
  type ContextManifest,
  type StageDeliveryFact,
  type StageEntryFacts
} from '../../shared/agent-flow/stage-contracts'
import {
  nextReadyNodes,
  isFlowComplete,
  loopNeedsAnotherIteration
} from '../../shared/agent-flow/flow-graph-router'
import type { FlowNode, FlowGraph } from '../../shared/agent-flow/flow-graph'
import {
  buildContextManifest,
  contextManifestBlocking
} from '../../shared/agent-flow/context-manifest'
import {
  composeExecutionEnvelope,
  type ExecutionEnvelope
} from '../../shared/agent-flow/execution-envelope'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import type { AgentModelPort } from './runtime'
import type { FlowAgentDesktopHost } from './desktop-host'
import { CoordinationStore, type CoordinationRun } from './coordination-store'
import { admitAssignments, assignmentWaves } from './parallel-admission'
import { FlowAssetStore } from './asset-store'
import { agentReplyOutputProjection } from '../../shared/agent-flow/agent-outputs'
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
    private readonly db: Database.Database,
    private readonly open: (id: string) => ProjectFile | null,
    private readonly isActive: (id: string) => boolean,
    private readonly specialists: FlowAgentDesktopHost,
    private readonly model: (
      identity: ModelIdentity,
      signal: AbortSignal
    ) => Promise<AgentModelPort>,
    private readonly publish: (input: AgentPublication, signal: AbortSignal) => Promise<void>,
    private readonly cancelReview?: (projectId: string, nodeId: string) => void,
    /**
     * O1：把协调器已核对的可信事实投影到画布状态机节点（来源 agent，仅内部通道）。
     * best-effort：run.phase 是权威，投影失败/修订竞态不阻断 flow。缺省则不投影（存量兼容）。
     */
    private readonly projectStateEvent?: (
      projectId: string,
      stateNodeId: string,
      event: string,
      expectedRevision: number,
      eventId: string
    ) => Promise<void>
  ) {
    this.store = new CoordinationStore(db)
    this.reports = new FlowReviewStore(db)
    this.assets = new FlowAssetStore(db, open)
    this.reviews = new CoordinatorReviews(db, open, specialists, publish, (run) => this.check(run))
  }
  /**
   * O1：可信事件 choke point。先推进协调器权威 run.phase（store.event：修订 CAS + 迁移合法性，
   * 事件来源限定为账本回执/资产登记/审核结论），再把同一可信事实投影到画布状态机节点，使可见
   * 节点随节点完成自动推进。投影 best-effort：失败/竞态仅诊断记录，不阻断 flow（run.phase 权威）。
   * 与 store.event 同签名，便于在全部事件发射点统一替换。
   */
  private emitTrustedEvent(
    run: CoordinationRun,
    eventId: string,
    event: string,
    expectedRevision: number
  ): void {
    this.store.event.bind(this.store)(run, eventId, event, expectedRevision)
    if (!this.projectStateEvent) return
    let canvasRevision = 1
    try {
      const file = this.open(run.projectId)
      const shape = (
        file?.tldrawSnapshot as { store?: Record<string, { meta?: Record<string, unknown> }> }
      )?.store?.[run.stateNodeId]
      const instance = JSON.parse(String(shape?.meta?.stateMachine ?? '')) as { revision?: number }
      if (typeof instance?.revision === 'number') canvasRevision = instance.revision
    } catch {
      /* 无实例：初始修订 1（与执行器初始化一致）。 */
    }
    void this.projectStateEvent(
      run.projectId,
      run.stateNodeId,
      event,
      canvasRevision,
      eventId
    ).catch(() => {
      emitGatewayEvent(
        'agent.coordination.state_projection_skipped',
        '状态机可信投影未应用（run.phase 仍为权威）',
        {
          traceId: run.traceId,
          spanId: run.spanId,
          projectId: run.projectId,
          nodeId: run.stateNodeId,
          taskId: run.taskId
        },
        { status: 'failed', phase: 'state-projection', attributes: { event } }
      )
    })
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
        // ②：capability 子节点无 agent 任务，不就绪态查询 specialist（避免 AGENT_NODE_MISSING）。
        const graphNodes = run.config.graph?.nodes
        const isAgent = !graphNodes || graphNodes.find((node) => node.nodeId === nodeId)?.kind === 'agent'
        const live =
          state === 'ready' && isAgent
            ? this.specialists.inspect({ projectId: run.projectId, nodeId })
            : null
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
    const fixedOrder = config.executionMode === 'fixed-order'
    const graphMode = config.executionMode === 'graph'
    if (
      root.props.nodeType !== 'agent' ||
      config.role !== 'coordinator' ||
      !root.props.text.trim() ||
      // AF-01/O4-P3：固定顺序与图模式由规则推进，主控不需要决策模型；旧模式仍要求模型。
      (!fixedOrder && !graphMode && !config.modelDefinitionId)
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
    const reservedControls = new Set([...controls, ...childIds])
    for (const id of childIds) {
      const child = shape(file, id)
      const graphNode = graphMode ? config.graph!.nodes.find((node) => node.nodeId === id) : undefined
      // ②：capability 子节点是处理器节点（直接执行），不是 agent specialist，跳过 agent 契约校验。
      if (graphNode?.kind === 'capability') {
        if (child.props.nodeType === 'agent' || id === input.nodeId)
          throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
        controls.add(id)
        continue
      }
      const cfg = AgentNodeConfigSchema.parse(JSON.parse(child.props.config))
      if (child.props.nodeType !== 'agent' || cfg.role !== 'specialist' || id === input.nodeId)
        throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
      for (const target of cfg.allowedNodeIds) {
        if (reservedControls.has(target))
          throw new AgentRuntimeError('FLOW_CONTROL_OCCUPIED', 'scope')
        controls.add(target)
      }
      controls.add(id)
      const task = this.specialists.inspect({ projectId: input.projectId, nodeId: id })
      if (task && !['completed', 'cancelled', 'failed'].includes(task.state))
        throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'scope')
    }
    // AF-01：固定顺序模式要求每个专业子节点恰好被一个声明阶段承载；
    // 要求人工采用的阶段必须由人机协作子节点承载（纯自主节点无法产生人工决定）。
    if (fixedOrder) {
      const stages = config.stages!
      const stageByNode = new Map(stages.map((stage) => [stage.nodeId, stage]))
      if (stages.length !== childIds.length || childIds.some((id) => !stageByNode.has(id)))
        throw new AgentRuntimeError('FLOW_STAGE_SCOPE_INVALID', 'scope')
      for (const id of childIds) {
        const stage = stageByNode.get(id)!
        if (!stage.requireHumanDecision) continue
        const childConfig = AgentNodeConfigSchema.parse(JSON.parse(shape(file, id).props.config))
        if (childConfig.interactionMode !== 'collaborative')
          throw new AgentRuntimeError('FLOW_STAGE_HUMAN_MODE_REQUIRED', 'scope')
      }
    }
    // O4-P3/②：图模式支持 agent + capability 节点路由（human-task 随后阶段）；
    // 图节点承载必须与子节点一一对应；路由只认交付事实（见 graphStep）。
    if (graphMode) {
      const graph = config.graph!
      if (graph.nodes.some((node) => node.kind !== 'agent' && node.kind !== 'capability'))
        throw new AgentRuntimeError('FLOW_GRAPH_NODE_KIND_UNSUPPORTED', 'scope')
      const graphNodeIds = new Set(graph.nodes.map((node) => node.nodeId))
      if (graphNodeIds.size !== childIds.length || childIds.some((id) => !graphNodeIds.has(id)))
        throw new AgentRuntimeError('FLOW_GRAPH_SCOPE_INVALID', 'scope')
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
    const versions =
      run.state === 'completed' ? this.assets.resolveInputs(run.projectId, run.outputs) : []
    const outputs = agentReplyOutputProjection(
      run.outputs,
      versions.map((version) => version.value)
    )
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
      this.emitTrustedEvent(fixed, input.eventId ?? `${fixed.taskId}:start`, event, fixed.revision)
      fixed.state = 'running'
      fixed.paused = false
      fixed.traceId = input.traceId
      fixed.spanId = input.spanId
      this.store.save(fixed, false)
      // AF-01/O4-P3：固定顺序与图模式不调用主控模型；旧模式保持原有模型协调语义。
      const ruleDriven =
        fixed.config.executionMode === 'fixed-order' || fixed.config.executionMode === 'graph'
      const model = ruleDriven
        ? null
        : await this.model({ ...fixed, agentNodeId: fixed.nodeId }, controller.signal)
      if (!ruleDriven && !model!.coordinate)
        throw new AgentRuntimeError('AGENT_TOOL_UNSUPPORTED', 'coordination')
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
    model: AgentModelPort | null,
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
        this.emitTrustedEvent(run, `${pending.taskId}:completed`, 'agent.completed', run.revision)
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
    const queuedChildren = run.children.filter((child) => ['ready', 'queued'].includes(child.state))
    if (queuedChildren.length) {
      const file = this.check(run)
      const assignments = queuedChildren.map((child) => ({
        nodeId: child.nodeId,
        goal: child.goal,
        completion: child.completion,
        inputs: child.inputs
      }))
      const prepared = new Map<string, AgentTaskSnapshot>()
      for (const child of queuedChildren) {
        const identity = { projectId: run.projectId, nodeId: child.nodeId }
        let task = this.specialists.assignment(identity, run.taskId)
        if (!task || task.snapshot.taskId !== child.taskId) {
          const candidate = this.specialists.describeAssignment(
            {
              ...input,
              nodeId: child.nodeId,
              action: 'start',
              requestId: child.taskId
            },
            true
          )
          if (
            child.inputs.some(
              (ref) =>
                !candidate.directInputs.some(
                  (allowed) => canonicalFlowJson(ref) === canonicalFlowJson(allowed)
                )
            )
          )
            throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'handoff')
          const snapshot = this.specialists.prepareAssignment(
            {
              ...input,
              nodeId: child.nodeId,
              action: 'start',
              requestId: child.taskId
            },
            child,
            run.taskId,
            candidate
          )
          task = this.specialists.assignment(identity, run.taskId)
          if (!task || canonicalFlowJson(task.snapshot) !== canonicalFlowJson(snapshot))
            throw new AgentRuntimeError('RESUME_CONFLICT', 'handoff')
        }
        prepared.set(child.nodeId, task.snapshot)
      }
      const waves = assignmentWaves(assignments, prepared, file)
      const firstWaveIds = new Set(waves[0]?.map((assignment) => assignment.nodeId) ?? [])
      for (const child of queuedChildren)
        child.state = firstWaveIds.has(child.nodeId) ? 'ready' : 'queued'
      this.store.save(run)
      const firstWave = queuedChildren.filter((child) => firstWaveIds.has(child.nodeId))
      const waiting = await this.executeAssignmentWave(run, firstWave, prepared, signal)
      if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
        return false
      if (waiting) return this.wait(run, 'human.wait')
      return true
    }
    // AF-01：固定顺序模式——由声明阶段与进入条件确定性推进，不调用主控模型。
    if (run.config.executionMode === 'fixed-order') return this.fixedOrderStep(run, input, signal)
    // O4-P3：图模式——由声明式图路由确定性推进，只认交付事实，不调用主控模型。
    if (run.config.executionMode === 'graph') return this.graphStep(run, input, signal)
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
        const child = this.specialists.describeAssignment(
          {
            ...input,
            nodeId: id,
            action: 'start',
            requestId: hash([run.taskId, id])
          },
          true
        )
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
        model!.coordinate!(
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
      this.assets.resolveInputs(run.projectId, decision.outputs)
      run.outputs = decision.outputs
      run.decisionPending = false
      this.emitTrustedEvent(
        run,
        `${run.taskId}:completed${run.reworkRound ? `:${run.reworkRound}` : ''}`,
        'flow.completed',
        run.revision
      )
      run.state = 'completed'
      this.store.save(run)
      return false
    }
    return this.dispatchDecision(run, decision, candidates, signal)
  }

  /**
   * 分派执行（模型决策与固定顺序共用）：先持久化任务身份与固定输入，再产生副作用。
   * 候选快照来自准入 describeAssignment；inputs 逐字校验由 admitAssignments 保证。
   */
  private async dispatchDecision(
    run: CoordinationRun,
    decision: Extract<CoordinationDecision, { kind: 'dispatch' } | { kind: 'dispatch-many' }>,
    candidates: Map<string, AgentTaskSnapshot>,
    signal: AbortSignal,
    contextManifests?: Map<string, ContextManifest>,
    envelopes?: Map<string, ExecutionEnvelope>
  ): Promise<boolean> {
    const file = this.check(run)
    const assignments = admitAssignments(run, decision, candidates)
    const waves = assignmentWaves(assignments, candidates, file)
    const firstWaveIds = new Set(waves[0]?.map((assignment) => assignment.nodeId) ?? [])
    const children = assignments.map((assignment) => ({
      nodeId: assignment.nodeId,
      taskId: hash([
        run.taskId,
        assignment.nodeId,
        ...(run.reworkRound ? [run.reworkRound] : []),
        ...(run.loopIterations?.[assignment.nodeId]
          ? [`loop:${run.loopIterations[assignment.nodeId]}`]
          : [])
      ]),
      goal: assignment.goal,
      completion: assignment.completion,
      inputs: assignment.inputs,
      state: firstWaveIds.has(assignment.nodeId) ? 'ready' : 'queued',
      outputs: [] as FlowAgentReply['refs'],
      ...(contextManifests?.get(assignment.nodeId)
        ? { contextManifest: contextManifests.get(assignment.nodeId) }
        : {}),
      ...(envelopes?.get(assignment.nodeId)
        ? { executionEnvelope: envelopes.get(assignment.nodeId) }
        : {})
    }))
    run.children.push(...children)
    run.controlSteps = (run.controlSteps ?? 0) + children.length - 1
    run.decisionPending = false
    // All task identities and fixed inputs survive interruption before the first effect.
    this.store.save(run)
    for (const child of children)
      this.emitTrustedEvent(run, `${child.taskId}:dispatch`, 'agent.dispatched', run.revision)
    const prepared = new Map<string, AgentTaskSnapshot>()
    for (const child of children) {
      const candidate = candidates.get(child.nodeId)
      if (!candidate) throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'handoff')
      prepared.set(
        child.nodeId,
        this.specialists.prepareAssignment(
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
          candidate
        )
      )
    }
    const initialWave = children.filter((child) => firstWaveIds.has(child.nodeId))
    const waiting = await this.executeAssignmentWave(run, initialWave, prepared, signal)
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
      return false
    if (waiting) return this.wait(run, 'human.wait')
    return true
  }

  /**
   * AF-01 固定顺序推进：按声明顺序取第一个未分派阶段，校验进入条件后分派；
   * 全部阶段交付后以最后阶段的正式产物完成。缺字段/缺人工决定不能越过该阶段。
   */
  private async fixedOrderStep(
    run: CoordinationRun,
    input: FlowAgentRun,
    signal: AbortSignal
  ): Promise<boolean> {
    const stages = run.config.stages!
    const facts = this.stageFacts(run)
    // AF-05：同步阶段交付验收记录（已完成阶段的正式产物绑定）。
    this.recordStageDeliveries(run)
    this.store.save(run)
    // 要求人工采用的阶段：子任务即使技术完成，没有显式人工决定也不能交付/推进。
    const undecided = stages.filter((stage) => {
      if (!stage.requireHumanDecision) return false
      const fact = facts.deliveries.find((delivery) => delivery.stageKey === stage.stageKey)
      return fact && !fact.humanDecided
    })
    if (undecided.length) {
      emitGatewayEvent(
        'agent.coordination.stage_human_decision_missing',
        '阶段等待显式人工采用',
        {
          projectId: run.projectId,
          nodeId: run.nodeId,
          taskId: run.taskId,
          traceId: run.traceId,
          spanId: run.spanId
        },
        {
          status: 'skipped',
          attributes: {
            stageKey: undecided[0]!.stageKey,
            missingCount: undecided.length
          }
        }
      )
      return this.wait(run, 'human.wait')
    }
    const dispatched = new Set(run.children.map((child) => child.nodeId))
    const next = stages.find((stage) => !dispatched.has(stage.nodeId))
    if (!next) {
      // 所有阶段已分派：此处只剩全部完成的收尾（未完成子任务已在 step 前段处理/抛错）。
      const last = stages[stages.length - 1]!
      const finalChild = run.children.find((child) => child.nodeId === last.nodeId)!
      if (
        run.children.length !== run.childIds.length ||
        run.children.some((child) => child.state !== 'completed') ||
        run.reviews?.some((review) => review.state !== 'passed') ||
        (run.stageDeliveries ?? []).some((record) => record.stale) ||
        !finalChild.outputs.length
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'stage-delivery')
      this.assets.resolveInputs(run.projectId, finalChild.outputs)
      run.outputs = finalChild.outputs
      this.emitTrustedEvent(
        run,
        `${run.taskId}:completed${run.reworkRound ? `:${run.reworkRound}` : ''}`,
        'flow.completed',
        run.revision
      )
      run.state = 'completed'
      this.store.save(run)
      return false
    }
    if (run.decisions + (run.controlSteps ?? 0) >= run.config.maxSteps)
      throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'coordination')
    const entry = evaluateStageEntry(next, facts)
    if (!entry.ok) {
      const humanPending = entry.reasons.every(
        (reason) =>
          reason.code === 'STAGE_ENTRY_HUMAN_DECISION_MISSING' ||
          reason.code === 'STAGE_ENTRY_REVIEW_NOT_PASSED'
      )
      emitGatewayEvent(
        'agent.coordination.stage_entry_blocked',
        '阶段进入条件未满足',
        {
          projectId: run.projectId,
          nodeId: run.nodeId,
          taskId: run.taskId,
          traceId: run.traceId,
          spanId: run.spanId
        },
        {
          status: humanPending ? 'skipped' : 'failed',
          attributes: {
            stageKey: next.stageKey,
            code: entry.reasons[0]!.code,
            missingCount: entry.reasons.length
          }
        }
      )
      if (humanPending) return this.wait(run, 'human.wait')
      throw new AgentRuntimeError('FLOW_STAGE_ENTRY_UNMET', 'stage-entry')
    }
    // AF-02：声明式输入编制——只取规定内容；必需缺项/超预算阻断，不静默截断。
    let contextManifest: ContextManifest | undefined
    if (next.inputs) {
      contextManifest = buildContextManifest(next.stageKey, next.inputs, facts.deliveries)
      const diag = {
        projectId: run.projectId,
        nodeId: run.nodeId,
        taskId: run.taskId,
        traceId: run.traceId,
        spanId: run.spanId
      }
      if (contextManifestBlocking(contextManifest)) {
        emitGatewayEvent('agent.coordination.stage_context_blocked', '阶段输入编制未通过', diag, {
          status: 'failed',
          attributes: {
            stageKey: next.stageKey,
            code: contextManifest.budget.exceeded
              ? 'CONTEXT_OVER_BUDGET'
              : 'CONTEXT_REQUIRED_MISSING',
            missingCount: contextManifest.missing.filter((item) => item.required).length
          }
        })
        throw new AgentRuntimeError(
          contextManifest.budget.exceeded
            ? 'FLOW_CONTEXT_OVER_BUDGET'
            : 'FLOW_CONTEXT_REQUIRED_MISSING',
          'stage-context'
        )
      }
      emitGatewayEvent('agent.coordination.stage_context_compiled', '阶段输入编制完成', diag, {
        attributes: {
          stageKey: next.stageKey,
          entryCount: contextManifest.entries.length,
          usedBytes: contextManifest.budget.usedBytes
        }
      })
    }
    const candidate = this.specialists.describeAssignment(
      {
        ...input,
        nodeId: next.nodeId,
        action: 'start',
        requestId: hash([run.taskId, next.nodeId, ...(run.reworkRound ? [run.reworkRound] : [])])
      },
      true
    )
    const candidates = new Map<string, AgentTaskSnapshot>([[next.nodeId, candidate]])
    run.decisions++
    this.store.save(run)
    emitGatewayEvent(
      'agent.coordination.stage_dispatched',
      '按声明顺序分派阶段',
      {
        projectId: run.projectId,
        nodeId: run.nodeId,
        taskId: run.taskId,
        traceId: run.traceId,
        spanId: run.spanId
      },
      {
        attributes: {
          stageKey: next.stageKey,
          carrierNodeId: next.nodeId,
          inputCount: candidate.directInputs.length
        }
      }
    )
    // 阶段目标/完成条件逐字来自声明配置；固定输入来自准入候选，不由模型补写。
    // AF-03：执行信封（阶段目标/固定方法/输出要求）随子任务下发，公共内容执行器消费。
    const envelope = composeExecutionEnvelope({
      stageGoal: next.goal,
      methodInstructions: next.method?.instructions,
      outputRequirements: next.completion
    })
    return this.dispatchDecision(
      run,
      {
        kind: 'dispatch',
        nodeId: next.nodeId,
        goal: next.goal,
        completion: next.completion,
        inputs: candidate.directInputs
      },
      candidates,
      signal,
      contextManifest ? new Map([[next.nodeId, contextManifest]]) : undefined,
      envelope ? new Map([[next.nodeId, envelope]]) : undefined
    )
  }

  /**
   * O4-P3：图模式单步——声明式图路由（nextReadyNodes）决定下一可分派节点。
   * 只认已交付事实 + 声明式条件，不调用主控模型、不接受模型文字改路由。
   * 每步分派一个就绪节点（与 fixed-order 同构），完成后再评估；条件分支/汇合由路由决定。
   */
  private async graphStep(
    run: CoordinationRun,
    input: FlowAgentRun,
    signal: AbortSignal
  ): Promise<boolean> {
    const graph = run.config.graph!
    const facts = this.graphFacts(run)
    const loopIterations = { ...(run.loopIterations ?? {}) }
    const delivered = new Set(
      run.children
        .filter((child) => child.state === 'completed' && child.outputs.length)
        .map((child) => child.nodeId)
    )
    if (isFlowComplete(graph, facts, delivered, loopIterations)) {
      const exitChild = [...run.children]
        .reverse()
        .find(
          (child) =>
            graph.exits.includes(child.nodeId) && child.state === 'completed' && child.outputs.length
        )!
      this.assets.resolveInputs(run.projectId, exitChild.outputs)
      run.outputs = exitChild.outputs
      this.emitTrustedEvent(
        run,
        `${run.taskId}:completed${run.reworkRound ? `:${run.reworkRound}` : ''}`,
        'flow.completed',
        run.revision
      )
      run.state = 'completed'
      this.store.save(run)
      return false
    }
    const { ready } = nextReadyNodes(graph, facts, delivered, loopIterations)
    const dispatched = new Set(run.children.map((child) => child.nodeId))
    const next = graph.nodes.find(
      (node) =>
        ready.includes(node.nodeId) &&
        (!dispatched.has(node.nodeId) ||
          loopNeedsAnotherIteration(node, facts, delivered, loopIterations))
    )
    if (!next) {
      // 无就绪未分派节点：等待人工/审核或阻塞，不静默放行。
      return this.wait(run, 'human.wait')
    }
    if (run.decisions + (run.controlSteps ?? 0) >= run.config.maxSteps)
      throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'coordination')
    // ②：capability 图节点直接执行（复用 node.execute 账本端口），不经 agent 分派。
    if (next.kind === 'capability') {
      return this.dispatchCapability(run, next, graph, loopIterations, signal)
    }
    let contextManifest: ContextManifest | undefined
    if (next.inputs) {
      contextManifest = buildContextManifest(next.nodeId, next.inputs, facts.deliveries)
      if (contextManifestBlocking(contextManifest))
        throw new AgentRuntimeError(
          contextManifest.budget.exceeded ? 'FLOW_CONTEXT_OVER_BUDGET' : 'FLOW_CONTEXT_REQUIRED_MISSING',
          'graph-context'
        )
    }
    // O4-P4：循环节点重复分派——递增迭代计数（taskId/requestId 含迭代，区别于上一轮）。
    if (next.loop) {
      loopIterations[next.nodeId] = (loopIterations[next.nodeId] ?? 0) + 1
      run.loopIterations = loopIterations
    }
    const candidate = this.specialists.describeAssignment(
      {
        ...input,
        nodeId: next.nodeId,
        action: 'start',
        requestId: hash([
          run.taskId,
          next.nodeId,
          ...(run.reworkRound ? [run.reworkRound] : []),
          ...(loopIterations[next.nodeId] ? [`loop:${loopIterations[next.nodeId]}`] : [])
        ])
      },
      true
    )
    const candidates = new Map<string, AgentTaskSnapshot>([[next.nodeId, candidate]])
    run.decisions++
    this.store.save(run)
    emitGatewayEvent(
      'agent.coordination.graph_dispatched',
      '按声明式图路由分派节点',
      {
        projectId: run.projectId,
        nodeId: run.nodeId,
        taskId: run.taskId,
        traceId: run.traceId,
        spanId: run.spanId
      },
      { attributes: { carrierNodeId: next.nodeId, inputCount: candidate.directInputs.length } }
    )
    const envelope = composeExecutionEnvelope({
      stageGoal: next.goal,
      outputRequirements: next.completion
    })
    return this.dispatchDecision(
      run,
      {
        kind: 'dispatch',
        nodeId: next.nodeId,
        goal: next.goal,
        completion: next.completion,
        inputs: candidate.directInputs
      },
      candidates,
      signal,
      contextManifest ? new Map([[next.nodeId, contextManifest]]) : undefined,
      envelope ? new Map([[next.nodeId, envelope]]) : undefined
    )
  }

  /**
   * ②：capability 图节点直接执行。按图数据边从已交付子节点输出编制固定输入，经
   * node.execute 同一账本端口执行（复用 renderer 执行器），回执 committed 才记交付。
   * 路由只认交付事实；不经 agent 分派、不调模型。
   */
  private async dispatchCapability(
    run: CoordinationRun,
    next: FlowNode,
    graph: FlowGraph,
    loopIterations: Record<string, number>,
    signal: AbortSignal
  ): Promise<boolean> {
    const file = this.check(run)
    const node = file.nodes.find((item) => item.id === next.nodeId)
    if (!node) throw new AgentRuntimeError('FLOW_GRAPH_SCOPE_INVALID', 'graph-capability')
    const taskId = hash([
      run.taskId,
      next.nodeId,
      ...(run.reworkRound ? [run.reworkRound] : []),
      ...(loopIterations[next.nodeId] ? [`loop:${loopIterations[next.nodeId]}`] : [])
    ])
    const commandId = `graph:${hash([run.taskId, next.nodeId, 'capability', loopIterations[next.nodeId] ?? 0])}`
    const inputPorts = node.ports.filter((port) => port.dir === 'in')
    const incoming = graph.edges.filter(
      (edge) => edge.to.nodeId === next.nodeId && edge.kind === 'data'
    )
    const inputs = incoming.map((edge, index) => {
      const upstream = run.children
        .filter((child) => child.nodeId === edge.from.nodeId && child.state === 'completed')
        .at(-1)
      if (!upstream) throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'graph-capability')
      const port = inputPorts[index] ?? inputPorts[0]
      if (!port) throw new AgentRuntimeError('AGENT_INPUT_TYPE_UNSUPPORTED', 'graph-capability')
      // 与 agent bind 的 freeze 同一机制：assets.submit 生成 sourceNodeId=上游节点的固定引用，
      // 与画布边 from 一致，账本输入源校验通过（raw 子任务 outputRefs 指向底层处理器，源不符）。
      const { ref } = this.assets.submit({
        projectId: run.projectId,
        nodeId: edge.from.nodeId,
        portId: edge.from.portId,
        submissionId: `${taskId}:cap-input:${index}`,
        expectedGraphVersion: file.meta.graphVersion,
        traceId: run.traceId,
        spanId: run.spanId
      })
      return { targetPortId: port.id, assets: [ref] }
    })
    const child: CoordinationRun['children'][number] = {
      nodeId: next.nodeId,
      taskId,
      goal: next.goal,
      completion: next.completion,
      inputs: [],
      state: 'ready',
      outputs: []
    }
    run.children.push(child)
    run.decisions++
    this.store.save(run)
    this.emitTrustedEvent(run, `${taskId}:dispatch`, 'agent.dispatched', run.revision)
    emitGatewayEvent(
      'agent.coordination.graph_dispatched',
      '按声明式图路由分派节点',
      {
        projectId: run.projectId,
        nodeId: run.nodeId,
        taskId: run.taskId,
        traceId: run.traceId,
        spanId: run.spanId
      },
      { attributes: { carrierNodeId: next.nodeId, kind: 'capability', inputCount: inputs.length } }
    )
    const receipt = await this.specialists.executeNodeCommand(
      {
        schemaVersion: 1,
        kind: 'node.execute',
        commandId,
        projectId: run.projectId,
        taskId,
        agentNodeId: run.nodeId,
        targetNodeId: next.nodeId,
        contractVersion: node.contractVersion,
        inputs,
        expectedSemanticRevision: projectSemanticRevision(file),
        traceId: run.traceId,
        spanId: run.spanId
      },
      signal
    )
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
      return false
    if (receipt.state !== 'committed') {
      child.state = 'blocked'
      this.store.save(run)
      throw new AgentRuntimeError(receipt.code ?? 'FLOW_CHILD_BLOCKED', 'graph-capability')
    }
    child.state = 'completed'
    child.outputs = receipt.outputRefs
    this.store.save(run)
    this.emitTrustedEvent(run, `${taskId}:completed`, 'agent.completed', run.revision)
    return true
  }

  /** O4-P3/P4：图模式交付事实——stageKey 即节点 id；循环节点取最近一次迭代交付。只读权威资产与续接记录。 */
  private graphFacts(run: CoordinationRun): StageEntryFacts {
    const latestByNode = new Map<string, (typeof run.children)[number]>()
    for (const child of run.children) {
      if (child.state !== 'completed') continue
      latestByNode.set(child.nodeId, child)
    }
    const deliveries: StageDeliveryFact[] = []
    const graphNodes = run.config.graph?.nodes ?? []
    for (const child of latestByNode.values()) {
      const versions = this.assets.resolveInputs(run.projectId, child.outputs)
      // ②：capability 节点是处理器，无 agent 任务/人工采用；humanDecision 仅对 agent 子节点查询。
      const isAgent = graphNodes.find((node) => node.nodeId === child.nodeId)?.kind === 'agent'
      deliveries.push({
        stageKey: child.nodeId,
        nodeId: child.nodeId,
        outputs: versions.map((version) => version.value),
        humanDecided: isAgent
          ? this.specialists.humanDecision(
              { projectId: run.projectId, nodeId: child.nodeId },
              run.taskId,
              child.taskId
            )
          : false
      })
    }
    return {
      deliveries,
      reviews: (run.reviews ?? []).map((review) => ({ nodeId: review.nodeId, state: review.state }))
    }
  }

  /** 由权威资产与续接记录构造阶段交付事实（不接受调用方正文）。 */
  private stageFacts(run: CoordinationRun): StageEntryFacts {
    const stageByNode = new Map(run.config.stages!.map((stage) => [stage.nodeId, stage]))
    const deliveries: StageDeliveryFact[] = []
    for (const child of run.children) {
      const stage = stageByNode.get(child.nodeId)
      if (!stage || child.state !== 'completed') continue
      const versions = this.assets.resolveInputs(run.projectId, child.outputs)
      deliveries.push({
        stageKey: stage.stageKey,
        nodeId: child.nodeId,
        outputs: versions.map((version) => version.value),
        humanDecided: this.specialists.humanDecision(
          { projectId: run.projectId, nodeId: child.nodeId },
          run.taskId,
          child.taskId
        )
      })
    }
    return {
      deliveries,
      reviews: (run.reviews ?? []).map((review) => ({ nodeId: review.nodeId, state: review.state }))
    }
  }

  /**
   * AF-02：预览阶段输入编制（只读）。返回当前已交付事实下该阶段会采用的清单摘要；
   * includeBody=false 时不含正文（默认），正文显式读取才返回。无运行/无阶段声明返回 null。
   */
  previewStageContext(
    input: Identity,
    stageKey: string,
    includeBody = false
  ): {
    stageKey: string
    manifestHash: string
    entries: Array<{
      sourceStageKey: string
      path: string
      kind: string
      bytes: number
      required: boolean
      purpose?: string
      value?: unknown
    }>
    missing: ContextManifest['missing']
    dropped: ContextManifest['dropped']
    budget: ContextManifest['budget']
    blocking: boolean
  } | null {
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run || !run.config.stages) return null
    const stage = run.config.stages.find((item) => item.stageKey === stageKey)
    if (!stage || !stage.inputs) return null
    const manifest = buildContextManifest(stageKey, stage.inputs, this.stageFacts(run).deliveries)
    return {
      stageKey,
      manifestHash: manifest.manifestHash,
      entries: manifest.entries.map((entry) => ({
        sourceStageKey: entry.sourceStageKey,
        path: entry.path,
        kind: entry.kind,
        bytes: entry.bytes,
        required: entry.required,
        ...(entry.purpose ? { purpose: entry.purpose } : {}),
        ...(includeBody ? { value: entry.value } : {})
      })),
      missing: manifest.missing,
      dropped: manifest.dropped,
      budget: manifest.budget,
      blocking: contextManifestBlocking(manifest)
    }
  }

  /** AF-05：为已完成阶段同步交付验收记录（引用既有不可变资产，不复制全文）。 */
  private recordStageDeliveries(run: CoordinationRun): void {
    const stageByNode = new Map(run.config.stages!.map((stage) => [stage.nodeId, stage]))
    const records = run.stageDeliveries ?? []
    const reviewsPassed = !(run.reviews ?? []).some((review) => review.state !== 'passed')
    for (const child of run.children) {
      const stage = stageByNode.get(child.nodeId)
      if (!stage || child.state !== 'completed' || !child.outputs.length) continue
      if (records.some((record) => record.taskId === child.taskId && !record.stale)) continue
      records.push(
        StageDeliveryRecordSchema.parse({
          schemaVersion: 1,
          stageKey: stage.stageKey,
          nodeId: child.nodeId,
          taskId: child.taskId,
          outputRefs: child.outputs,
          ...(child.contextManifest
            ? { contextManifestHash: child.contextManifest.manifestHash }
            : {}),
          ...(child.executionEnvelope
            ? { envelopeHash: `sha256:${hash(child.executionEnvelope)}` }
            : {}),
          humanDecided: this.specialists.humanDecision(
            { projectId: run.projectId, nodeId: child.nodeId },
            run.taskId,
            child.taskId
          ),
          reviewPassed: reviewsPassed,
          definitionRevision: `sha256:${run.scopeRevision}`,
          acceptedAt: Date.now(),
          stale: false
        })
      )
    }
    run.stageDeliveries = records
  }

  /**
   * AF-05：局部返工——从指定阶段起重跑，仅影响该阶段及其下游；上游已完成阶段不重跑。
   * 旧交付移入 reworkHistory（不改写），下游交付标 stale；子任务身份用新轮次派生。
   * 有界：返工轮次上限 10；unknown/pending 命令未结算时拒绝（不盲目重发）。
   */
  reworkStage(input: Identity, stageKey: string): FlowAgentView {
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run || !run.config.stages || run.config.executionMode !== 'fixed-order')
      throw new AgentRuntimeError('FLOW_STAGE_REWORK_UNSUPPORTED', 'rework')
    if (this.active.has(run.taskId)) throw new AgentRuntimeError('AGENT_TASK_BUSY', 'rework')
    if (!['completed', 'waiting', 'blocked'].includes(run.state))
      throw new AgentRuntimeError('FLOW_STAGE_REWORK_BUSY', 'rework')
    const stages = run.config.stages
    const index = stages.findIndex((stage) => stage.stageKey === stageKey)
    if (index < 0) throw new AgentRuntimeError('FLOW_STAGE_MISSING', 'rework')
    if ((run.reworkRound ?? 0) >= 10)
      throw new AgentRuntimeError('FLOW_REWORK_BUDGET_EXHAUSTED', 'rework')
    // 未结算命令（pending/unknown）存在时拒绝返工，避免重发在途副作用。
    const unresolved = this.db
      .prepare(
        "SELECT 1 FROM flow_commands WHERE project_id=? AND task_id=? AND state IN ('pending','unknown') LIMIT 1"
      )
      .get(run.projectId, run.taskId)
    if (unresolved) throw new AgentRuntimeError('FLOW_COMMAND_OUTCOME_UNKNOWN', 'rework')
    this.check(run)
    const affected = new Set(stages.slice(index).map((stage) => stage.nodeId))
    const history = run.reworkHistory ?? []
    const kept: CoordinationRun['stageDeliveries'] = []
    for (const record of run.stageDeliveries ?? []) {
      if (affected.has(record.nodeId)) history.push({ ...record, stale: true })
      else kept.push(record)
    }
    // 移除受影响阶段的子任务（上游保留）；旧 specialist 任务作为历史保留在任务表。
    run.children = run.children.filter((child) => !affected.has(child.nodeId))
    run.stageDeliveries = kept
    run.reworkHistory = history
    run.reworkRound = (run.reworkRound ?? 0) + 1
    run.outputs = []
    run.code = undefined
    run.decisionPending = false
    this.emitTrustedEvent(run, `${run.taskId}:rework:${run.reworkRound}`, 'flow.rework', run.revision)
    // 返工后停在等待态，由显式 continue 恢复固定顺序推进（不自动重发）。
    run.state = 'waiting'
    run.waitRevision++
    // 完成时曾 release 控制范围；返工重新占用，保证续跑时范围归属一致。
    this.store.reoccupy(run, run.scopeIds)
    this.store.save(run)
    emitGatewayEvent(
      'agent.coordination.stage_rework',
      '阶段局部返工',
      {
        projectId: run.projectId,
        nodeId: run.nodeId,
        taskId: run.taskId,
        traceId: run.traceId,
        spanId: run.spanId
      },
      {
        attributes: {
          stageKey,
          round: run.reworkRound,
          affectedCount: affected.size
        }
      }
    )
    return this.view(run)
  }

  private async executeAssignmentWave(
    run: CoordinationRun,
    children: CoordinationRun['children'],
    prepared: Map<string, AgentTaskSnapshot>,
    signal: AbortSignal
  ): Promise<boolean> {
    const replies = await Promise.allSettled(
      children.map((child) =>
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
                expectedTaskId: child.taskId,
                traceId: run.traceId,
                spanId: run.spanId
              },
              child,
              run.taskId,
              prepared.get(child.nodeId)
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
      const child = children[index]!
      if (result.status === 'rejected') {
        child.state = 'blocked'
        failure ??= result.reason
        this.store.save(run)
        continue
      }
      const reply = result.value
      child.state = reply.task.state
      child.outputs = reply.refs
      this.store.save(run)
      try {
        if (child.state === 'completed') {
          await this.publishChild(run, child.nodeId, reply, signal)
          this.emitTrustedEvent(run, `${child.taskId}:completed`, 'agent.completed', run.revision)
        } else if (child.state !== 'waiting')
          throw new AgentRuntimeError(reply.task.code ?? 'FLOW_CHILD_BLOCKED', 'handoff')
      } catch (error) {
        failure ??= error
      }
      if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
        return false
    }
    if (failure) throw failure
    return children.some((child) => child.state === 'waiting')
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
        this.emitTrustedEvent(
          run,
          `${cycle.requestId}:${record.decision.passed ? 'review.passed' : 'review.rejected'}`,
          record.decision.passed ? 'review.passed' : 'review.rejected',
          run.revision
        )
      }
      for (const child of run.children) {
        let record: ReturnType<FlowAgentDesktopHost['assignment']> = null
        try {
          record = this.specialists.assignment(
            { projectId: run.projectId, nodeId: child.nodeId },
            run.taskId
          )
        } catch (error) {
          if (!(error instanceof AgentRuntimeError) || error.code !== 'FLOW_SCOPE_REJECTED')
            throw error
        }
        if (!record || record.snapshot.taskId !== child.taskId) {
          if (['ready', 'queued'].includes(child.state)) {
            observed = true
            continue
          }
          reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
          continue
        }
        if (
          record.state === 'ready' &&
          record.snapshot.coordinatorTaskId === run.taskId &&
          ['ready', 'queued'].includes(child.state)
        ) {
          observed = true
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
        const expectedOutputs = agentReplyOutputProjection(
          record.outputRefs,
          values.map((asset) => asset.value)
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
          this.emitTrustedEvent(run, `${child.taskId}:completed`, 'agent.completed', run.revision)
        }
      }
      if (!observed) reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
      if (controller.signal.aborted) throw new AgentRuntimeError('AGENT_CANCELLED', 'recovery')
      run.recovery = { reasons: [...new Set(reasons)], canRestore }
      if (!reasons.length) {
        if (
          this.store.hasEvent(
            run,
            `${run.taskId}:completed${run.reworkRound ? `:${run.reworkRound}` : ''}`,
            'flow.completed'
          )
        ) {
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
          this.emitTrustedEvent(run, `${input.eventId}:recovery-wait`, 'human.wait', run.revision)
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
    this.emitTrustedEvent(run, `${run.taskId}:wait:${run.waitRevision + 1}`, event, run.revision)
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
