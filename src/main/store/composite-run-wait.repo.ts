import { getDb } from './db'

export interface CompositeRunWaitField {
  fieldId: string
  label: string
  type: string
  required: boolean
  cardinality: 'one' | 'many'
  target?: { nodeId: string; portId: string }
}

export interface CompositeRunWait {
  requestId: string
  runId: string
  stepKey: string | null
  revision: number
  kind: 'input' | 'human'
  state: 'open' | 'satisfied' | 'cancelled' | 'expired'
  fields: CompositeRunWaitField[]
  createdAt: number
  expiresAt: number | null
  satisfiedAt: number | null
}

interface WaitRow {
  id: string
  run_id: string
  step_key: string | null
  revision: number
  kind: string
  state: string
  fields_json: string
  value_json: string | null
  submitted_by: string | null
  created_at: number
  expires_at: number | null
  satisfied_at: number | null
}

function rowToWait(row: WaitRow): CompositeRunWait {
  let fields: CompositeRunWaitField[] = []
  try {
    const parsed = JSON.parse(row.fields_json) as unknown
    if (Array.isArray(parsed)) fields = parsed as CompositeRunWaitField[]
  } catch {
    // 损坏字段描述按空列表处理，不阻塞读取；运行侧会再次校验。
  }
  return {
    requestId: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    revision: row.revision,
    kind: row.kind as CompositeRunWait['kind'],
    state: row.state as CompositeRunWait['state'],
    fields,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    satisfiedAt: row.satisfied_at
  }
}

/** 打开一次等待；revision 在运行内单调递增，重复打开同一 revision 复用。 */
export function openCompositeRunWait(input: {
  requestId: string
  runId: string
  stepKey?: string
  kind: 'input' | 'human'
  fields: CompositeRunWaitField[]
  expiresAt?: number
}): CompositeRunWait {
  const db = getDb()
  const current = db
    .prepare('SELECT revision FROM composite_run_waits WHERE run_id = ? ORDER BY revision DESC LIMIT 1')
    .get(input.runId) as { revision: number } | undefined
  const revision = (current?.revision ?? 0) + 1
  db.prepare(
    `INSERT INTO composite_run_waits
     (id, run_id, step_key, revision, kind, state, fields_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  ).run(
    input.requestId,
    input.runId,
    input.stepKey ?? null,
    revision,
    input.kind,
    JSON.stringify(input.fields),
    Date.now(),
    input.expiresAt ?? null
  )
  return getCompositeRunWait(input.requestId)!
}

export function getCompositeRunWait(requestId: string): CompositeRunWait | null {
  const row = getDb().prepare('SELECT * FROM composite_run_waits WHERE id = ?').get(requestId) as
    | WaitRow
    | undefined
  return row ? rowToWait(row) : null
}

export function getOpenCompositeRunWait(runId: string): CompositeRunWait | null {
  const row = getDb()
    .prepare("SELECT * FROM composite_run_waits WHERE run_id = ? AND state = 'open' ORDER BY revision DESC LIMIT 1")
    .get(runId) as WaitRow | undefined
  return row ? rowToWait(row) : null
}

/** 补交等待：revision 必须仍是最新且 state=open；重复提交同一 request 返回当前状态。 */
export function satisfyCompositeRunWait(input: {
  requestId: string
  revision: number
  value: unknown
  submittedBy: string
}): { ok: boolean; reason?: string; wait?: CompositeRunWait } {
  const db = getDb()
  const row = db.prepare('SELECT * FROM composite_run_waits WHERE id = ?').get(input.requestId) as
    | WaitRow
    | undefined
  if (!row) return { ok: false, reason: 'WAIT_NOT_FOUND' }
  if (row.state === 'satisfied') return { ok: true, wait: rowToWait(row) }
  if (row.state !== 'open') return { ok: false, reason: 'WAIT_CLOSED' }
  if (row.revision !== input.revision) return { ok: false, reason: 'WAIT_REVISION_CONFLICT' }
  const latest = db
    .prepare('SELECT revision FROM composite_run_waits WHERE run_id = ? ORDER BY revision DESC LIMIT 1')
    .get(row.run_id) as { revision: number } | undefined
  if (latest && latest.revision !== row.revision) return { ok: false, reason: 'WAIT_REVISION_CONFLICT' }
  if (row.expires_at !== null && Date.now() > row.expires_at) {
    db.prepare("UPDATE composite_run_waits SET state = 'expired' WHERE id = ?").run(input.requestId)
    return { ok: false, reason: 'WAIT_EXPIRED' }
  }
  db.prepare(
    `UPDATE composite_run_waits SET state = 'satisfied', value_json = ?, submitted_by = ?, satisfied_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(input.value), input.submittedBy, Date.now(), input.requestId)
  return { ok: true, wait: getCompositeRunWait(input.requestId)! }
}

export function cancelCompositeRunWait(requestId: string): boolean {
  return (
    getDb()
      .prepare("UPDATE composite_run_waits SET state = 'cancelled' WHERE id = ? AND state = 'open'")
      .run(requestId).changes > 0
  )
}
