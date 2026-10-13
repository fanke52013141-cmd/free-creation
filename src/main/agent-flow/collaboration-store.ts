import type Database from 'better-sqlite3'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import type { FlowAgentCollaboration } from '../../shared/agent-flow/desktop-tasks'

export type CollaborationEvent = FlowAgentCollaboration & { reply?: string; childTaskId?: string }
export class FlowCollaborationStore {
  constructor(private readonly db: Database.Database) {}
  read(thread: string): CollaborationEvent[] {
    return (
      this.db
        .prepare('SELECT body_json FROM flow_agent_collaboration WHERE thread=? ORDER BY revision')
        .all(thread) as Array<{ body_json: string }>
    ).map((row) => JSON.parse(row.body_json))
  }
  check(thread: string, input: FlowAgentCollaboration): CollaborationEvent | null {
    const row = this.db
      .prepare(
        'SELECT signature,body_json FROM flow_agent_collaboration WHERE thread=? AND event_id=?'
      )
      .get(thread, input.eventId) as { signature: string; body_json: string } | undefined
    if (row) {
      if (row.signature !== canonicalFlowJson(input))
        throw new AgentRuntimeError('COLLABORATION_INTENT_CONFLICT', 'collaboration')
      return JSON.parse(row.body_json)
    }
    const events = this.read(thread)
    if (events.length !== input.revision)
      throw new AgentRuntimeError('COLLABORATION_REVISION_CONFLICT', 'collaboration')
    if (events.length >= 40) throw new AgentRuntimeError('COLLABORATION_LIMIT', 'collaboration')
    return null
  }
  append(
    thread: string,
    input: FlowAgentCollaboration,
    extra: Pick<CollaborationEvent, 'reply' | 'childTaskId'> = {}
  ): void {
    this.db.transaction(() => {
      if (this.check(thread, input)) return
      this.db
        .prepare('INSERT INTO flow_agent_collaboration VALUES (?,?,?,?,?)')
        .run(
          thread,
          input.eventId,
          input.revision + 1,
          canonicalFlowJson(input),
          JSON.stringify({ ...input, ...extra })
        )
    })()
  }
}
