export type StoredNodeRunStatus = 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'

/** Shared recognition rule: malformed legacy records do not become execution facts. */
export function readStoredNodeRunStatus(value: unknown): StoredNodeRunStatus | null {
  if (!value || typeof value !== 'object') return null
  const record = value as {
    runId?: unknown
    status?: unknown
    startedAt?: unknown
    inputs?: unknown
  }
  if (
    typeof record.runId !== 'string' ||
    typeof record.status !== 'string' ||
    !['running', 'success', 'failed', 'skipped', 'cancelled'].includes(record.status) ||
    typeof record.startedAt !== 'number' ||
    !record.inputs ||
    typeof record.inputs !== 'object'
  )
    return null
  return record.status as StoredNodeRunStatus
}
