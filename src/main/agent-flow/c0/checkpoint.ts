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
import { C0Error } from '../../../shared/agent-flow/c0-contracts'
import type { C0Telemetry } from './diagnostics'

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

/** Experimental saver in an explicitly supplied, isolated DB. No production migration. */
export class C0SqliteSaver extends BaseCheckpointSaver {
  constructor(
    private readonly db: Database.Database,
    private readonly telemetry: C0Telemetry
  ) {
    super()
    db.exec(`
      CREATE TABLE IF NOT EXISTS c0_checkpoints (
        thread TEXT NOT NULL, namespace TEXT NOT NULL, id TEXT NOT NULL,
        parent TEXT, type TEXT NOT NULL, data BLOB NOT NULL,
        metadata_type TEXT NOT NULL, metadata BLOB NOT NULL,
        PRIMARY KEY(thread, namespace, id)
      );
      CREATE TABLE IF NOT EXISTS c0_checkpoint_writes (
        thread TEXT NOT NULL, namespace TEXT NOT NULL, checkpoint TEXT NOT NULL,
        task TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL,
        type TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(thread, namespace, checkpoint, task, idx)
      );
    `)
  }

  private keys(config: RunnableConfig): { thread: string; namespace: string; id?: string } {
    const fields = config.configurable
    if (typeof fields?.thread_id !== 'string' || !fields.thread_id)
      throw new C0Error('THREAD_REQUIRED')
    return {
      thread: fields.thread_id,
      namespace: fields.checkpoint_ns ?? '',
      id: fields.checkpoint_id
    }
  }

  private async tuple(row: CheckpointRow): Promise<CheckpointTuple> {
    const writes = this.db
      .prepare(
        `SELECT task,channel,type,data FROM c0_checkpoint_writes
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
            .prepare('SELECT * FROM c0_checkpoints WHERE thread=? AND namespace=? AND id=?')
            .get(key.thread, key.namespace, key.id)
        : this.db
            .prepare(
              'SELECT * FROM c0_checkpoints WHERE thread=? AND namespace=? ORDER BY id DESC LIMIT 1'
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
        `SELECT * FROM c0_checkpoints WHERE thread=? AND namespace=?
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
        .prepare(`INSERT OR REPLACE INTO c0_checkpoints VALUES (?,?,?,?,?,?,?,?)`)
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
      this.telemetry('storage_failed', 'checkpoint', 'CHECKPOINT_WRITE_FAILED')
      throw new C0Error('CHECKPOINT_WRITE_FAILED')
    }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const key = this.keys(config)
    if (!key.id) throw new C0Error('CHECKPOINT_REQUIRED')
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
            .prepare(`INSERT OR ${conflict} INTO c0_checkpoint_writes VALUES (?,?,?,?,?,?,?,?)`)
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
      this.telemetry('storage_failed', 'checkpoint-writes', 'CHECKPOINT_WRITE_FAILED')
      throw new C0Error('CHECKPOINT_WRITE_FAILED')
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM c0_checkpoint_writes WHERE thread=?').run(threadId)
      this.db.prepare('DELETE FROM c0_checkpoints WHERE thread=?').run(threadId)
    })()
  }
}
