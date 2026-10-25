import type Database from 'better-sqlite3'
import type { AccessOutput } from '../../shared/agent-access/registry'
import { createHash } from 'node:crypto'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import {
  AgentTaskSnapshotSchema,
  AgentResumeSchema,
  AgentRuntimeError,
  type AgentTaskSnapshot,
  type FixedSkill,
  type AgentResume
} from '../../shared/agent-flow/runtime-contracts'
import type { AgentFlowAssetRefSchema } from '../../shared/agent-flow/node-contracts'
import type { z } from 'zod'

export interface AgentTaskRecord {
  snapshot: AgentTaskSnapshot
  skills: FixedSkill[]
  state: 'ready' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'cancelled'
  decisions: number
  tools: number
  activeMs: number
  waitRevision: number
  waitKind: 'human' | 'reconcile' | null
  code?: string
  outputRefs: z.infer<typeof AgentFlowAssetRefSchema>[]
}
interface Row {
  snapshot_json: string
  skills_json: string
  state: AgentTaskRecord['state']
  decisions: number
  tools: number
  active_ms: number
  wait_revision: number
  wait_kind: AgentTaskRecord['waitKind']
  code: string | null
  output_refs_json: string
}
export function agentThread(
  snapshot: Pick<AgentTaskSnapshot, 'projectId' | 'agentNodeId' | 'taskId'>
): string {
  // Hash the structured identity: concatenated user IDs can otherwise collide.
  return createHash('sha256')
    .update(JSON.stringify([snapshot.projectId, snapshot.agentNodeId, snapshot.taskId]))
    .digest('hex')
}
export class FlowTaskStore {
  constructor(readonly db: Database.Database) {}

  /** Read persisted facts without loading prompts, skills, outputs or checkpoint payloads. */
  summary(projectId: string, taskId: string): AccessOutput<'run.get'> | null {
    const row = this.db.prepare(`SELECT state, wait_revision, wait_kind FROM flow_agent_tasks
      WHERE project_id=? AND task_id=?`).get(projectId, taskId) as
      Pick<Row, 'state' | 'wait_revision' | 'wait_kind'> | undefined
    if (!row) return null
    const waitKind = row.state === 'waiting' || row.state === 'blocked' ? row.wait_kind : null
    return {
      projectId, taskId, source: 'flow-agent-task' as const, state: row.state,
      waitRevision: row.wait_revision, waitKind,
      stateReason: waitKind === 'reconcile' ? 'RECONCILE_REQUIRED'
        : waitKind === 'human' ? 'HUMAN_REQUIRED'
          : row.state === 'blocked' ? 'TASK_BLOCKED'
            : row.state === 'failed' ? 'TASK_FAILED' : null,
      reconcileRequired: waitKind === 'reconcile', allowedActions: []
    }
  }

  create(raw: unknown, skills: FixedSkill[]): AgentTaskRecord {
    const snapshot = AgentTaskSnapshotSchema.parse(raw)
    const thread = agentThread(snapshot)
    if (JSON.stringify(skills).length > 262144)
      throw new AgentRuntimeError('SKILL_CONTEXT_TOO_LARGE', 'task-bind')
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT * FROM flow_agent_tasks WHERE thread=?').get(thread) as
        Row | undefined
      if (old) {
        if (canonicalFlowJson(JSON.parse(old.snapshot_json)) !== canonicalFlowJson(snapshot))
          throw new AgentRuntimeError('TASK_INTENT_CONFLICT', 'task-bind')
        return this.read(thread)
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? AND state IN ('ready','running','waiting','blocked')"
          )
          .get(snapshot.projectId, snapshot.agentNodeId)
      )
        throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'task-bind')
      this.db
        .prepare(
          `INSERT INTO flow_agent_tasks
        (thread, project_id, task_id, agent_node_id, snapshot_json, skills_json, state)
        VALUES (?, ?, ?, ?, ?, ?, 'ready')`
        )
        .run(
          thread,
          snapshot.projectId,
          snapshot.taskId,
          snapshot.agentNodeId,
          JSON.stringify(snapshot),
          JSON.stringify(skills)
        )
      return this.read(thread)
    })()
  }

  read(thread: string): AgentTaskRecord {
    const row = this.db.prepare('SELECT * FROM flow_agent_tasks WHERE thread=?').get(thread) as
      Row | undefined
    if (!row) throw new AgentRuntimeError('AGENT_TASK_MISSING', 'task-read')
    return {
      snapshot: AgentTaskSnapshotSchema.parse(JSON.parse(row.snapshot_json)),
      skills: JSON.parse(row.skills_json),
      state: row.state,
      decisions: row.decisions,
      tools: row.tools,
      activeMs: row.active_ms,
      waitRevision: row.wait_revision,
      waitKind: row.wait_kind,
      code: row.code ?? undefined,
      outputRefs: JSON.parse(row.output_refs_json)
    }
  }

  setState(
    thread: string,
    state: AgentTaskRecord['state'],
    code?: string,
    outputs: AgentTaskRecord['outputRefs'] = []
  ): void {
    const old = this.read(thread)
    if (['completed', 'failed', 'cancelled'].includes(old.state) && old.state !== state)
      throw new AgentRuntimeError('TASK_TERMINAL', 'task-state')
    this.db
      .prepare('UPDATE flow_agent_tasks SET state=?, code=?, output_refs_json=? WHERE thread=?')
      .run(state, code ?? null, JSON.stringify(outputs), thread)
  }

  reserve(thread: string, counter: 'decisions' | 'tools'): void {
    this.db.transaction(() => {
      const record = this.read(thread)
      if (record.state !== 'running') throw new AgentRuntimeError('TASK_NOT_RUNNING', 'budget')
      const max =
        counter === 'decisions'
          ? Math.min(record.snapshot.maxDecisions, record.snapshot.config.maxSteps)
          : record.snapshot.maxTools
      if (record[counter] >= max || record.activeMs >= record.snapshot.maxActiveMs)
        throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'budget')
      // Reserved before calls; a crash cannot refund a model/tool attempt.
      this.db
        .prepare(`UPDATE flow_agent_tasks SET ${counter}=${counter}+1 WHERE thread=?`)
        .run(thread)
    })()
  }

  charge(thread: string, durationMs: number): void {
    this.db
      .prepare('UPDATE flow_agent_tasks SET active_ms=active_ms+? WHERE thread=?')
      .run(Math.max(0, Math.ceil(durationMs)), thread)
  }

  reserveCommand(thread: string, commandId: string): void {
    this.db.transaction(() => {
      if (
        this.db
          .prepare('SELECT 1 FROM flow_agent_tool_calls WHERE thread=? AND command_id=?')
          .get(thread, commandId)
      )
        return
      this.reserve(thread, 'tools')
      this.db.prepare('INSERT INTO flow_agent_tool_calls VALUES (?, ?)').run(thread, commandId)
    })()
  }

  wait(thread: string, kind: NonNullable<AgentTaskRecord['waitKind']>): number {
    this.db
      .prepare(
        "UPDATE flow_agent_tasks SET state='waiting', wait_kind=?, wait_revision=wait_revision+1 WHERE thread=?"
      )
      .run(kind, thread)
    return this.read(thread).waitRevision
  }

  response(thread: string, raw: unknown): { response: AgentResume; replay: boolean } {
    const response = AgentResumeSchema.parse(raw)
    const signature = canonicalFlowJson(response)
    return this.db.transaction(() => {
      const record = this.read(thread)
      const old = this.db
        .prepare('SELECT signature FROM flow_agent_responses WHERE thread=? AND event_id=?')
        .get(thread, response.eventId) as { signature: string } | undefined
      if (old) {
        if (old.signature !== signature)
          throw new AgentRuntimeError('RESUME_INTENT_CONFLICT', 'resume')
        return { response, replay: true }
      }
      if (
        record.state !== 'waiting' ||
        response.taskId !== record.snapshot.taskId ||
        response.semanticRevision !== record.snapshot.semanticRevision ||
        response.waitRevision !== record.waitRevision ||
        response.kind !== record.waitKind ||
        (response.kind === 'human' && typeof response.accepted !== 'boolean')
      )
        throw new AgentRuntimeError('RESUME_CONFLICT', 'resume')
      this.db
        .prepare('INSERT INTO flow_agent_responses VALUES (?, ?, ?, ?)')
        .run(thread, response.eventId, signature, response.waitRevision)
      return { response, replay: false }
    })()
  }
}
