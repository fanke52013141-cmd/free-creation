import { getDb } from './db'

export type CompositeRunStatus =
  | 'accepted'
  | 'running'
  | 'waiting-input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

export interface CompositeRunRecord {
  id: string
  projectId: string
  capabilityId: string
  capabilityVersion: string
  contentHash: string
  instanceNodeId: string | null
  status: CompositeRunStatus
  startedAt: number
  finishedAt: number | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
}

export interface CompositeRunStepRecord {
  runId: string
  stepKey: string
  nodeType: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  startedAt: number | null
  finishedAt: number | null
  reason: string | null
}

interface RunRow {
  id: string
  project_id: string
  capability_id: string
  capability_version: string
  content_hash: string
  instance_node_id: string | null
  status: string
  started_at: number
  finished_at: number | null
  error_code: string | null
  error_message: string | null
  created_at: number
}

interface StepRow {
  run_id: string
  step_key: string
  node_type: string
  status: string
  started_at: number | null
  finished_at: number | null
  reason: string | null
}

function rowToRun(row: RunRow): CompositeRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    capabilityId: row.capability_id,
    capabilityVersion: row.capability_version,
    contentHash: row.content_hash,
    instanceNodeId: row.instance_node_id,
    status: row.status as CompositeRunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at
  }
}

function rowToStep(row: StepRow): CompositeRunStepRecord {
  return {
    runId: row.run_id,
    stepKey: row.step_key,
    nodeType: row.node_type,
    status: row.status as CompositeRunStepRecord['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    reason: row.reason
  }
}

export function createCompositeRun(input: {
  id: string
  projectId: string
  capabilityId: string
  capabilityVersion: string
  contentHash: string
  instanceNodeId?: string
}): CompositeRunRecord {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO composite_runs
       (id, project_id, capability_id, capability_version, content_hash,
        instance_node_id, status, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`
    )
    .run(
      input.id,
      input.projectId,
      input.capabilityId,
      input.capabilityVersion,
      input.contentHash,
      input.instanceNodeId ?? null,
      now,
      now
    )
  const row = getDb().prepare('SELECT * FROM composite_runs WHERE id = ?').get(input.id) as RunRow
  return rowToRun(row)
}

export function recordCompositeRunStep(input: {
  runId: string
  stepKey: string
  nodeType: string
  status: CompositeRunStepRecord['status']
  reason?: string
}): void {
  const now = Date.now()
  const existing = getDb()
    .prepare('SELECT * FROM composite_run_steps WHERE run_id = ? AND step_key = ?')
    .get(input.runId, input.stepKey) as StepRow | undefined
  if (!existing) {
    getDb()
      .prepare(
        `INSERT INTO composite_run_steps(run_id, step_key, node_type, status, started_at, finished_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        input.stepKey,
        input.nodeType,
        input.status,
        input.status === 'running' ? now : now,
        input.status === 'running' ? null : now,
        input.reason ?? null
      )
    return
  }
  getDb()
    .prepare(
      `UPDATE composite_run_steps SET status = ?, finished_at = ?, reason = ? WHERE run_id = ? AND step_key = ?`
    )
    .run(
      input.status,
      input.status === 'running' ? null : now,
      input.reason ?? null,
      input.runId,
      input.stepKey
    )
}

export function finishCompositeRun(input: {
  runId: string
  status: Extract<CompositeRunStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'>
  errorCode?: string
  errorMessage?: string
}): void {
  getDb()
    .prepare(
      `UPDATE composite_runs SET status = ?, finished_at = ?, error_code = ?, error_message = ?
       WHERE id = ? AND status IN ('accepted','running','waiting-input')`
    )
    .run(
      input.status,
      Date.now(),
      input.errorCode ?? null,
      input.errorMessage?.slice(0, 500) ?? null,
      input.runId
    )
}

export function getCompositeRun(runId: string): {
  run: CompositeRunRecord
  steps: CompositeRunStepRecord[]
} | null {
  const row = getDb().prepare('SELECT * FROM composite_runs WHERE id = ?').get(runId) as
    | RunRow
    | undefined
  if (!row) return null
  const steps = getDb()
    .prepare('SELECT * FROM composite_run_steps WHERE run_id = ? ORDER BY started_at ASC')
    .all(runId) as StepRow[]
  return { run: rowToRun(row), steps: steps.map(rowToStep) }
}

export function listCompositeRuns(projectId: string, limit = 20): CompositeRunRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM composite_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(projectId, Math.max(1, Math.min(100, limit))) as RunRow[]
  return rows.map(rowToRun)
}

/** App 启动时调用：上次进程遗留的 running 组合明确标为 interrupted，不伪造成功。 */
export function settleInterruptedCompositeRuns(): number {
  return getDb()
    .prepare(
      `UPDATE composite_runs SET status = 'interrupted', finished_at = ?, error_code = 'HOST_RESTARTED',
        error_message = '应用关闭或重启中断了组合运行，请核对后重试'
       WHERE status IN ('accepted','running','waiting-input')`
    )
    .run(Date.now()).changes
}
