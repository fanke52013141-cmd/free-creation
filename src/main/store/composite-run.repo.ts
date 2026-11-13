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
  /** 外层运行 ID；节点流嵌套调用时用于父子关联。 */
  parentRunId: string | null
  status: CompositeRunStatus
  startedAt: number
  finishedAt: number | null
  errorCode: string | null
  errorMessage: string | null
  /** input / step / output / runtime；成功时为 null。 */
  failurePhase: string | null
  /** W4 失败定位：失败的内部节点 ID（只存 ID，不存正文）；无则为 null。 */
  failureNodeId: string | null
  /** W4 失败定位：失败的内部端口 ID；无则为 null。 */
  failurePortId: string | null
  /** 已产生的公开输出摘要：[{portId, kind}]，不含正文。 */
  outputSummary: Array<{ portId: string; kind: string }>
  /** headless 执行的完整公开输出（按公开端口 ID 的 NodeValue）；画布执行为 null。 */
  outputValues: Record<string, unknown> | null
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
  parent_run_id: string | null
  status: string
  started_at: number
  finished_at: number | null
  error_code: string | null
  error_message: string | null
  failure_phase: string | null
  failure_node_id: string | null
  failure_port_id: string | null
  output_summary: string | null
  output_values: string | null
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

function parseOutputSummary(value: string | null): Array<{ portId: string; kind: string }> {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is { portId: string; kind: string } =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as { portId?: unknown }).portId === 'string' &&
          typeof (item as { kind?: unknown }).kind === 'string'
      )
      .slice(0, 32)
  } catch {
    return []
  }
}

function parseOutputValues(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function rowToRun(row: RunRow): CompositeRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    capabilityId: row.capability_id,
    capabilityVersion: row.capability_version,
    contentHash: row.content_hash,
    instanceNodeId: row.instance_node_id,
    parentRunId: row.parent_run_id ?? null,
    status: row.status as CompositeRunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failurePhase: row.failure_phase ?? null,
    failureNodeId: row.failure_node_id ?? null,
    failurePortId: row.failure_port_id ?? null,
    outputSummary: parseOutputSummary(row.output_summary),
    outputValues: parseOutputValues(row.output_values),
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
  parentRunId?: string
}): CompositeRunRecord {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO composite_runs
       (id, project_id, capability_id, capability_version, content_hash,
        instance_node_id, parent_run_id, status, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
    )
    .run(
      input.id,
      input.projectId,
      input.capabilityId,
      input.capabilityVersion,
      input.contentHash,
      input.instanceNodeId ?? null,
      input.parentRunId ?? null,
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
  status: Extract<
    CompositeRunStatus,
    'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'
  >
  errorCode?: string
  errorMessage?: string
  failurePhase?: string
  /** W4 失败定位：失败内部节点/端口 ID（只存 ID）。 */
  failureNodeId?: string
  failurePortId?: string
  outputPorts?: Array<{ portId: string; kind: string }>
  outputValues?: Record<string, unknown>
}): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE composite_runs SET status = ?, finished_at = ?, error_code = ?, error_message = ?,
           failure_phase = ?, failure_node_id = ?, failure_port_id = ?, output_summary = ?, output_values = ?
         WHERE id = ? AND status IN ('accepted','running','waiting-input')`
      )
      .run(
        input.status,
        Date.now(),
        input.errorCode ?? null,
        input.errorMessage?.slice(0, 500) ?? null,
        input.failurePhase?.slice(0, 40) ?? null,
        input.failureNodeId?.slice(0, 120) ?? null,
        input.failurePortId?.slice(0, 120) ?? null,
        input.outputPorts?.length ? JSON.stringify(input.outputPorts.slice(0, 32)) : null,
        input.outputValues ? JSON.stringify(input.outputValues) : null,
        input.runId
      ).changes > 0
  )
}

export function getCompositeRun(runId: string): {
  run: CompositeRunRecord
  steps: CompositeRunStepRecord[]
} | null {
  const row = getDb().prepare('SELECT * FROM composite_runs WHERE id = ?').get(runId) as
    RunRow | undefined
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
