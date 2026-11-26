import { findCompositeCommandWait } from './composite-target'
import type Database from 'better-sqlite3'
import { graphCanvasVersion } from './graph-canvas-version'
import { createHash } from 'node:crypto'
import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import type { ProjectFile, PortDecl } from '../../shared/types'
import {
  AgentNodeConfigSchema,
  ReviewNodeConfigSchema,
  StateMachineNodeConfigSchema,
  type AgentFlowAssetRef
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
  type FlowStageReworkImpact,
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
  compileFixedOrderRouting,
  graphReworkNodes,
  nextReadyNodes,
  isFlowComplete,
  loopNeedsAnotherIteration,
  loopExitConditionSatisfied,
  flowRouteState
} from '../../shared/agent-flow/flow-graph-router'
import { FlowAssetError, type FlowAssetValue } from '../../shared/agent-flow/assets'
import { readCompositeInstanceManifest } from '../../shared/composite/outputs'
import {
  isDispatchableFlowNodeKind,
  loopBodyInfo,
  resolveFlowNodeDimensions,
  type LoopBodyInfo,
  type FlowNode,
  type FlowGraph
} from '../../shared/agent-flow/flow-graph'
import {
  assembleContextManifest,
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
import { stopAgentVideos } from './video-tasks'
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
  private readonly terminalEvents = new Set<string>()
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
      eventId: string,
      phaseProjection?: import('../../shared/agent-flow/desktop-tasks').FlowPhaseProjection
    ) => Promise<void>
  ) {
    this.store = new CoordinationStore(db)
    this.reports = new FlowReviewStore(db)
    this.assets = new FlowAssetStore(db, open)
    this.reviews = new CoordinatorReviews(
      db, open, specialists, publish, (run) => this.check(run),
      (run, eventId, event) => this.emitTrustedEvent(run, eventId, event, run.revision)
    )
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
    expectedRevision: number,
    actorSource?: import('../../shared/agent-flow/run-overview').FlowEventActorSource,
    resumeRevision?: number
  ): void {
    const child = event.startsWith('agent.')
      ? run.children.find((entry) => eventId.startsWith(`${entry.taskId}:`))
      : undefined
    this.store.event(run, eventId, event, expectedRevision, actorSource ?? (
      child ? `agent:${child.nodeId}` : 'system'
    ), resumeRevision)
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
      eventId,
      run.config.executionMode === 'graph' && run.stateConfig.initialState === 'idle' &&
        run.stateConfig.states.includes('reviewing') && run.stateConfig.states.includes('waiting-human')
        ? { taskId: run.taskId, phase: run.phase, revision: run.revision }
        : undefined
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
  private emitCoordinationTerminal(
    run: CoordinationRun,
    outcome: 'completed' | 'cancelled' | 'failed',
    context: { projectId: string; nodeId: string; taskId: string; traceId: string; spanId: string },
    attributes: { phase?: string; code?: string; resumesTraceId?: string } = {},
    retain = true
  ): void {
    if (this.terminalEvents.has(run.taskId)) return
    if (retain) this.terminalEvents.add(run.taskId)
    emitGatewayEvent(
      `agent.coordination.${outcome}`,
      outcome === 'cancelled'
        ? '主 Agent 协调已取消'
        : outcome === 'failed'
          ? '主 Agent 协调未确认'
          : '主 Agent 协调结束',
      context,
      {
        status: outcome === 'completed' ? 'success' : outcome === 'cancelled' ? 'cancelled' : 'failed',
        attributes
      }
    )
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
  private ensureBudget(run: CoordinationRun): void {
    const now = Date.now()
    if (run.startedAt === undefined) run.startedAt = now
    if (run.deadlineAt === undefined) {
      const maxActiveMs = run.config.graph?.budgets.maxActiveMs ?? 600000
      run.deadlineAt = run.startedAt + maxActiveMs
    }
    if (now >= run.deadlineAt)
      throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'coordination')
  }
  private remainingBudgetMs(run: CoordinationRun): number {
    this.ensureBudget(run)
    return Math.max(1, run.deadlineAt! - Date.now())
  }
  /**
   * A3：等待原因单一判定。此前 view() 把所有 waiting 都报成 waitKind='human'，
   * 于是"有在途子任务 / 排队待审 / 就绪但不可分派"都被当成人工待办；
   * 这里按运行事实区分，只有确实在等人（等待中的子任务或未决定的人工阶段）才算 human。
   */
  private waitReason(run: CoordinationRun): FlowAgentView['waitReason'] {
    if (run.state !== 'waiting') return undefined
    if (run.paused) return 'paused'
    if (run.code === 'FLOW_CONTEXT_OVER_BUDGET') return 'human'
    if (run.children.some((child) => ['ready', 'running', 'queued'].includes(child.state)))
      return 'active-child'
    if ((run.reviews ?? []).some((review) => review.state === 'pending')) return 'pending-review'
    if (run.children.some((child) => child.state === 'waiting')) return 'human'
    const undecided = (run.config.stages ?? []).some((stage) => {
      if (!stage.requireHumanDecision) return false
      const delivery = (run.stageDeliveries ?? []).find((item) => item.stageKey === stage.stageKey)
      return Boolean(delivery && !delivery.humanDecided)
    })
    if (undecided) return 'human'
    return 'blocked'
  }
  private view(run: CoordinationRun): FlowAgentView {
    const waitReason = this.waitReason(run)
    return {
      taskId: run.taskId,
      state: run.state,
      waitKind: waitReason === 'human' ? 'human' : null,
      waitReason,
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
    const wasActive = this.active.has(run.taskId)
    run.state = 'cancelled'
    run.code = 'AGENT_CANCELLED'
    this.store.save(run)
    this.active.get(run.taskId)?.abort()
    for (const review of run.reviews ?? []) this.cancelReview?.(run.projectId, review.nodeId)
    for (const child of run.children.filter(
      (c) => !['completed', 'cancelled', 'failed'].includes(c.state)
    )) {
      const kind = run.config.graph?.nodes.find((node) => node.nodeId === child.nodeId)?.kind
      if (kind === 'capability') {
        stopAgentVideos(this.db, run.projectId, child.taskId)
        child.state = 'cancelled'
        continue
      }
      if (kind === 'human-task') {
        child.state = 'cancelled'
        continue
      }
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
    this.store.save(run)
    if (run.stateConfig.transitions.some((edge) => edge.from === run.phase && edge.event === 'flow.stopped')) {
      this.emitTrustedEvent(run, `${run.taskId}:stopped`, 'flow.stopped', run.revision)
    }
    this.store.release(run)
    this.emitCoordinationTerminal(run, 'cancelled', {
      projectId: run.projectId,
      nodeId: run.nodeId,
      taskId: run.taskId,
      traceId: run.traceId,
      spanId: run.spanId
    }, { code: 'AGENT_CANCELLED' }, wasActive)
    return this.view(run)
  }
  private bind(input: FlowAgentRun): CoordinationRun {
    const file = this.file(input),
      root = shape(file, input.nodeId)
    const config = AgentNodeConfigSchema.parse(JSON.parse(root.props.config))
    const fixedOrder = config.executionMode === 'fixed-order'
    const graphMode = config.executionMode === 'graph'
    const canvasVersion = graphMode ? graphCanvasVersion(this.db, file, input.nodeId) : undefined
    if (canvasVersion?.diverged)
      throw new AgentRuntimeError('FLOW_CANVAS_DIVERGED', 'definition')
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
      // ②：capability/human-task 子节点非 agent specialist（处理器/纯人工），跳过 agent 契约校验。
      if (graphNode?.kind === 'capability' || graphNode?.kind === 'human-task') {
        if (child.props.nodeType === 'agent' || id === input.nodeId)
          throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
        controls.add(id)
        continue
      }
      const cfg = AgentNodeConfigSchema.parse(JSON.parse(child.props.config))
      if (child.props.nodeType !== 'agent' || cfg.role !== 'specialist' || id === input.nodeId)
        throw new AgentRuntimeError('FLOW_COORDINATOR_SCOPE_INVALID', 'scope')
      for (const target of cfg.allowedNodeIds) {
        // BL-11：graph 模式下控制关系由 FlowGraph 拓扑决定；agent 的 legacy
        // allowedNodeIds 只作兼容声明，不再与图节点争用控制权。
        if (!graphMode && reservedControls.has(target))
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
    // O4-P3/②/⑥：图模式支持 agent + capability + human-task + review 节点路由；
    // 图节点承载必须与子节点+审核节点一一对应；路由只认交付事实（见 graphStep）。
    if (graphMode) {
      const graph = config.graph!
      // BL-05：与 validateFlowGraph 同一种类白名单（校验即准入）。
      if (graph.nodes.some((node) => !isDispatchableFlowNodeKind(node.kind)))
        throw new AgentRuntimeError('FLOW_GRAPH_NODE_KIND_UNSUPPORTED', 'scope')
      const graphNodeIds = new Set(graph.nodes.map((node) => node.nodeId))
      const scopeIds = [...childIds, ...reviewIds]
      if (graphNodeIds.size !== scopeIds.length || scopeIds.some((id) => !graphNodeIds.has(id)))
        throw new AgentRuntimeError('FLOW_GRAPH_SCOPE_INVALID', 'scope')
      const reviewGraphNodeIds = new Set(
        graph.nodes.filter((node) => node.kind === 'review').map((node) => node.nodeId)
      )
      if (reviewIds.some((id) => !reviewGraphNodeIds.has(id)))
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
      sourceGraph: canvasVersion?.sourceGraph,
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
      spanId: input.spanId,
      startedAt: Date.now(),
      deadlineAt: Date.now() + (graphMode ? config.graph!.budgets.maxActiveMs : 600000)
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
    if (run && input.action === 'start' && run.taskId === input.requestId) {
      if (terminal(run)) this.store.release(run)
      return this.reply(run)
    }
    if (run && !terminal(run) && input.action === 'start')
      throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'admission')
    if (input.action === 'continue') {
      if (run && run.taskId === input.expectedTaskId) {
        const seen = this.store.continuation(run, input.eventId!, input.expectedWaitRevision!)
        if (seen === 'replay') {
          if (this.active.has(run.taskId))
            throw new AgentRuntimeError('AGENT_TASK_BUSY', 'coordination')
          return this.reply(run)
        }
        if (seen === 'conflict') throw new AgentRuntimeError('RESUME_CONFLICT', 'resume')
      }
      if (
        !run ||
        run.state !== 'waiting' ||
        run.taskId !== input.expectedTaskId ||
        run.waitRevision !== input.expectedWaitRevision
      )
        throw new AgentRuntimeError('RESUME_CONFLICT', 'resume')
      this.check(run)
      if (run.code === 'FLOW_CONTEXT_OVER_BUDGET' && !input.humanConfirmed)
        throw new AgentRuntimeError('HUMAN_CONFIRMATION_REQUIRED', 'resume')
      const waitingStage = run.contextWaitStageKey
      if (input.contextMaterial && (run.code !== 'FLOW_CONTEXT_OVER_BUDGET' || !waitingStage))
        throw new AgentRuntimeError('FLOW_CONTEXT_MATERIAL_UNEXPECTED', 'resume')
    } else run = this.bind(input)
    const fixed = run!
    if (this.active.has(fixed.taskId))
      throw new AgentRuntimeError('AGENT_TASK_BUSY', 'coordination')
    const controller = new AbortController()
    this.active.set(fixed.taskId, controller)
    this.ensureBudget(fixed)
    const deadlineTimer = setTimeout(
      () => controller.abort(new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'coordination')),
      Math.max(1, fixed.deadlineAt! - Date.now())
    )
    deadlineTimer.unref()
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
      const actorSource = input.humanConfirmed || input.runOrigin !== 'external'
        ? `user:${fixed.config.humanRole ?? 'owner'}` as const
        : input.externalClientId
          ? `agent:external:${input.externalClientId}` as const
          : 'agent:external'
      this.emitTrustedEvent(
        fixed, input.eventId ?? `${fixed.taskId}:start`, event, fixed.revision, actorSource,
        input.action === 'continue' ? input.expectedWaitRevision : undefined
      )
      fixed.state = 'running'
      if (fixed.code === 'FLOW_CONTEXT_OVER_BUDGET') fixed.code = undefined
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
      this.emitCoordinationTerminal(
        current,
        current.state === 'cancelled' ? 'cancelled' : current.state === 'failed' ? 'failed' : 'completed',
        context,
        { code: current.code }
      )
      return this.reply(current)
    } catch (error) {
      const current = this.store.latest(fixed.projectId, fixed.nodeId)!
      if (current.state !== 'cancelled') {
        current.state = 'blocked'
        current.code = error instanceof AgentRuntimeError ? error.code : 'FLOW_COORDINATION_FAILED'
        if (current.stateConfig.transitions.some((edge) => edge.from === current.phase && edge.event === 'flow.failed')) {
          this.emitTrustedEvent(current, `${current.taskId}:failed:${current.revision}`, 'flow.failed', current.revision)
        }
        this.store.save(current)
      }
      this.emitCoordinationTerminal(
        current,
        current.state === 'cancelled' ? 'cancelled' : 'failed',
        context,
        { phase: 'coordination', code: current.code }
      )
      if (current.state === 'cancelled') return this.reply(current)
      throw error
    } finally {
      clearTimeout(deadlineTimer)
      this.active.delete(fixed.taskId)
      this.terminalEvents.delete(fixed.taskId)
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
    this.ensureBudget(run)
    this.check(run)
    if (stored.paused) return this.wait(run, 'flow.paused')
    const control = await this.reviews.step(run, signal)
    if (control === 'again') return true
    const pendingChildren = run.children.filter(
      (c) =>
        c.state === 'waiting' &&
        !run.reviews?.some(
          (review) => review.responsibleNodeId === c.nodeId && review.state === 'human-wait'
        ) &&
        // ②：capability/human-task 图节点由 graphStep 直接执行/停等，不走 agent 停等续跑。
        (run.config.graph?.nodes.find((node) => node.nodeId === c.nodeId)?.kind ?? 'agent') ===
          'agent'
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
    const queuedChildren = run.children.filter(
      (child) => ['ready', 'queued'].includes(child.state) &&
        (run.config.graph?.nodes.find((node) => node.nodeId === child.nodeId)?.kind ?? 'agent') === 'agent'
    )
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
              ...(child.routedInputEdgeIds ? { routedInputEdgeIds: child.routedInputEdgeIds } : {}),
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
              ...(child.routedInputEdgeIds ? { routedInputEdgeIds: child.routedInputEdgeIds } : {}),
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
      const waves = assignmentWaves(
        assignments,
        prepared,
        file,
        run.config.maxParallelTasks ?? 1
      )
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
        run.reviews?.some((review) => review.state !== 'passed') ||
        decision.outputs.some((r) => !allowed.has(canonicalFlowJson(r))) ||
        new Set(decision.outputs.map(canonicalFlowJson)).size !== decision.outputs.length
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'coordination')
      this.assertChildrenComplete(run)
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
    envelopes?: Map<string, ExecutionEnvelope>,
    routedInputEdgeIds?: string[]
  ): Promise<boolean> {
    const file = this.check(run)
    const assignments = admitAssignments(run, decision, candidates)
    const waves = assignmentWaves(
      assignments,
      candidates,
      file,
      run.config.maxParallelTasks ?? 1
    )
    const firstWaveIds = new Set(waves[0]?.map((assignment) => assignment.nodeId) ?? [])
    // BL-11：v2 循环体子任务按载体轮次取独立 taskId（与上一轮历史区分）。
    const bodies = run.config.graph ? loopBodyInfo(run.config.graph) : new Map()
    const roundOf = (nodeId: string): number | undefined => {
      for (const info of bodies.values())
        if (info.body.has(nodeId)) return run.loopIterations?.[info.carrierId] ?? 1
      return undefined
    }
    const children = assignments.map((assignment) => {
      const round = roundOf(assignment.nodeId)
      return {
        nodeId: assignment.nodeId,
        taskId: hash([
          run.taskId,
          assignment.nodeId,
          ...(run.reworkRound ? [run.reworkRound] : []),
          ...((round ?? run.loopIterations?.[assignment.nodeId])
            ? [`loop:${round ?? run.loopIterations?.[assignment.nodeId]}`]
            : [])
        ]),
        goal: assignment.goal,
        completion: assignment.completion,
        inputs: assignment.inputs,
        state: firstWaveIds.has(assignment.nodeId) ? 'ready' : 'queued',
        outputs: [] as FlowAgentReply['refs'],
        ...(typeof round === 'number' ? { round } : {}),
        ...(contextManifests?.get(assignment.nodeId)
          ? { contextManifest: contextManifests.get(assignment.nodeId) }
          : {}),
        ...(envelopes?.get(assignment.nodeId)
          ? { executionEnvelope: envelopes.get(assignment.nodeId) }
          : {}),
        ...(routedInputEdgeIds ? { routedInputEdgeIds } : {})
      }
    })
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
      candidate.maxActiveMs = Math.min(candidate.maxActiveMs, this.remainingBudgetMs(run))
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
    const graph = compileFixedOrderRouting(stages)
    const delivered = new Set(
      run.children.filter((child) => child.state === 'completed').map((child) => child.nodeId)
    )
    const route = nextReadyNodes(graph, facts, delivered)
    const next = stages.find((stage) => stage.nodeId === route.ready[0])
    if (isFlowComplete(graph, facts, delivered)) {
      const finalChild = run.children.find((child) => graph.exits.includes(child.nodeId))
      if (
        run.reviews?.some((review) => review.state !== 'passed') ||
        (run.stageDeliveries ?? []).some((record) => record.stale) ||
        !finalChild?.outputs.length
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'stage-delivery')
      this.assertChildrenComplete(run)
      return this.completeRoutedFlow(run, finalChild.outputs)
    }
    if (!next || run.children.some((child) => child.nodeId === next.nodeId))
      throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'stage-delivery')
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
      contextManifest = buildContextManifest(next.stageKey, next.inputs, facts.deliveries, {
        humanMaterial: run.contextWaitStageKey === next.stageKey ? input.contextMaterial : undefined
      })
      if (next.inputs.overflow === 'ask-human' && contextManifest.budget.exceeded)
        return this.waitForContextBudget(run, contextManifest)
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
    return this.dispatchRoutedAgent(run, input, next, signal, contextManifest, {
      stageKey: next.stageKey,
      methodInstructions: next.method?.instructions
    })
  }

  private assertChildrenComplete(run: CoordinationRun): void {
    if (run.config.executionMode === 'graph') {
      const skipped = new Set(run.skippedNodeIds ?? [])
      const expected = run.childIds.filter((id) => !skipped.has(id))
      if (
        expected.some(
          (nodeId) =>
            !run.children.some(
              (child) => child.nodeId === nodeId && child.state === 'completed'
            )
        ) ||
        run.children.some(
          (child) =>
            child.state !== 'completed' &&
            !(child.state === 'skipped' && skipped.has(child.nodeId))
        )
      )
        throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'graph-complete')
      return
    }
    if (
      run.children.length !== run.childIds.length ||
      run.children.some((child) => child.state !== 'completed')
    )
      throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'coordination')
  }

  private completeRoutedFlow(run: CoordinationRun, outputs: AgentFlowAssetRef[]): false {
    this.assets.resolveInputs(run.projectId, outputs)
    run.outputs = outputs
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

  private routedGraphCanvasEdgeIds(
    graph: FlowGraph,
    file: ProjectFile,
    edgeState: ReturnType<typeof flowRouteState>['edgeState'],
    targetNodeId: string,
    effectiveIncoming?: FlowGraph['edges']
  ): string[] {
    const selected = new Set(
      (effectiveIncoming ?? graph.edges)
        .filter((edge) => edgeState(edge) === 'satisfied')
        .map((edge) => canonicalFlowJson({ from: edge.from, to: edge.to }))
    )
    return file.edges
      .filter(
        (edge) =>
          edge.to.nodeId === targetNodeId &&
          selected.has(canonicalFlowJson({ from: edge.from, to: edge.to }))
      )
      .map((edge) => edge.id)
  }

  private routedCanvasEdgeIds(
    graph: FlowGraph,
    file: ProjectFile,
    edgeState: ReturnType<typeof flowRouteState>['edgeState']
  ): string[] {
    const graphEdgeStates = new Map(
      graph.edges.map((edge) => [
        canonicalFlowJson({ from: edge.from, to: edge.to }),
        edgeState(edge)
      ])
    )
    const scopeTargets = new Set(graph.nodes.map((node) => node.nodeId))
    for (const node of graph.nodes) {
      if (node.kind !== 'agent') continue
      try {
        const config = AgentNodeConfigSchema.parse(
          JSON.parse(shape(file, node.nodeId).props.config)
        )
        for (const id of config.allowedNodeIds) scopeTargets.add(id)
      } catch {
        /* The normal bind path reports the invalid carrier config. */
      }
    }
    return file.edges
      .filter((edge) => {
        if (!scopeTargets.has(edge.to.nodeId)) return false
        const key = canonicalFlowJson({ from: edge.from, to: edge.to })
        return !graphEdgeStates.has(key) || graphEdgeStates.get(key) === 'satisfied'
      })
      .map((edge) => edge.id)
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
    // BL-21：capability 的「AI 产出、人采用」——人工点击继续即采用上一份交付。
    if (run.code === 'HUMAN_ADOPTION_REQUIRED') {
      if (!input.humanConfirmed)
        throw new AgentRuntimeError('HUMAN_CONFIRMATION_REQUIRED', 'graph-adoption')
      const adopted = run.children.find((child) => child.adoptionPending)
      if (adopted) {
        adopted.state = 'completed'
        adopted.humanDecided = true
        delete adopted.adoptionPending
        run.code = undefined
        this.emitTrustedEvent(run, `${adopted.taskId}:adopted`, 'agent.completed', run.revision)
        this.store.save(run)
      }
    }
    const file = this.check(run)
    const nodeById = new Map(file.nodes.map((node) => [node.id, node]))
    const isRequiredInput = (nodeId: string, portId: string): boolean => {
      const node = nodeById.get(nodeId)
      if (!node?.ports.some((port) => port.dir === 'in' && port.id === portId && port.required)) {
        return false
      }
      if (node.type !== 'composite') return true
      const manifest = readCompositeInstanceManifest(shape(file, nodeId))
      return !manifest?.inputs.some((port) =>
        `in-${port.id}` === portId && port.defaultValue !== undefined
      )
    }
    this.recordStageDeliveries(run)
    const bodies = loopBodyInfo(graph)
    const loopIterations = { ...(run.loopIterations ?? {}) }
    // BL-11 / AF-8.4b：子图循环体按「当前轮次」计算交付；其他节点按全局交付。
    let delivered = this.roundScopedDelivered(run, bodies, loopIterations)
    // ⑥审核门禁：通过的审核节点视为已交付（下游受控节点据此放行）。
    for (const review of run.reviews ?? []) {
      if (review.state === 'passed') delivered.add(review.nodeId)
    }
    let facts = this.graphFacts(run, { bodies, loopIterations })
    // 一轮 body 出口全部交付后评估退出条件；不满足且未达上限则开下一轮。
    if (this.advanceLoopRounds(run, graph, facts, delivered, bodies, loopIterations)) {
      delivered = this.roundScopedDelivered(run, bodies, loopIterations)
      facts = this.graphFacts(run, { bodies, loopIterations })
    }
    const executionSkipped = new Set(run.children
      .filter((child) => {
        if (child.state !== 'skipped') return false
        const body = [...bodies.values()].find((info) => info.body.has(child.nodeId))
        return !body || (child.round ?? 1) === (loopIterations[body.carrierId] ?? 1)
      })
      .map((child) => child.nodeId))
    const route = nextReadyNodes(
      graph, facts, delivered, loopIterations, isRequiredInput, executionSkipped
    )
    run.skippedNodeIds = route.skipped
    run.stalledNodeIds = undefined
    const { edgeState } = flowRouteState(
      graph, facts, delivered, loopIterations, isRequiredInput, executionSkipped
    )
    const routedInputEdgeIds = this.routedCanvasEdgeIds(graph, file, edgeState)
    const routedInput = { ...input, routedInputEdgeIds }
    if (isFlowComplete(graph, facts, delivered, loopIterations, isRequiredInput, executionSkipped)) {
      // 出口可能是审核节点（交付物=被审核通过的固定版本）或普通子节点。
      const exitReview = (run.reviews ?? []).find(
        (review) => graph.exits.includes(review.nodeId) && review.state === 'passed' && review.decision
      )
      const exitChild = [...run.children]
        .reverse()
        .find(
          (child) =>
            graph.exits.includes(child.nodeId) && child.state === 'completed' && child.outputs.length
        )
      const exitOutputs = exitReview?.decision?.subjects ?? exitChild?.outputs
      if (!exitOutputs) throw new AgentRuntimeError('FLOW_CHILD_BLOCKED', 'graph-complete')
      return this.completeRoutedFlow(run, exitOutputs)
    }
    const { ready } = route
    // BL-04 运行期兜底：多值交付同时命中多个互斥分支时拒绝推进（不猜走哪条）。
    if (route.ambiguous.length > 0) {
      emitGatewayEvent(
        'agent.coordination.graph_ambiguous',
        '图路由：同一节点多个互斥分支同时成立',
        { projectId: run.projectId, nodeId: run.nodeId, taskId: run.taskId, traceId: run.traceId, spanId: run.spanId },
        { status: 'failed', attributes: { sourceNodeIds: route.ambiguous.join(',') } }
      )
      throw new AgentRuntimeError('FLOW_BRANCH_AMBIGUOUS', 'graph-route')
    }
    const dispatched = new Set(run.children.map((child) => child.nodeId))
    const bodyOf = new Map<string, LoopBodyInfo>()
    for (const info of bodies.values()) for (const id of info.body) bodyOf.set(id, info)
    // 轮次入口：v2 循环体节点在「当前轮次未交付」时允许重新分派（上一轮子任务不算本轮交付）。
    const roundEntry = (nodeId: string): boolean => bodyOf.has(nodeId) && !delivered.has(nodeId)
    const next = graph.nodes.find(
      (node) =>
        // ⑥：review 节点由 reviews.step 控制环驱动，不经图分派。
        node.kind !== 'review' &&
        ready.includes(node.nodeId) &&
        (!dispatched.has(node.nodeId) ||
          roundEntry(node.nodeId) ||
          loopNeedsAnotherIteration(node, facts, delivered, loopIterations) ||
          // ②：human-task 停等后人工已提交（续跑）→ 重新分派以应用提交并投影交付。
          ((node.kind === 'human-task' || node.kind === 'capability') &&
            run.children.some((child) => child.nodeId === node.nodeId &&
              (child.state === 'waiting' || (node.kind === 'capability' && child.state === 'ready')))))
    )
    if (!next) {
      // BL-03 / AF-8.5b：区分「确有待办（等人/等审核/有在途子任务）」与「停滞」。
      // 停滞=没有就绪节点、没有在途或等待中的子任务、没有未通过的审核——不再报成等待人工。
      const activeChild = run.children.some((child) =>
        ['ready', 'running', 'queued', 'waiting'].includes(child.state)
      )
      const pendingReview = (run.reviews ?? []).some((review) => review.state !== 'passed')
      if (ready.length > 0 || activeChild || pendingReview) return this.wait(run, 'human.wait')
      const stalled = route.blocked.map((item) => item.nodeId)
      run.stalledNodeIds = stalled
      const allExitsSkipped = graph.exits.every((exit) => route.skipped.includes(exit))
      emitGatewayEvent(
        'agent.coordination.graph_stalled',
        '图路由停滞：没有可推进的节点',
        { projectId: run.projectId, nodeId: run.nodeId, taskId: run.taskId, traceId: run.traceId, spanId: run.spanId },
        {
          status: 'failed',
          attributes: {
            reason: allExitsSkipped ? 'ALL_EXITS_SKIPPED' : 'INCOMING_EDGES_UNSATISFIED',
            stalledNodeIds: stalled.join(',').slice(0, 512),
            skippedCount: route.skipped.length
          }
        }
      )
      throw new AgentRuntimeError('FLOW_STALLED', 'graph-route')
    }
    const resumesComposite = next.kind === 'capability' &&
      run.children.some((child) => child.nodeId === next.nodeId && child.compositeWait)
    if (!resumesComposite && run.decisions + (run.controlSteps ?? 0) >= run.config.maxSteps)
      throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'coordination')
    // ③：并行 fork——多个就绪 agent 节点（无循环、无 capability/human-task 混入）一次性
    // 并发分派（dispatch-many → assignmentWaves 按 maxParallelTasks 真并发），而非逐个串行。
    const readyDispatchable = graph.nodes.filter(
      (node) =>
        ready.includes(node.nodeId) &&
        // v2 循环体节点按轮次串行分派，不进入并行 dispatch-many 波次。
        !bodyOf.has(node.nodeId) &&
        (!dispatched.has(node.nodeId) ||
          loopNeedsAnotherIteration(node, facts, delivered, loopIterations))
    )
    const readyAgents = readyDispatchable.filter((node) => node.kind === 'agent' && !node.loop)
    if (
      readyAgents.length >= 2 &&
      readyAgents.length <= 4 &&
      readyAgents.every((node) => node.inputs?.overflow !== 'ask-human') &&
      readyAgents.length === readyDispatchable.length
    ) {
      const candidates = new Map<string, AgentTaskSnapshot>()
      const contextManifests = new Map<string, ContextManifest>()
      const envelopes = new Map<string, ExecutionEnvelope>()
      const assignments = readyAgents.map((node) => {
        if (node.inputs) {
          const manifest = buildContextManifest(node.nodeId, node.inputs, facts.deliveries)
          if (contextManifestBlocking(manifest))
            throw new AgentRuntimeError(
              manifest.budget.exceeded ? 'FLOW_CONTEXT_OVER_BUDGET' : 'FLOW_CONTEXT_REQUIRED_MISSING',
              'graph-context'
            )
          contextManifests.set(node.nodeId, manifest)
        }
        const candidate = this.specialists.describeAssignment(
          {
            ...routedInput,
            nodeId: node.nodeId,
            action: 'start',
            requestId: hash([
              run.taskId,
              node.nodeId,
              ...(run.reworkRound ? [run.reworkRound] : [])
            ])
          },
          true
        )
        candidates.set(node.nodeId, candidate)
        const envelope = composeExecutionEnvelope({
          stageGoal: node.goal,
          outputRequirements: node.completion
        })
        if (envelope) envelopes.set(node.nodeId, envelope)
        return {
          nodeId: node.nodeId,
          goal: node.goal,
          completion: node.completion,
          inputs: candidate.directInputs
        }
      })
      run.decisions++
      this.store.save(run)
      emitGatewayEvent(
        'agent.coordination.graph_dispatched',
        '按声明式图路由并发分派节点',
        {
          projectId: run.projectId,
          nodeId: run.nodeId,
          taskId: run.taskId,
          traceId: run.traceId,
          spanId: run.spanId
        },
        { attributes: { kind: 'parallel-fork', carrierNodeIds: readyAgents.map((n) => n.nodeId).join(',') } }
      )
      return this.dispatchDecision(
        run,
        { kind: 'dispatch-many', assignments },
        candidates,
        signal,
        contextManifests,
        envelopes,
        routedInputEdgeIds
      )
    }
    // ②：capability 图节点直接执行（复用 node.execute 账本端口），不经 agent 分派。
    if (next.kind === 'capability') {
      return this.dispatchCapability(run, routedInput, next, graph, facts, edgeState, loopIterations, signal)
    }
    // ②：human-task 图节点停等人工提交（C4 执行器），提交后续跑重新分派应用。
    if (next.kind === 'human-task') {
      return this.dispatchHumanTask(run, routedInput, next, graph, edgeState, signal)
    }
    let contextManifest: ContextManifest | undefined
    if (next.inputs) {
      contextManifest = buildContextManifest(next.nodeId, next.inputs, facts.deliveries, {
        humanMaterial: run.contextWaitStageKey === next.nodeId ? input.contextMaterial : undefined
      })
      if (next.inputs.overflow === 'ask-human' && contextManifest.budget.exceeded)
        return this.waitForContextBudget(run, contextManifest)
      if (contextManifestBlocking(contextManifest))
        throw new AgentRuntimeError(
          contextManifest.budget.exceeded ? 'FLOW_CONTEXT_OVER_BUDGET' : 'FLOW_CONTEXT_REQUIRED_MISSING',
          'graph-context'
        )
    }
    // O4-P4 / BL-11：v1 循环载体递增自身迭代；v2 子图循环体按载体轮次分派。
    if (next.loop && !next.loop.body) {
      loopIterations[next.nodeId] = (loopIterations[next.nodeId] ?? 0) + 1
      run.loopIterations = loopIterations
    } else if (next.loop?.body && (loopIterations[next.nodeId] ?? 0) === 0) {
      loopIterations[next.nodeId] = 1
      run.loopIterations = loopIterations
    }
    const nextBody = bodyOf.get(next.nodeId)
    const nextRound = nextBody ? (loopIterations[nextBody.carrierId] ?? 1) : undefined
    return this.dispatchRoutedAgent(run, routedInput, next, signal, contextManifest, {
      loopRound: nextRound ?? loopIterations[next.nodeId]
    })
  }

  private dispatchRoutedAgent(
    run: CoordinationRun,
    input: FlowAgentRun,
    next: Pick<FlowNode, 'nodeId' | 'goal' | 'completion'>,
    signal: AbortSignal,
    contextManifest: ContextManifest | undefined,
    options: { stageKey?: string; methodInstructions?: string; loopRound?: number }
  ): Promise<boolean> {
    if (run.contextWaitStageKey === (options.stageKey ?? next.nodeId)) {
      run.contextWaitStageKey = undefined
      run.contextWaitLimitBytes = undefined
    }
    const assignmentInput = { ...input }
    delete assignmentInput.contextMaterial
    const candidate = this.specialists.describeAssignment(
      {
        ...assignmentInput,
        nodeId: next.nodeId,
        action: 'start',
        requestId: hash([
          run.taskId,
          next.nodeId,
          ...(run.reworkRound ? [run.reworkRound] : []),
          ...(options.loopRound ? [`loop:${options.loopRound}`] : [])
        ])
      },
      true
    )
    const candidates = new Map<string, AgentTaskSnapshot>([[next.nodeId, candidate]])
    run.decisions++
    this.store.save(run)
    emitGatewayEvent(
      options.stageKey ? 'agent.coordination.stage_dispatched' : 'agent.coordination.graph_dispatched',
      options.stageKey ? '按声明顺序分派阶段' : '按声明式图路由分派节点',
      {
        projectId: run.projectId,
        nodeId: run.nodeId,
        taskId: run.taskId,
        traceId: run.traceId,
        spanId: run.spanId
      },
      {
        attributes: {
          ...(options.stageKey ? { stageKey: options.stageKey } : {}),
          carrierNodeId: next.nodeId,
          inputCount: candidate.directInputs.length
        }
      }
    )
    const envelope = composeExecutionEnvelope({
      stageGoal: next.goal,
      methodInstructions: options.methodInstructions,
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
      envelope ? new Map([[next.nodeId, envelope]]) : undefined,
      input.routedInputEdgeIds
    )
  }

  /**
   * ②：capability 图节点直接执行。按图数据边从已交付子节点输出编制固定输入，经
   * node.execute 同一账本端口执行（复用 renderer 执行器），回执 committed 才记交付。
   * 路由只认交付事实；不经 agent 分派、不调模型。
   * ⑥最小必要输入：声明 inputs 时按 ContextManifest 选择器裁剪——只喂选择器引用的上游源，
   * 校验预算/必需缺项（阻断不静默放行），manifest 记入子任务供追溯（与 agent 节点同口径）。
   */
  private async dispatchCapability(
    run: CoordinationRun,
    input: FlowAgentRun,
    next: FlowNode,
    graph: FlowGraph,
    facts: StageEntryFacts,
    edgeState: ReturnType<typeof flowRouteState>['edgeState'],
    loopIterations: Record<string, number>,
    signal: AbortSignal
  ): Promise<boolean> {
    const file = this.check(run)
    const node = file.nodes.find((item) => item.id === next.nodeId)
    if (!node) throw new AgentRuntimeError('FLOW_GRAPH_SCOPE_INVALID', 'graph-capability')
    const capabilityBody = [...loopBodyInfo(graph).values()].find((info) =>
      info.body.has(next.nodeId)
    )
    const capabilityRound = capabilityBody
      ? (loopIterations[capabilityBody.carrierId] ?? 1)
      : undefined
    const loopSuffix = capabilityRound ?? loopIterations[next.nodeId]
    const taskId = hash([
      run.taskId,
      next.nodeId,
      ...(run.reworkRound ? [run.reworkRound] : []),
      ...(loopSuffix ? [`loop:${loopSuffix}`] : [])
    ])
    const prior = run.children.find((item) => item.taskId === taskId)
    const waiting = node.type === 'composite'
      ? findCompositeCommandWait(this.db, run.projectId, taskId, next.nodeId)
      : undefined
    if (waiting && waiting.state !== 'satisfied' && prior) {
      prior.state = 'waiting'
      prior.compositeWait = { runId: waiting.runId, stepKey: waiting.stepKey }
      this.store.save(run)
      return this.wait(run, 'human.wait')
    }
    const resumeRequestId = waiting?.requestId ?? (prior?.compositeWait
      ? `${prior.compositeWait.runId}:${prior.compositeWait.stepKey}`
      : null)
    const commandId = `graph:${hash([taskId, 'capability', resumeRequestId])}`
    // ⑥最小必要输入：声明 inputs 时编制 manifest，校验预算/必需缺项，并据选择器筛选上游源。
    // BL-40：等待补料后的继续把人工精简材料作为文本输入注入；预算用替换清单重新校验。
    const material =
      run.contextWaitStageKey === next.nodeId && input.contextMaterial?.trim()
        ? input.contextMaterial.trim()
        : undefined
    let materialPortId: string | undefined
    let contextManifest: ContextManifest | undefined
    let selectedSources: Set<string> | undefined
    let materialIncoming: FlowGraph['edges'] | undefined
    const materialRefs = new Map<FlowGraph['edges'][number], AgentFlowAssetRef>()
    if (next.inputs) {
      const original = buildContextManifest(next.nodeId, next.inputs, facts.deliveries)
      contextManifest = original
      selectedSources = new Set(original.entries.map((entry) => entry.sourceStageKey))
      if (!material && next.inputs.overflow === 'ask-human' && original.budget.exceeded)
        return this.waitForContextBudget(run, original)
      if (original.missing.some((entry) => entry.required))
        throw new AgentRuntimeError('FLOW_CONTEXT_REQUIRED_MISSING', 'graph-context')
      if (!material && contextManifestBlocking(original))
        throw new AgentRuntimeError(
          original.budget.exceeded ? 'FLOW_CONTEXT_OVER_BUDGET' : 'FLOW_CONTEXT_REQUIRED_MISSING',
          'graph-context'
        )
      if (material) {
        // Original overflow may already have dropped optional candidates. Rebuild the
        // complete contribution universe before applying the confirmed replacement,
        // then re-apply the original budget to the exact effective set.
        const candidates = buildContextManifest(
          next.nodeId,
          next.inputs,
          facts.deliveries,
          { includeAllCandidates: true }
        )
        const candidateSources = new Set(candidates.entries.map((entry) => entry.sourceStageKey))
        const inputPorts = node.ports.filter((port) => port.dir === 'in')
        const selectedEdges = graph.edges.filter(
          (edge) =>
            edge.to.nodeId === next.nodeId &&
            edgeState(edge) === 'satisfied' &&
            candidateSources.has(edge.from.nodeId)
        )
        const portOf = (edge: FlowGraph['edges'][number]): PortDecl | undefined =>
          inputPorts.find((port) => port.id === edge.to.portId)
        const textPorts = [
          ...new Set(
            selectedEdges
              .filter((edge) => ['text', 'markdown'].includes(portOf(edge)?.type ?? ''))
              .map((edge) => edge.to.portId)
          )
        ]
        if (textPorts.length > 1)
          throw new AgentRuntimeError('FLOW_CONTEXT_MATERIAL_AMBIGUOUS', 'graph-context')
        if (textPorts.length === 1) materialPortId = textPorts[0]
        else {
          const anyPorts = [
            ...new Set(
              selectedEdges
                .filter((edge) => {
                  const port = portOf(edge)
                  return port?.type === 'any' && port.cardinality === 'one'
                })
                .map((edge) => edge.to.portId)
            )
          ]
          if (anyPorts.length !== 1)
            throw new AgentRuntimeError(
              anyPorts.length > 1
                ? 'FLOW_CONTEXT_MATERIAL_AMBIGUOUS'
                : 'FLOW_CONTEXT_MATERIAL_UNSUPPORTED',
              'graph-context'
            )
          materialPortId = anyPorts[0]
        }
        const plans: Array<{
          edge: FlowGraph['edges'][number]
          manifest: ContextManifest
        }> = []
        for (const edge of selectedEdges) {
          const upstream = run.children
            .filter((child) => child.nodeId === edge.from.nodeId && child.state === 'completed')
            .at(-1)
          if (!upstream) throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'graph-capability')
          const port = portOf(edge)
          if (!port) throw new AgentRuntimeError('AGENT_INPUT_TYPE_UNSUPPORTED', 'graph-capability')
          let ref = upstream.outputs.find(
            (output) =>
              output.sourceNodeId === edge.from.nodeId && output.sourcePortId === edge.from.portId
          )
          let value: FlowAssetValue
          if (ref) value = this.assets.resolveInputs(run.projectId, [ref])[0]!.value
          else {
            try {
              const version = this.assets.submit({
                projectId: run.projectId,
                nodeId: edge.from.nodeId,
                portId: edge.from.portId,
                submissionId: `cap-input:${hash([taskId, edge.from.nodeId, edge.from.portId, edge.to.portId])}`,
                expectedGraphVersion: file.meta.graphVersion,
                traceId: run.traceId,
                spanId: run.spanId
              })
              ref = version.ref
              value = version.value
            } catch (error) {
              if (
                port.required === false &&
                error instanceof FlowAssetError &&
                error.code === 'ASSET_OUTPUT_UNAVAILABLE'
              )
                continue
              throw error
            }
          }
          materialRefs.set(edge, ref)
          const sourceFact = facts.deliveries.find(
            (delivery) => delivery.stageKey === edge.from.nodeId
          )
          plans.push({
            edge,
            manifest: buildContextManifest(next.nodeId, next.inputs, [
              {
                stageKey: edge.from.nodeId,
                nodeId: edge.from.nodeId,
                outputs: [value],
                humanDecided: sourceFact?.humanDecided ?? false,
                ...(sourceFact?.handoffNote ? { handoffNote: sourceFact.handoffNote } : {})
              }
            ], { includeAllCandidates: true })
          })
        }
        const retainedPlans = plans.filter(
          (plan) => plan.edge.to.portId !== materialPortId && plan.manifest.entries.length > 0
        )
        // Preserve the exact per-edge values. assembleContextManifest performs the
        // only global dedupe, so a prior global projection cannot drop or swap them.
        const preserved = retainedPlans.flatMap((plan) => plan.manifest.entries)
        const replacement = buildContextManifest(next.nodeId, next.inputs, facts.deliveries, {
          humanMaterial: material
        })
        const human = replacement.entries.find((entry) => entry.sourceStageKey === 'human:context')
        if (!human) throw new AgentRuntimeError('FLOW_CONTEXT_MATERIAL_UNSUPPORTED', 'graph-context')
        const effective = assembleContextManifest(
          next.nodeId,
          original.budget.limitBytes,
          [...preserved, human],
          original.missing
        )
        const retainedOptionalDropped = effective.dropped.some((dropped) =>
          retainedPlans.some((plan) =>
            plan.manifest.entries.some(
              (entry) =>
                !entry.required &&
                entry.sourceStageKey === dropped.sourceStageKey &&
                entry.path === dropped.path
            )
          )
        )
        if (effective.budget.exceeded || retainedOptionalDropped)
          throw new AgentRuntimeError('FLOW_CONTEXT_OVER_BUDGET', 'graph-context')
        contextManifest = effective
        materialIncoming = retainedPlans.map((plan) => plan.edge)
      }
    }
    if (material && run.contextWaitStageKey === next.nodeId) {
      run.contextWaitStageKey = undefined
      run.contextWaitLimitBytes = undefined
    }
    const inputPorts = node.ports.filter((port) => port.dir === 'in')
    const incoming = materialIncoming ?? graph.edges.filter(
      (edge) =>
        edge.to.nodeId === next.nodeId &&
        edgeState(edge) === 'satisfied' &&
        (!selectedSources || selectedSources.has(edge.from.nodeId))
    )
    const inputsByPort = new Map<string, AgentFlowAssetRef[]>()
    for (const edge of incoming) {
      const upstream = run.children
        .filter((child) => child.nodeId === edge.from.nodeId && child.state === 'completed')
        .at(-1)
      if (!upstream) throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'graph-capability')
      // BL-11 / G8：按边声明的真实端口接线，不再按数组下标猜端口。
      const port = inputPorts.find((candidate) => candidate.id === edge.to.portId)
      if (!port) throw new AgentRuntimeError('AGENT_INPUT_TYPE_UNSUPPORTED', 'graph-capability')
      // 与 agent bind 的 freeze 同一机制：assets.submit 生成 sourceNodeId=上游节点的固定引用，
      // 与画布边 from 一致，账本输入源校验通过（raw 子任务 outputRefs 指向底层处理器，源不符）。
      let ref = materialRefs.get(edge) ?? upstream.outputs.find(
        (output) => output.sourceNodeId === edge.from.nodeId && output.sourcePortId === edge.from.portId
      )
      if (!ref) {
        try {
          ref = this.assets.submit({
            projectId: run.projectId,
            nodeId: edge.from.nodeId,
            portId: edge.from.portId,
            submissionId: `cap-input:${hash([taskId, edge.from.nodeId, edge.from.portId, edge.to.portId])}`,
            expectedGraphVersion: file.meta.graphVersion,
            traceId: run.traceId,
            spanId: run.spanId
          }).ref
        } catch (error) {
          const sourcePort = file.nodes.find((item) => item.id === edge.from.nodeId)
            ?.ports.find((item) => item.dir === 'out' && item.id === edge.from.portId)
          if (sourcePort?.required === false && error instanceof FlowAssetError &&
              error.code === 'ASSET_OUTPUT_UNAVAILABLE') continue
          throw error
        }
      }
      inputsByPort.set(port.id, [...(inputsByPort.get(port.id) ?? []), ref])
    }
    const inputs = [...inputsByPort].map(([targetPortId, assets]) => ({ targetPortId, assets }))
    const child: CoordinationRun['children'][number] = prior ?? {
      nodeId: next.nodeId,
      taskId,
      goal: next.goal,
      completion: next.completion,
      inputs: [],
      state: 'ready',
      outputs: [],
      ...(typeof capabilityRound === 'number' ? { round: capabilityRound } : {})
    }
    if (contextManifest) child.contextManifest = contextManifest
    if (!prior) {
      run.children.push(child)
      run.decisions++
    }
    this.store.save(run)
    const dispatchEventId = resumeRequestId ? `${commandId}:dispatch` : `${taskId}:dispatch`
    if (!this.store.hasEvent(run, dispatchEventId, 'agent.dispatched'))
      this.emitTrustedEvent(run, dispatchEventId, 'agent.dispatched', run.revision)
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
        parentCoordinatorTaskId: run.taskId,
        parentDeadlineAt: run.deadlineAt,
        ...(input.routedInputEdgeIds ? { routedInputEdgeIds: this.routedGraphCanvasEdgeIds(graph, file, edgeState, next.nodeId, incoming) } : {}),
        contractVersion: node.contractVersion,
        inputs,
        ...(material && materialPortId
          ? { contextMaterial: { targetPortId: materialPortId, text: material } }
          : {}),
        expectedSemanticRevision: projectSemanticRevision(file),
        traceId: run.traceId,
        spanId: run.spanId
      },
      signal
    )
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
      return false
    if (receipt.state === 'skipped' && node.type === 'composite') {
      const pending = findCompositeCommandWait(this.db, run.projectId, taskId, next.nodeId)
      if (pending) {
        child.state = 'waiting'
        child.compositeWait = { runId: pending.runId, stepKey: pending.stepKey }
        this.store.save(run)
        return this.wait(run, 'human.wait')
      }
    }
    delete child.compositeWait
    if (receipt.state === 'skipped' && receipt.code === 'FLOW_EXECUTION_SKIPPED') {
      child.state = 'skipped'
      this.store.save(run)
      return true
    }
    if (receipt.state !== 'committed') {
      child.state = 'blocked'
      this.store.save(run)
      throw new AgentRuntimeError(receipt.code ?? 'FLOW_CHILD_BLOCKED', 'graph-capability')
    }
    child.outputs = receipt.outputRefs
    // BL-21：AI 产出、人采用——交付先挂起，人工在总览「继续」后放行下游。
    if (resolveFlowNodeDimensions(next).decider === 'human') {
      child.state = 'waiting'
      child.adoptionPending = true
      run.code = 'HUMAN_ADOPTION_REQUIRED'
      this.store.save(run)
      return this.wait(run, 'human.wait')
    }
    child.state = 'completed'
    this.store.save(run)
    this.emitTrustedEvent(run, `${taskId}:completed`, 'agent.completed', run.revision)
    return true
  }

  /**
   * ②：human-task 图节点停等人工提交。经 node.execute 同一账本端口触发 C4 执行器：
   * 无待提交→skipped（停等，不伪造成功）；人工经 humanTask.submit 写 pending 后续跑重新
   * 分派（新 commandId）→执行器应用提交→committed 投影交付。路由只认交付事实。
   */
  private async dispatchHumanTask(
    run: CoordinationRun,
    input: FlowAgentRun,
    next: FlowNode,
    graph: FlowGraph,
    edgeState: ReturnType<typeof flowRouteState>['edgeState'],
    signal: AbortSignal
  ): Promise<boolean> {
    const file = this.check(run)
    const node = file.nodes.find((item) => item.id === next.nodeId)
    if (!node) throw new AgentRuntimeError('FLOW_GRAPH_SCOPE_INVALID', 'graph-human-task')
    const humanBody = [...loopBodyInfo(graph).values()].find((info) =>
      info.body.has(next.nodeId)
    )
    const humanRound = humanBody ? (run.loopIterations?.[humanBody.carrierId] ?? 1) : undefined
    const taskId = hash([
      run.taskId,
      next.nodeId,
      ...(run.reworkRound ? [run.reworkRound] : []),
      ...(humanRound ? [`loop:${humanRound}`] : [])
    ])
    // 每次分派用新 commandId：上一轮 skipped 已终态释放占用，续跑重新交付执行以应用人工提交。
    const commandId = `graph:${hash([taskId, 'human', run.decisions])}`
    const inputPorts = node.ports.filter((port) => port.dir === 'in')
    const incoming = graph.edges.filter(
      (edge) => edge.to.nodeId === next.nodeId && edgeState(edge) === 'satisfied'
    )
    const inputs = incoming.map((edge) => {
      const upstream = run.children
        .filter((child) => child.nodeId === edge.from.nodeId && child.state === 'completed')
        .at(-1)
      if (!upstream) throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'graph-human-task')
      // BL-11 / G8：按边声明的真实端口接线。
      const port = inputPorts.find((candidate) => candidate.id === edge.to.portId)
      if (!port) throw new AgentRuntimeError('AGENT_INPUT_TYPE_UNSUPPORTED', 'graph-human-task')
      const { ref } = this.assets.submit({
        projectId: run.projectId,
        nodeId: edge.from.nodeId,
        portId: edge.from.portId,
        submissionId: `${taskId}:human-input:${edge.to.portId}:${run.decisions}`,
        expectedGraphVersion: file.meta.graphVersion,
        traceId: run.traceId,
        spanId: run.spanId
      })
      return { targetPortId: port.id, assets: [ref] }
    })
    let child = run.children.find(
      (item) =>
        item.nodeId === next.nodeId &&
        (humanRound === undefined || (item.round ?? 1) === humanRound)
    )
    if (!child) {
      child = {
        nodeId: next.nodeId,
        taskId,
        goal: next.goal,
        completion: next.completion,
        inputs: [],
        state: 'ready',
        outputs: [],
        ...(typeof humanRound === 'number' ? { round: humanRound } : {})
      }
      run.children.push(child)
    }
    run.decisions++
    this.store.save(run)
    this.emitTrustedEvent(run, `${taskId}:dispatch:${run.decisions}`, 'agent.dispatched', run.revision)
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
      { attributes: { carrierNodeId: next.nodeId, kind: 'human-task', inputCount: inputs.length } }
    )
    let receipt
    try {
      receipt = await this.specialists.executeNodeCommand(
        {
          schemaVersion: 1,
          kind: 'node.execute',
          commandId,
          projectId: run.projectId,
          taskId,
          agentNodeId: run.nodeId,
          scopedHumanTask: true,
          parentCoordinatorTaskId: run.taskId,
          parentDeadlineAt: run.deadlineAt,
          ...(input.routedInputEdgeIds ? { routedInputEdgeIds: this.routedGraphCanvasEdgeIds(graph, file, edgeState, next.nodeId) } : {}),
          targetNodeId: next.nodeId,
          contractVersion: node.contractVersion,
          inputs,
          expectedSemanticRevision: projectSemanticRevision(file),
          traceId: run.traceId,
          spanId: run.spanId
        },
        signal
      )
    } catch (error) {
      if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled') {
        child.state = 'cancelled'
        this.store.save(run)
        return false
      }
      child.state = 'blocked'
      this.store.save(run)
      throw new AgentRuntimeError(
        error instanceof Error ? error.message : 'FLOW_CHILD_BLOCKED',
        'graph-human-task'
      )
    }
    if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
      return false
    if (receipt.state === 'committed') {
      child.state = 'completed'
      child.outputs = receipt.outputRefs
      child.handoffNote = receipt.handoffNote
      this.store.save(run)
      this.emitTrustedEvent(run, `${taskId}:completed`, 'agent.completed', run.revision)
      return true
    }
    if (receipt.state === 'skipped' && receipt.code === 'FLOW_EXECUTION_SKIPPED') {
      child.state = 'waiting'
      this.store.save(run)
      return this.wait(run, 'human.wait')
    }
    if (receipt.state === 'cancelled') {
      child.state = 'cancelled'
      this.store.save(run)
      if (signal.aborted || this.store.latest(run.projectId, run.nodeId)!.state === 'cancelled')
        return false
      throw new AgentRuntimeError(receipt.code ?? 'AGENT_CANCELLED', 'graph-human-task')
    }
    child.state = receipt.state === 'failed' ? 'failed' : 'blocked'
    this.store.save(run)
    throw new AgentRuntimeError(
      receipt.state === 'pending' || receipt.state === 'unknown'
        ? 'FLOW_COMMAND_OUTCOME_UNKNOWN'
        : receipt.code ?? 'FLOW_CHILD_BLOCKED',
      'graph-human-task'
    )
  }

  /**
   * BL-11 / AF-8.4b：v2 循环体的「当前轮次交付」。
   * body 内节点只认本轮的 completed 子任务；上一轮历史不参与本轮路由。
   */
  private roundScopedDelivered(
    run: CoordinationRun,
    bodies: Map<string, LoopBodyInfo>,
    loopIterations: Record<string, number>
  ): Set<string> {
    const carrierOf = new Map<string, string>()
    for (const [carrierId, info] of bodies)
      for (const id of info.body) carrierOf.set(id, carrierId)
    const delivered = new Set<string>()
    for (const child of run.children) {
      if (child.state !== 'completed') continue
      const carrier = carrierOf.get(child.nodeId)
      if (!carrier) {
        delivered.add(child.nodeId)
        continue
      }
      if ((child.round ?? 1) === (loopIterations[carrier] ?? 1)) delivered.add(child.nodeId)
    }
    return delivered
  }

  /**
   * 一轮结束（body 出口全部交付）后评估退出条件：不满足且未达上限则开下一轮。
   * 退出条件仍只读交付事实；达到上限时由 settledNodes 强制落定。
   */
  private advanceLoopRounds(
    run: CoordinationRun,
    graph: FlowGraph,
    facts: StageEntryFacts,
    delivered: ReadonlySet<string>,
    bodies: Map<string, LoopBodyInfo>,
    loopIterations: Record<string, number>
  ): boolean {
    let changed = false
    for (const [carrierId, info] of bodies) {
      const round = loopIterations[carrierId] ?? 0
      if (round < 1) continue
      const carrier = graph.nodes.find((node) => node.nodeId === carrierId)
      if (!carrier?.loop) continue
      if (![...info.exits].every((nodeId) => delivered.has(nodeId))) continue
      if (loopExitConditionSatisfied(carrier, facts)) continue
      if (round >= carrier.loop.maxIterations) continue
      loopIterations[carrierId] = round + 1
      run.loopIterations = loopIterations
      changed = true
    }
    if (changed) this.store.save(run)
    return changed
  }

  /** O4-P3/P4：图模式交付事实——stageKey 即节点 id；循环节点取最近一次迭代交付。只读权威资产与续接记录。 */
  private graphFacts(
    run: CoordinationRun,
    scope?: { bodies: Map<string, LoopBodyInfo>; loopIterations: Record<string, number> }
  ): StageEntryFacts {
    const carrierOf = new Map<string, string>()
    if (scope)
      for (const [carrierId, info] of scope.bodies)
        for (const id of info.body) carrierOf.set(id, carrierId)
    const latestByNode = new Map<string, (typeof run.children)[number]>()
    for (const child of run.children) {
      if (child.state !== 'completed') continue
      const carrier = carrierOf.get(child.nodeId)
      if (
        carrier &&
        (child.round ?? 1) !== (scope!.loopIterations[carrier] ?? 1)
      )
        continue
      latestByNode.set(child.nodeId, child)
    }
    const deliveries: StageDeliveryFact[] = []
    const graphNodes = run.config.graph?.nodes ?? []
    for (const child of latestByNode.values()) {
      const versions = this.assets.resolveInputs(run.projectId, child.outputs)
      // Agent 查询 specialist 的人工续接；capability 读取 BL-21 采用时持久化的决定事实。
      const isAgent = graphNodes.find((node) => node.nodeId === child.nodeId)?.kind === 'agent'
      deliveries.push({
        stageKey: child.nodeId,
        nodeId: child.nodeId,
        outputs: versions.map((version) => version.value),
        handoffNote: isAgent
          ? this.specialists.deliveryHandoff(run.projectId, child.nodeId, child.taskId)
          : child.handoffNote,
        humanDecided: isAgent
          ? this.specialists.humanDecision(
              { projectId: run.projectId, nodeId: child.nodeId },
              run.taskId,
              child.taskId
            )
          : child.humanDecided === true
      })
    }
    // ⑥审核门禁：审核通过即视为该审核节点"已交付"（交付物=被审核通过的固定版本资产），
    // 下游受控节点据此放行；驳回/待审不交付，下游边不触发。返工由 reviews.step 控制。
    for (const review of run.reviews ?? []) {
      if (review.state !== 'passed' || !review.decision) continue
      const versions = this.assets.resolveInputs(run.projectId, review.decision.subjects)
      deliveries.push({
        stageKey: review.nodeId,
        nodeId: review.nodeId,
        outputs: versions.map((version) => version.value),
        humanDecided: false
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
        handoffNote: this.specialists.deliveryHandoff(run.projectId, child.nodeId, child.taskId),
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
    const stageByNode = new Map(
      (run.config.executionMode === 'graph'
        ? (run.config.graph?.nodes ?? []).map((node) => ({ nodeId: node.nodeId, stageKey: node.nodeId }))
        : run.config.stages ?? []
      ).map((stage) => [stage.nodeId, stage])
    )
    const records = run.stageDeliveries ?? []
    const reviewsPassed = !(run.reviews ?? []).some((review) => review.state !== 'passed')
    for (const child of run.children) {
      const stage = stageByNode.get(child.nodeId)
      if (!stage || child.state !== 'completed' || !child.outputs.length) continue
      if (records.some((record) => record.taskId === child.taskId && !record.stale)) continue
      const isAgent =
        run.config.executionMode !== 'graph' ||
        run.config.graph?.nodes.some(
          (node) => node.nodeId === child.nodeId && node.kind === 'agent'
        ) === true
      records.push(
        StageDeliveryRecordSchema.parse({
          schemaVersion: 1,
          stageKey: stage.stageKey,
          nodeId: child.nodeId,
          taskId: child.taskId,
          outputRefs: child.outputs,
          handoffNote:
            child.handoffNote ??
            (isAgent
              ? this.specialists.deliveryHandoff(run.projectId, child.nodeId, child.taskId)
              : undefined),
          ...(child.contextManifest
            ? { contextManifestHash: child.contextManifest.manifestHash }
            : {}),
          ...(child.executionEnvelope
            ? { envelopeHash: `sha256:${hash(child.executionEnvelope)}` }
            : {}),
          humanDecided: isAgent
            ? this.specialists.humanDecision(
                { projectId: run.projectId, nodeId: child.nodeId },
                run.taskId,
                child.taskId
              )
            : child.humanDecided === true,
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
   * C 组：返工影响预览（只读）。列出将作废的交付/子任务与保留项，供 GUI 确认弹窗
   * 与 CLI/MCP 预检使用；不修改运行事实、不占占用、不重发命令。
   */
  private reworkTargets(
    run: CoordinationRun,
    stageKey: string
  ): { index: number; affected: FlowStageReworkImpact['willRerunStages'] } | null {
    if (run.config.executionMode === 'fixed-order' && run.config.stages) {
      const index = run.config.stages.findIndex((stage) => stage.stageKey === stageKey)
      if (index < 0) throw new AgentRuntimeError('FLOW_STAGE_MISSING', 'rework-preview')
      return { index, affected: run.config.stages.slice(index) }
    }
    if (run.config.executionMode !== 'graph' || !run.config.graph) return null
    const graph = run.config.graph
    const index = graph.nodes.findIndex((node) => node.nodeId === stageKey)
    if (index < 0) throw new AgentRuntimeError('FLOW_STAGE_MISSING', 'rework-preview')
    const file = this.check(run)
    const dependencies: Array<[string, string]> = []
    for (const review of run.reviews ?? []) {
      const config = ReviewNodeConfigSchema.parse(JSON.parse(shape(file, review.nodeId).props.config))
      if (review.responsibleNodeId) dependencies.push([review.responsibleNodeId, review.nodeId])
      for (const source of config.subjectSources) dependencies.push([source.nodeId, review.nodeId])
      for (const nodeId of config.gatedNodeIds) dependencies.push([review.nodeId, nodeId])
    }
    const affected = graphReworkNodes(graph, stageKey, dependencies)
    return {
      index,
      affected: graph.nodes.filter((node) => affected.has(node.nodeId))
        .map((node) => ({ stageKey: node.nodeId, nodeId: node.nodeId }))
    }
  }

  previewStageRework(input: Identity, stageKey: string): FlowStageReworkImpact | null {
    const run = this.store.latest(input.projectId, input.nodeId)
    if (!run) return null
    const targets = this.reworkTargets(run, stageKey)
    if (!targets) return null
    const { index, affected } = targets
    if (run.config.executionMode === 'graph') this.recordStageDeliveries(run)
    const affectedNodes = new Set(affected.map((stage) => stage.nodeId))
    const staleDeliveries = (run.stageDeliveries ?? [])
      .filter((record) => affectedNodes.has(record.nodeId))
      .map((record) => ({
        stageKey: record.stageKey,
        nodeId: record.nodeId,
        acceptedAt: record.acceptedAt,
        outputCount: record.outputRefs.length
      }))
    const keptDeliveries = (run.stageDeliveries ?? []).filter(
      (record) => !affectedNodes.has(record.nodeId)
    ).length
    const activeChildCount = run.children.filter(
      (child) =>
        affectedNodes.has(child.nodeId) &&
        !['completed', 'failed', 'cancelled', 'skipped'].includes(child.state)
    ).length
    const unresolved = this.db
      .prepare(
        "SELECT 1 FROM flow_commands WHERE project_id=? AND task_id=? AND state IN ('pending','unknown') LIMIT 1"
      )
      .get(run.projectId, run.taskId) || run.children.some((child) => this.db.prepare(
      "SELECT 1 FROM flow_commands WHERE project_id=? AND task_id=? AND state IN ('pending','unknown') LIMIT 1"
    ).get(run.projectId, child.taskId))
    const blockedReason = this.active.has(run.taskId)
      ? 'AGENT_TASK_BUSY'
      : !['completed', 'waiting', 'blocked'].includes(run.state)
        ? 'FLOW_STAGE_REWORK_BUSY'
        : (run.reworkRound ?? 0) >= 10
          ? 'FLOW_REWORK_BUDGET_EXHAUSTED'
          : unresolved
            ? 'FLOW_COMMAND_OUTCOME_UNKNOWN'
            : activeChildCount > 0
              ? 'FLOW_STAGE_REWORK_ACTIVE_CHILD'
              : undefined
    return {
      stageKey,
      stageIndex: index + 1,
      round: run.reworkRound ?? 0,
      nextRound: (run.reworkRound ?? 0) + 1,
      maxRounds: 10,
      willRerunStages: affected.map((stage) => ({ stageKey: stage.stageKey, nodeId: stage.nodeId })),
      staleDeliveries,
      keptDeliveries,
      activeChildCount,
      canRework: !blockedReason,
      ...(blockedReason ? { blockedReason } : {})
    }
  }

  /**
   * AF-05：局部返工——从指定阶段起重跑，仅影响该阶段及其下游；上游已完成阶段不重跑。
   * 旧交付移入 reworkHistory（不改写），下游交付标 stale；子任务身份用新轮次派生。
   * 有界：返工轮次上限 10；unknown/pending 命令未结算时拒绝（不盲目重发）。
   */
  reworkStage(input: Identity, stageKey: string): FlowAgentView {
    const run = this.store.latest(input.projectId, input.nodeId)
    const impact = this.previewStageRework(input, stageKey)
    if (!run || !impact)
      throw new AgentRuntimeError('FLOW_STAGE_REWORK_UNSUPPORTED', 'rework')
    if (!impact.canRework)
      throw new AgentRuntimeError(impact.blockedReason ?? 'FLOW_STAGE_REWORK_BUSY', 'rework')
    this.check(run)
    if (run.config.executionMode === 'graph') this.recordStageDeliveries(run)
    const affected = new Set(impact.willRerunStages.map((stage) => stage.nodeId))
    const history = run.reworkHistory ?? []
    const kept: CoordinationRun['stageDeliveries'] = []
    for (const record of run.stageDeliveries ?? []) {
      if (affected.has(record.nodeId)) history.push({ ...record, stale: true })
      else kept.push(record)
    }
    const invalidatedWaits = run.children.flatMap((child) =>
      affected.has(child.nodeId) && child.compositeWait ? [child.compositeWait.runId] : []
    )
    // 移除受影响阶段的子任务（上游保留）；旧 specialist 任务作为历史保留在任务表。
    run.children = run.children.filter((child) => !affected.has(child.nodeId))
    run.stageDeliveries = kept
    run.reworkHistory = history
    run.reworkRound = (run.reworkRound ?? 0) + 1
    run.skippedNodeIds = undefined
    run.stalledNodeIds = undefined
    if (run.config.executionMode === 'graph') {
      for (const nodeId of affected) delete run.loopIterations?.[nodeId]
      run.reviews = run.reviews?.map((review) => affected.has(review.nodeId)
        ? {
            nodeId: review.nodeId,
            responsibleNodeId: review.responsibleNodeId,
            requestId: hash([run.taskId, review.nodeId, run.reworkRound, 0]),
            state: 'ready',
            round: 0
          }
        : review)
      run.decisions = 0
      run.controlSteps = 0
    }
    run.outputs = []
    run.code = undefined
    run.decisionPending = false
    run.state = 'waiting'
    run.waitRevision++
    this.db.transaction(() => {
      this.store.reoccupy(run, run.scopeIds)
      for (const childRunId of invalidatedWaits) {
        this.db.prepare(
          "UPDATE composite_run_waits SET state='cancelled' WHERE run_id=? AND state='open'"
        ).run(childRunId)
        this.db.prepare(
          "UPDATE composite_runs SET status='cancelled', finished_at=? WHERE id=? AND project_id=? AND status='waiting-input'"
        ).run(Date.now(), childRunId, run.projectId)
      }
      this.emitTrustedEvent(run, `${run.taskId}:rework:${run.reworkRound}`, 'flow.rework', run.revision)
    })()
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
    const terminalOnEntry = terminal(run)
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
      if (terminal(run) || run.state === 'waiting') {
        if (terminal(run)) this.store.release(run)
        return this.reply(run)
      }
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
        const graphKind = run.config.graph?.nodes.find((node) => node.nodeId === child.nodeId)?.kind
        if (graphKind && graphKind !== 'agent') {
          const committedRow = this.db.prepare(
            "SELECT receipt_json FROM flow_commands WHERE project_id=? AND task_id=? AND state='committed'"
          ).get(run.projectId, child.taskId) as { receipt_json: string } | undefined
          const committed = committedRow
            ? canonicalFlowJson(JSON.parse(committedRow.receipt_json).outputRefs) ===
              canonicalFlowJson(child.outputs)
            : false
          if (['ready', 'queued'].includes(child.state)) {
            observed = true
            continue
          }
          if (child.state === 'completed') {
            if (committed) {
              this.assets.resolveInputs(run.projectId, child.outputs)
              observed = true
            } else reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
            continue
          }
          if (child.state === 'waiting') {
            if (child.adoptionPending) {
              if (committed) observed = true
              else reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
            } else if (child.compositeWait) {
              const waiting = findCompositeCommandWait(
                this.db, run.projectId, child.taskId, child.nodeId
              )
              if (
                waiting &&
                waiting.runId === child.compositeWait.runId &&
                waiting.stepKey === child.compositeWait.stepKey &&
                ['open', 'satisfied'].includes(waiting.state)
              )
                observed = true
              else reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
            } else if (graphKind === 'human-task') {
              const skipped = this.db.prepare(
                "SELECT 1 FROM flow_commands WHERE project_id=? AND task_id=? AND state='skipped' AND json_extract(receipt_json,'$.code')='FLOW_EXECUTION_SKIPPED'"
              ).get(run.projectId, child.taskId)
              if (skipped) observed = true
              else reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
            } else reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
            continue
          }
          reasons.push('FLOW_TASK_CHECKPOINT_UNCONFIRMED')
          continue
        }
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
            run.reviews?.some((review) => review.state !== 'passed') ||
            run.outputs.some((ref) => !allowed.has(canonicalFlowJson(ref)))
          )
            throw new AgentRuntimeError('AGENT_OUTPUT_UNVERIFIED', 'recovery')
          this.assertChildrenComplete(run)
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
        run.code = run.children.some((child) => child.adoptionPending)
          ? 'HUMAN_ADOPTION_REQUIRED'
          : undefined
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
        this.emitCoordinationTerminal(current, 'cancelled', context, {
          phase: input.action,
          code: 'AGENT_CANCELLED'
        })
        return this.reply(current)
      }
      if (!current || !terminal(current)) {
        run.state = 'blocked'
        run.code = error instanceof AgentRuntimeError ? error.code : 'FLOW_RECOVERY_FAILED'
        run.recovery = { reasons: [run.code], canRestore: false }
        this.store.save(run)
      }
      this.emitCoordinationTerminal(run, 'failed', context, {
        phase: input.action,
        code: error instanceof AgentRuntimeError ? error.code : 'FLOW_RECOVERY_FAILED'
      })
      throw error
    } finally {
      this.active.delete(run.taskId)
      this.terminalEvents.delete(run.taskId)
      if (!failed && !terminalOnEntry) {
        const current = this.store.latest(run.projectId, run.nodeId) ?? run
        this.emitCoordinationTerminal(
          current,
          current.state === 'cancelled' ? 'cancelled' : current.state === 'failed' ? 'failed' : 'completed',
          context,
          { phase: input.action, code: current.code }
        )
      }
    }
  }
  private waitForContextBudget(run: CoordinationRun, manifest: ContextManifest): false {
    run.code = 'FLOW_CONTEXT_OVER_BUDGET'
    run.contextWaitStageKey = manifest.stageKey
    run.contextWaitLimitBytes = manifest.budget.limitBytes
    emitGatewayEvent('agent.coordination.stage_context_blocked', '阶段输入超限，等待人工处理', {
      projectId: run.projectId, nodeId: run.nodeId, taskId: run.taskId,
      traceId: run.traceId, spanId: run.spanId
    }, { status: 'skipped', attributes: { stageKey: manifest.stageKey, code: 'CONTEXT_OVER_BUDGET' } })
    return this.wait(run, 'human.wait')
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
