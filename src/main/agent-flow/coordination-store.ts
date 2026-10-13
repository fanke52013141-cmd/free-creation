import type Database from 'better-sqlite3'
import type {
  AgentNodeConfigSchema,
  StateMachineNodeConfigSchema
} from '../../shared/agent-flow/node-contracts'
import type { z } from 'zod'
import type { FlowAgentReply, FlowAgentView } from '../../shared/agent-flow/desktop-tasks'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'

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
  childIds: string[]
  state: FlowAgentView['state']
  phase: string
  revision: number
  waitRevision: number
  decisions: number
  paused: boolean
  code?: string
  traceId: string
  spanId: string
  children: Array<{
    nodeId: string
    taskId: string
    goal: string
    completion: string
    inputs: FlowAgentReply['refs']
    state: string
    outputs: FlowAgentReply['refs']
  }>
  outputs: FlowAgentReply['refs']
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
  event(run: CoordinationRun, eventId: string, event: string, expectedRevision: number): void {
    const signature = canonicalFlowJson({ event, expectedRevision })
    this.db.transaction(() => {
      const prior = this.db
        .prepare(
          'SELECT signature FROM flow_coordination_events WHERE project_id=? AND task_id=? AND event_id=?'
        )
        .get(run.projectId, run.taskId, eventId) as { signature: string } | undefined
      if (prior) {
        if (prior.signature !== signature)
          throw new AgentRuntimeError('FLOW_STATE_EVENT_CONFLICT', 'state')
        return
      }
      const stored = this.latest(run.projectId, run.nodeId)
      if (!stored || stored.taskId !== run.taskId || stored.revision !== expectedRevision)
        throw new AgentRuntimeError('FLOW_STATE_REVISION_CONFLICT', 'state')
      const next = run.stateConfig.transitions.find(
        (t) => t.from === run.phase && t.event === event
      )
      if (!next) throw new AgentRuntimeError('FLOW_STATE_TRANSITION_DENIED', 'state')
      const previous = { phase: run.phase, revision: run.revision }
      try {
        run.phase = next.to
        run.revision++
        this.db
          .prepare('INSERT INTO flow_coordination_events VALUES (?,?,?,?,?,?)')
          .run(run.projectId, run.taskId, eventId, run.revision, signature, run.phase)
        this.save(run)
      } catch (error) {
        Object.assign(run, previous)
        throw error
      }
    })()
  }
}
