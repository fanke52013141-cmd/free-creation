import type Database from 'better-sqlite3'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointTuple,
  type CheckpointMetadata,
  type CheckpointListOptions,
  type PendingWrite,
  type CheckpointPendingWrite
} from '@langchain/langgraph-checkpoint'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import type { AgentTelemetry } from './runtime-diagnostics'

interface CheckpointRow {
  thread: string
  namespace: string
  id: string
  parent: string | null
  type: string
  data: Buffer
  metadata_type: string
  metadata: Buffer
}
interface WriteRow {
  task: string
  channel: string
  type: string
  data: Buffer
}

/** Production task-scoped SQLite saver. Tables are owned by database migrations. */
export class FlowSqliteSaver extends BaseCheckpointSaver {
  constructor(
    private readonly db: Database.Database,
    private readonly telemetry: AgentTelemetry
  ) {
    super()
  }

  private keys(config: RunnableConfig): { thread: string; namespace: string; id?: string } {
    const fields = config.configurable
    if (typeof fields?.thread_id !== 'string' || !fields.thread_id)
      throw new AgentRuntimeError('THREAD_REQUIRED', 'checkpoint')
    return {
      thread: fields.thread_id,
      namespace: fields.checkpoint_ns ?? '',
      id: fields.checkpoint_id
    }
  }

  private async tuple(row: CheckpointRow): Promise<CheckpointTuple> {
    const writes = this.db
      .prepare(
        `SELECT task,channel,type,data FROM flow_agent_checkpoint_writes
      WHERE thread=? AND namespace=? AND checkpoint=? ORDER BY task,idx`
      )
      .all(row.thread, row.namespace, row.id) as WriteRow[]
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      writes.map(
        async (write) =>
          [
            write.task,
            write.channel,
            await this.serde.loadsTyped(write.type, write.data)
          ] as CheckpointPendingWrite
      )
    )
    return {
      config: {
        configurable: { thread_id: row.thread, checkpoint_ns: row.namespace, checkpoint_id: row.id }
      },
      checkpoint: (await this.serde.loadsTyped(row.type, row.data)) as Checkpoint,
      metadata: (await this.serde.loadsTyped(
        row.metadata_type,
        row.metadata
      )) as CheckpointMetadata,
      pendingWrites,
      ...(row.parent
        ? {
            parentConfig: {
              configurable: {
                thread_id: row.thread,
                checkpoint_ns: row.namespace,
                checkpoint_id: row.parent
              }
            }
          }
        : {})
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const key = this.keys(config)
    const row = (
      key.id
        ? this.db
            .prepare('SELECT * FROM flow_agent_checkpoints WHERE thread=? AND namespace=? AND id=?')
            .get(key.thread, key.namespace, key.id)
        : this.db
            .prepare(
              'SELECT * FROM flow_agent_checkpoints WHERE thread=? AND namespace=? ORDER BY id DESC LIMIT 1'
            )
            .get(key.thread, key.namespace)
    ) as CheckpointRow | undefined
    return row ? this.tuple(row) : undefined
  }

  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {}
  ): AsyncGenerator<CheckpointTuple> {
    const key = this.keys(config)
    const before = options.before?.configurable?.checkpoint_id
    const rows = this.db
      .prepare(
        `SELECT * FROM flow_agent_checkpoints WHERE thread=? AND namespace=?
      ${before ? 'AND id < ?' : ''} ORDER BY id DESC`
      )
      .all(...[key.thread, key.namespace, ...(before ? [before] : [])]) as CheckpointRow[]
    let count = 0
    for (const row of rows) {
      if (options.limit !== undefined && count >= options.limit) break
      const tuple = await this.tuple(row)
      if (
        options.filter &&
        !Object.entries(options.filter).every(
          ([name, value]) => JSON.stringify(tuple.metadata?.[name]) === JSON.stringify(value)
        )
      )
        continue
      count++
      yield tuple
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const key = this.keys(config)
    const [type, data] = await this.serde.dumpsTyped(checkpoint)
    const [metadataType, metadataData] = await this.serde.dumpsTyped(metadata)
    try {
      this.db
        .prepare(
          `INSERT INTO flow_agent_checkpoints VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(thread,namespace,id) DO UPDATE SET parent=excluded.parent,
          type=excluded.type,data=excluded.data,metadata_type=excluded.metadata_type,metadata=excluded.metadata`
        )
        .run(
          key.thread,
          key.namespace,
          checkpoint.id,
          key.id ?? null,
          type,
          Buffer.from(data),
          metadataType,
          Buffer.from(metadataData)
        )
      this.telemetry('checkpoint_saved', 'checkpoint')
      return {
        configurable: {
          thread_id: key.thread,
          checkpoint_ns: key.namespace,
          checkpoint_id: checkpoint.id
        }
      }
    } catch {
      this.telemetry('failed', 'checkpoint', 'CHECKPOINT_WRITE_FAILED')
      throw new AgentRuntimeError('CHECKPOINT_WRITE_FAILED', 'checkpoint')
    }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const key = this.keys(config)
    if (!key.id) throw new AgentRuntimeError('CHECKPOINT_REQUIRED', 'checkpoint')
    const serialized = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, data] = await this.serde.dumpsTyped(value)
        return { channel, idx: WRITES_IDX_MAP[channel] ?? idx, type, data: Buffer.from(data) }
      })
    )
    try {
      this.db.transaction(() => {
        for (const write of serialized) {
          const conflict = write.idx < 0 ? 'REPLACE' : 'IGNORE'
          this.db
            .prepare(
              `INSERT OR ${conflict} INTO flow_agent_checkpoint_writes VALUES (?,?,?,?,?,?,?,?)`
            )
            .run(
              key.thread,
              key.namespace,
              key.id,
              taskId,
              write.idx,
              write.channel,
              write.type,
              write.data
            )
        }
      })()
    } catch {
      this.telemetry('failed', 'checkpoint-writes', 'CHECKPOINT_WRITE_FAILED')
      throw new AgentRuntimeError('CHECKPOINT_WRITE_FAILED', 'checkpoint')
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM flow_agent_checkpoint_writes WHERE thread=?').run(threadId)
      this.db.prepare('DELETE FROM flow_agent_checkpoints WHERE thread=?').run(threadId)
    })()
  }
}
