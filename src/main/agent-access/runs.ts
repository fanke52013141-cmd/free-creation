import { randomUUID } from 'node:crypto'
import { getDb } from '../store/db'
import { NODE_EXECUTE_MAX_NODES } from '../../shared/agent-access/run-ops'

// 外部节点执行任务账本（F3）。main 是任务状态的唯一拥有者；
// renderer 权威宿主通过受控报告 IPC 回填运行中/终态。状态推进单方向：
// accepted → running → completed|failed|cancelled；cancel-requested 由 run.cancel 写入。

export type ExternalRunState =
  | 'accepted'
  | 'running'
  | 'cancel-requested'
  | 'completed'
  | 'failed'
  | 'cancelled'

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

export interface ExternalRunRow {
  id: string
  project_id: string
  mode: string
  node_ids: string
  status: ExternalRunState
  error: string | null
  run_id: string | null
  created_at: number
  updated_at: number
}

export function createExternalRun(input: {
  projectId: string
  mode: 'single' | 'subgraph'
  nodeIds: string[]
}): ExternalRunRow {
  const id = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO external_runs (id,project_id,mode,node_ids,status,error,run_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      input.projectId,
      input.mode,
      JSON.stringify(input.nodeIds.slice(0, NODE_EXECUTE_MAX_NODES)),
      'accepted',
      null,
      null,
      now,
      now
    )
  return getExternalRun(id)!
}

export function getExternalRun(id: string): ExternalRunRow | null {
  const row = getDb().prepare('SELECT * FROM external_runs WHERE id=?').get(id) as
    | ExternalRunRow
    | undefined
  return row ?? null
}

/** 报告推进：只允许合法的单向状态迁移；重复报告同一终态幂等忽略。 */
export function reportExternalRun(
  id: string,
  next: 'running' | 'completed' | 'failed' | 'cancelled',
  detail?: { error?: string }
): ExternalRunRow | null {
  const row = getExternalRun(id)
  if (!row) return null
  const allowed: Record<string, readonly string[]> = {
    accepted: ['running', 'completed', 'failed', 'cancelled'],
    running: ['completed', 'failed', 'cancelled'],
    'cancel-requested': ['cancelled', 'completed', 'failed'],
    completed: [],
    failed: [],
    cancelled: []
  }
  if (!allowed[row.status]?.includes(next)) return row
  getDb()
    .prepare('UPDATE external_runs SET status=?, error=?, updated_at=? WHERE id=?')
    .run(next, detail?.error?.slice(0, 500) ?? row.error, Date.now(), id)
  return getExternalRun(id)
}

export function requestExternalRunCancel(id: string): ExternalRunRow | null {
  const row = getExternalRun(id)
  if (!row) return null
  if (TERMINAL.has(row.status)) return row
  if (row.status === 'cancel-requested') return row
  getDb()
    .prepare("UPDATE external_runs SET status='cancel-requested', updated_at=? WHERE id=?")
    .run(Date.now(), id)
  return getExternalRun(id)
}

export function projectHasActiveExternalRun(projectId: string): boolean {
  return !!getDb()
    .prepare(
      "SELECT 1 FROM external_runs WHERE project_id=? AND status IN ('accepted','running','cancel-requested') LIMIT 1"
    )
    .get(projectId)
}

/**
 * 宿主启动结算：终态只能由宿主回执推进，新宿主启动时仍非终态的行必然已失去执行宿主
 * （崩溃/退出）。统一结算为 failed/HOST_RESTARTED，保留行、不删除、不重放、不补产物。
 * 调用方必须先持有接入服务进程锁，确认没有其他存活宿主。
 */
export function settleOrphanedExternalRuns(): {
  id: string
  projectId: string
  from: string
}[] {
  const db = getDb()
  const rows = db
    .prepare(
      "SELECT id,project_id,status FROM external_runs WHERE status IN ('accepted','running','cancel-requested') ORDER BY created_at"
    )
    .all() as { id: string; project_id: string; status: string }[]
  if (rows.length === 0) return []
  const update = db.prepare(
    "UPDATE external_runs SET status='failed', error='HOST_RESTARTED', updated_at=? WHERE id=? AND status IN ('accepted','running','cancel-requested')"
  )
  const settled: { id: string; projectId: string; from: string }[] = []
  db.transaction(() => {
    const now = Date.now()
    for (const row of rows)
      if (update.run(now, row.id).changes === 1)
        settled.push({ id: row.id, projectId: row.project_id, from: row.status })
  })()
  return settled
}
