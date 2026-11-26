import type Database from 'better-sqlite3'
import type { ProjectFile } from '../../shared/types'
import { graphCanvasVersion } from './graph-canvas-version'
import type {
  AgentNodeConfigSchema,
  StateMachineNodeConfigSchema
} from '../../shared/agent-flow/node-contracts'
import type { z } from 'zod'
import type { FlowAgentReply, FlowAgentView } from '../../shared/agent-flow/desktop-tasks'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import type { ReviewDecision } from '../../shared/agent-flow/node-contracts'
import type { FlowRunOverview, FlowEventActorSource } from '../../shared/agent-flow/run-overview'

export interface CoordinationReview {
  nodeId: string
  requestId: string
  state: 'ready' | 'pending' | 'passed' | 'rejected' | 'human-wait' | 'manual-wait'
  round: number
  decision?: ReviewDecision
  originalInputs?: FlowAgentReply['refs']
  reworkTaskId?: string
  responsibleNodeId?: string
  manualDefinition?: { text: unknown; content: unknown }
}

export interface CoordinationRun {
  projectId: string
  nodeId: string
  taskId: string
  goal: string
  config: z.infer<typeof AgentNodeConfigSchema>
  stateNodeId: string
  stateConfig: z.infer<typeof StateMachineNodeConfigSchema>
  scopeIds: string[]
  scopeRevision: string
  sourceGraph?: FlowRunOverview['sourceGraph']
  childIds: string[]
  state: FlowAgentView['state']
  phase: string
  revision: number
  waitRevision: number
  decisions: number
  paused: boolean
  code?: string
  contextWaitStageKey?: string
  contextWaitLimitBytes?: number
  traceId: string
  spanId: string
  /** AF-06: one absolute active deadline for the whole coordinator run (optional for legacy rows). */
  startedAt?: number
  deadlineAt?: number
  children: Array<{
    nodeId: string
    taskId: string
    goal: string
    completion: string
    inputs: FlowAgentReply['refs']
    state: string
    handoffNote?: string
    outputs: FlowAgentReply['refs']
    /** BL-11：v2 子图循环体的轮次（缺省=1；非循环节点不写）。 */
    compositeWait?: { runId: string; stepKey: string }
    /** BL-21：capability 的「AI 产出、人采用」——交付已生成、等待人工采用。 */
    adoptionPending?: boolean
    round?: number
    contextManifest?: import('../../shared/agent-flow/stage-contracts').ContextManifest
    executionEnvelope?: import('../../shared/agent-flow/execution-envelope').ExecutionEnvelope
    routedInputEdgeIds?: string[]
  }>
  outputs: FlowAgentReply['refs']
  reviews?: CoordinationReview[]
  controlSteps?: number
  skippedNodeIds?: string[]
  stalledNodeIds?: string[]
  decisionPending?: boolean
  recovery?: { reasons: string[]; canRestore: boolean }
  /** AF-05：阶段交付验收记录（按阶段身份索引；返工后下游标 stale）。 */
  stageDeliveries?: import('../../shared/agent-flow/stage-contracts').StageDeliveryRecord[]
  /** AF-05：局部返工轮次（用于派生新子任务身份，旧历史不改写）。 */
  reworkRound?: number
  /** AF-05：返工保留的旧交付历史（只读事实）。 */
  reworkHistory?: import('../../shared/agent-flow/stage-contracts').StageDeliveryRecord[]
  /** O4-P4：图模式循环节点迭代计数（nodeId → 已分派次数）。 */
  loopIterations?: Record<string, number>
}

/** A public review executor may join an occupied scope only for the persisted pending request. */
export function controlledReview(
  db: Database.Database,
  projectId: string,
  nodeId: string,
  requestId: string
): boolean {
  const owner = new CoordinationStore(db).owner(projectId, nodeId)
  if (!owner) return false
  const row = db
    .prepare('SELECT body_json FROM flow_coordination_runs WHERE project_id=? AND task_id=?')
    .get(projectId, owner) as { body_json: string } | undefined
  if (!row) return false
  const run = JSON.parse(row.body_json) as CoordinationRun
  return (
    run.state === 'running' &&
    !!run.reviews?.some(
      (review) =>
        review.nodeId === nodeId && review.requestId === requestId && review.state === 'pending'
    )
  )
}

/** The canvas remains the editable definition; this store contains execution facts only. */
export class CoordinationStore {
  constructor(private readonly db: Database.Database) {}
  latest(projectId: string, nodeId: string): CoordinationRun | null {
    const row = this.db
      .prepare(
        `SELECT body_json FROM flow_coordination_runs WHERE project_id=? AND (node_id=? OR json_extract(body_json,'$.stateNodeId')=?) ORDER BY rowid DESC LIMIT 1`
      )
      .get(projectId, nodeId, nodeId) as { body_json: string } | undefined
    return row ? JSON.parse(row.body_json) : null
  }
  save(run: CoordinationRun, preservePause = true): void {
    const current = this.latest(run.projectId, run.nodeId)
    if (current?.taskId === run.taskId) {
      if (current.state === 'cancelled' && run.state !== 'cancelled')
        throw new AgentRuntimeError('AGENT_CANCELLED', 'coordination')
      if (preservePause && current.paused) run.paused = true
    }
    if (Buffer.byteLength(JSON.stringify(run)) > 262144)
      throw new AgentRuntimeError('AGENT_CONTEXT_TOO_LARGE', 'coordination')
    this.db
      .prepare('UPDATE flow_coordination_runs SET body_json=? WHERE project_id=? AND task_id=?')
      .run(JSON.stringify(run), run.projectId, run.taskId)
  }
  create(run: CoordinationRun, occupied: string[]): void {
    this.db.transaction(() => {
      if (
        occupied.some((id) =>
          this.db
            .prepare('SELECT 1 FROM flow_coordination_scope WHERE project_id=? AND node_id=?')
            .get(run.projectId, id)
        )
      )
        throw new AgentRuntimeError('FLOW_CONTROL_OCCUPIED', 'scope')
      this.db
        .prepare('INSERT INTO flow_coordination_runs VALUES (?,?,?,?)')
        .run(run.projectId, run.nodeId, run.taskId, JSON.stringify(run))
      for (const id of occupied)
        this.db
          .prepare('INSERT INTO flow_coordination_scope VALUES (?,?,?)')
          .run(run.projectId, id, run.taskId)
    })()
  }
  owner(projectId: string, nodeId: string): string | null {
    const row = this.db
      .prepare('SELECT task_id FROM flow_coordination_scope WHERE project_id=? AND node_id=?')
      .get(projectId, nodeId) as { task_id: string } | undefined
    return row?.task_id ?? null
  }
  release(run: CoordinationRun): void {
    this.db
      .prepare('DELETE FROM flow_coordination_scope WHERE project_id=? AND task_id=?')
      .run(run.projectId, run.taskId)
  }
  /** AF-05：返工后重新占用控制范围（完成时曾 release）；幂等。 */
  reoccupy(run: CoordinationRun, occupied: string[]): void {
    this.db.transaction(() => {
      for (const id of occupied) {
        const owner = this.owner(run.projectId, id)
        if (owner && owner !== run.taskId)
          throw new AgentRuntimeError('FLOW_CONTROL_OCCUPIED', 'rework')
        if (!owner)
          this.db.prepare('INSERT INTO flow_coordination_scope VALUES (?,?,?)')
            .run(run.projectId, id, run.taskId)
      }
    })()
  }
  hasEvent(run: CoordinationRun, eventId: string, event: string): boolean {
    const row = this.db
      .prepare(
        'SELECT signature FROM flow_coordination_events WHERE project_id=? AND task_id=? AND event_id=?'
      )
      .get(run.projectId, run.taskId, eventId) as { signature: string } | undefined
    return !!row && JSON.parse(row.signature).event === event
  }
  continuation(
    run: CoordinationRun,
    eventId: string,
    waitRevision: number
  ): 'new' | 'replay' | 'conflict' {
    const row = this.db.prepare(
      'SELECT signature FROM flow_coordination_events WHERE project_id=? AND task_id=? AND event_id=?'
    ).get(run.projectId, run.taskId, eventId) as { signature: string } | undefined
    if (!row) return 'new'
    const stored = JSON.parse(row.signature) as { event?: string; waitRevision?: number }
    return stored.event === 'human.continue' && stored.waitRevision === waitRevision ? 'replay' : 'conflict'
  }
  event(
    run: CoordinationRun,
    eventId: string,
    event: string,
    expectedRevision: number,
    actorSource?: FlowEventActorSource,
    resumeRevision?: number
  ): void {
    const legacySignature = canonicalFlowJson({ event, expectedRevision })
    const signature = canonicalFlowJson({ event, expectedRevision, actorSource, waitRevision: resumeRevision })
    this.db.transaction(() => {
      const prior = this.db
        .prepare(
          'SELECT signature FROM flow_coordination_events WHERE project_id=? AND task_id=? AND event_id=?'
        )
        .get(run.projectId, run.taskId, eventId) as { signature: string } | undefined
      if (prior) {
        if (prior.signature !== signature && prior.signature !== legacySignature)
          throw new AgentRuntimeError('FLOW_STATE_EVENT_CONFLICT', 'state')
        return
      }
      const stored = this.latest(run.projectId, run.nodeId)
      if (!stored || stored.taskId !== run.taskId || stored.revision !== expectedRevision)
        throw new AgentRuntimeError('FLOW_STATE_REVISION_CONFLICT', 'state')
      const next = run.stateConfig.transitions.find(
        (t) => t.from === run.phase && t.event === event
      )
      const graphReworkPhase = event === 'flow.rework' && run.config.executionMode === 'graph'
        ? run.stateConfig.transitions.find((transition) => transition.event === 'flow.rework')?.to ??
          run.stateConfig.transitions.find((transition) => transition.event === 'human.continue')?.from
        : undefined
      const phase = next?.to ?? graphReworkPhase
      if (!phase) throw new AgentRuntimeError('FLOW_STATE_TRANSITION_DENIED', 'state')
      if (resumeRevision !== undefined && (stored.state !== 'waiting' || stored.waitRevision !== resumeRevision))
        throw new AgentRuntimeError('RESUME_CONFLICT', 'resume')
      const previous = { phase: run.phase, revision: run.revision, state: run.state, paused: run.paused }
      try {
        run.phase = phase
        run.revision++
        if (resumeRevision !== undefined) {
          run.state = 'running'
          run.paused = false
        }
        this.db
          .prepare('INSERT INTO flow_coordination_events VALUES (?,?,?,?,?,?)')
          .run(run.projectId, run.taskId, eventId, run.revision, signature, run.phase)
        this.save(run, resumeRevision === undefined)
      } catch (error) {
        Object.assign(run, previous)
        throw error
      }
    })()
  }
  /**
   * O3：一次流程运行的统一总览（只读投影）。把权威运行（flow_coordination_runs）与
   * 事件日志（flow_coordination_events）聚合为单一视图：运行状态/阶段/修订 + 子任务 +
   * 可回放事件时间线。事件来源归因：human.* 记 user，其余协调器可信事件记 agent。
   * 不写任何状态；权威仍是命令账本与运行实例，本视图仅供总览/回放。
   */
  overview(projectId: string, nodeId: string, file?: ProjectFile | null): FlowRunOverview | null {
    const run = this.latest(projectId, nodeId)
    if (!run) return null
    const rows = this.db
      .prepare(
        `SELECT event_id, revision, signature, state FROM flow_coordination_events
         WHERE project_id=? AND task_id=? ORDER BY revision`
      )
      .all(projectId, run.taskId) as Array<{
      event_id: string
      revision: number
      signature: string
      state: string
    }>
    const events = rows.map((row) => {
      let event = ''
      let actorSource: FlowEventActorSource = 'system'
      try {
        const stored = JSON.parse(row.signature) as { event?: string; actorSource?: FlowEventActorSource }
        event = stored.event ?? ''
        const child = event.startsWith('agent.')
          ? run.children.find((item) => row.event_id.startsWith(`${item.taskId}:`))
          : undefined
        actorSource = stored.actorSource ?? (
          child ? `agent:${child.nodeId}` : event === 'human.continue' ? 'user:owner' : 'system'
        )
      } catch {
        /* 损坏签名按空事件处理，不阻断总览。 */
      }
      return {
        eventId: row.event_id,
        revision: row.revision,
        event,
        state: row.state,
        actorSource,
        source: (event.startsWith('human.') ? 'user' : 'agent') as 'user' | 'agent'
      }
    })
    // 流程总览面板：附带声明式图拓扑（节点身份/类型/参与方式 + 边 + 入口/出口）与审核门禁
    // 状态，使 GUI 能把"运行事实"映射回"用户可见的流程结构"。只读投影，不改权威。
    const graph = run.config.graph
    const graphView = graph
      ? {
          name: graph.name,
          entry: graph.entry,
          exits: graph.exits,
          ...(graph.roles ? { roles: graph.roles.map(({ roleId, name }) => ({ roleId, name })) } : {}),
          nodes: graph.nodes.map((node) => ({
            nodeId: node.nodeId,
            title: node.title,
            kind: node.kind,
            participation: node.participation,
            ...(node.humanRole ? { humanRole: node.humanRole } : {}),
            ...(node.review
              ? {
                  review: {
                    criteria: node.review.criteria,
                    rejectPolicy: node.review.rejectPolicy,
                    maxReworks: node.review.maxReworks
                  }
                }
              : {})
          })),
          edges: graph.edges.map((edge) => ({
            from: edge.from.nodeId,
            to: edge.to.nodeId,
            kind: edge.kind ?? 'data'
          }))
        }
      : undefined
    const reviews = (run.reviews ?? []).map((review) => ({
      nodeId: review.nodeId,
      state: review.state,
      round: review.round,
      ...(review.responsibleNodeId ? { responsibleNodeId: review.responsibleNodeId } : {}),
      ...(review.decision
        ? { passed: review.decision.passed, feedback: review.decision.feedback }
        : {})
    }))
    return {
      projectId,
      nodeId: run.nodeId,
      taskId: run.taskId,
      state: run.state,
      phase: run.phase,
      revision: run.revision,
      goal: run.goal,
      paused: run.paused,
      ...(run.code ? { code: run.code } : {}),
      ...(run.state === 'waiting' && run.code === 'FLOW_CONTEXT_OVER_BUDGET' &&
        run.contextWaitStageKey ? { contextMaterialWait: {
          stageKey: run.contextWaitStageKey, waitRevision: run.waitRevision,
          ...(run.contextWaitLimitBytes ? { limitBytes: run.contextWaitLimitBytes } : {})
        } } : {}),
      executionMode: (run.config.executionMode ?? 'model') as 'model' | 'fixed-order' | 'graph',
      ...(graphView ? { graph: graphView } : {}),
      ...(run.sourceGraph ? { sourceGraph: run.sourceGraph } : {}),
      ...(file ? { canvasVersion: graphCanvasVersion(this.db, file, run.nodeId) } : {}),
      ...(run.skippedNodeIds?.length ? { skippedNodeIds: run.skippedNodeIds } : {}),
      ...(run.stalledNodeIds?.length ? { stalledNodeIds: run.stalledNodeIds } : {}),
      children: run.children.map((child) => {
        const task = ['waiting', 'running', 'blocked'].includes(child.state)
          ? this.db.prepare(
              'SELECT wait_kind, code FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? AND task_id=?'
            ).get(projectId, child.nodeId, child.taskId) as
              { wait_kind: 'human' | 'reconcile' | null; code: string | null } | undefined
          : undefined
        const command = ['waiting', 'running', 'blocked'].includes(child.state)
          ? this.db.prepare(
              "SELECT state, admitted, json_extract(receipt_json, '$.code') AS code FROM flow_commands WHERE project_id=? AND task_id=? AND state IN ('pending','unknown') ORDER BY (state='unknown') DESC LIMIT 1"
            ).get(projectId, child.taskId) as { state: string; admitted: number; code: string | null } | undefined
          : undefined
        const waitKind = task?.wait_kind === 'reconcile' || (command?.state === 'unknown' && command.admitted)
          ? 'reconcile'
          : command?.code === 'FLOW_SESSION_LOST' || task?.code === 'AGENT_SESSION_LOST' || run.code === 'AGENT_SESSION_LOST'
            ? (['waiting', 'running', 'blocked'].includes(child.state) ? 'host' : undefined)
            : task?.wait_kind === 'human' && child.state === 'waiting'
              ? 'human'
              : command?.state === 'pending' && command.admitted ? 'tool' : undefined
        return {
          nodeId: child.nodeId,
          taskId: child.taskId,
          state: child.state,
          goal: child.goal,
          ...(child.compositeWait ? { compositeWait: child.compositeWait } : {}),
          ...(waitKind ? { waitKind } : {})
        }
      }),
      staleNodeIds: [...new Set((run.reworkHistory ?? []).map((record) => record.nodeId))].filter(
        (nodeId) => !run.children.some((child) => child.nodeId === nodeId && child.state === 'completed')
      ),
      reviews,
      events
    }
  }
}

/** O3：流程运行统一总览（只读投影，非权威实体）。形状定义在 shared，三入口共用。 */
export type { FlowRunOverview } from '../../shared/agent-flow/run-overview'
