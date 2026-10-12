import type Database from 'better-sqlite3'
import {
  C0CommandSchema,
  C0OutputSchema,
  C0Error,
  type C0Command,
  type C0Output,
  type C0Scope,
  type C0Transport
} from '../../../shared/agent-flow/c0-contracts'
import type { C0Telemetry } from './diagnostics'

interface Receipt {
  signature: string
  status: 'pending' | 'completed'
  output: string | null
}

/** Persist-before-dispatch: pending/unknown work is never automatically retried. */
export class C0CommandLedger {
  private readonly inFlight = new Map<string, Promise<C0Output>>()
  constructor(
    private readonly db: Database.Database,
    private readonly telemetry: C0Telemetry
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS c0_commands (
      project TEXT NOT NULL, command TEXT NOT NULL, node TEXT NOT NULL,
      signature TEXT NOT NULL, status TEXT NOT NULL, output TEXT,
      PRIMARY KEY(project,command)
    ); CREATE UNIQUE INDEX IF NOT EXISTS c0_node_busy ON c0_commands(project,node) WHERE status='pending';`)
  }

  execute(
    raw: unknown,
    scope: C0Scope,
    transport: C0Transport,
    timeoutMs = 5_000
  ): Promise<C0Output> {
    const command = C0CommandSchema.parse(raw)
    if (
      command.projectId !== scope.projectId ||
      command.agentNodeId !== scope.agentNodeId ||
      command.taskId !== scope.taskId ||
      !scope.allowedNodeIds.includes(command.targetNodeId)
    )
      throw new C0Error('SCOPE_DENIED')
    if (command.expectedRevision !== scope.revision) throw new C0Error('REVISION_CONFLICT')
    const key = `${command.projectId}:${command.commandId}`
    // Canonical schema order; signature is private business storage, never diagnostics.
    const signature = JSON.stringify(command)
    const receipt = this.db
      .prepare('SELECT signature,status,output FROM c0_commands WHERE project=? AND command=?')
      .get(command.projectId, command.commandId) as Receipt | undefined
    if (receipt) {
      if (receipt.signature !== signature) throw new C0Error('COMMAND_CONFLICT')
      if (receipt.status === 'completed') {
        this.telemetry('command_replayed', 'receipt', undefined, command)
        return Promise.resolve(C0OutputSchema.parse(JSON.parse(receipt.output!)))
      }
      const current = this.inFlight.get(key)
      if (current) return current
      this.telemetry('command_blocked', 'receipt', 'OUTCOME_UNKNOWN', command)
      throw new C0Error('OUTCOME_UNKNOWN')
    }
    try {
      this.db
        .prepare('INSERT INTO c0_commands VALUES (?,?,?,?,?,NULL)')
        .run(command.projectId, command.commandId, command.targetNodeId, signature, 'pending')
    } catch {
      const busy = this.db
        .prepare("SELECT command FROM c0_commands WHERE project=? AND node=? AND status='pending'")
        .get(command.projectId, command.targetNodeId)
      if (busy) throw new C0Error('NODE_BUSY')
      this.telemetry('storage_failed', 'receipt', 'RECEIPT_WRITE_FAILED', command)
      throw new C0Error('RECEIPT_WRITE_FAILED')
    }
    const pending = this.dispatch(command, transport, timeoutMs).finally(() =>
      this.inFlight.delete(key)
    )
    this.inFlight.set(key, pending)
    return pending
  }

  private async dispatch(
    command: C0Command,
    transport: C0Transport,
    timeoutMs: number
  ): Promise<C0Output> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    this.telemetry('bridge_dispatch', 'dispatch', undefined, command)
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new C0Error('OUTCOME_UNKNOWN'))
        }, timeoutMs)
      })
      const output = C0OutputSchema.parse(
        await Promise.race([transport.execute(command, controller.signal), timeout])
      )
      this.db
        .prepare("UPDATE c0_commands SET status='completed',output=? WHERE project=? AND command=?")
        .run(JSON.stringify(output), command.projectId, command.commandId)
      this.telemetry('command_completed', 'receipt', undefined, command)
      return output
    } catch {
      // Timeout, disconnect, invalid response and persist gaps may hide a completed effect.
      this.telemetry('command_unknown', 'dispatch', 'OUTCOME_UNKNOWN', command)
      throw new C0Error('OUTCOME_UNKNOWN')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
