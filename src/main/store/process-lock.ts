import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { GraphWriteInProgressError } from '../../shared/graph-snapshot-sync'

interface Owner {
  token: string
  pid: number
}
export interface ProcessLock {
  assertOwned(): void
  /** Cleanup and release use one immediate transaction, so no successor can
   * be acquired between ownership verification and legacy file cleanup. */
  release(cleanup?: () => void): void
}
function exited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
/** Persistent ownership, not a time-expiring lease: paused live processes cannot
 * be evicted. Immediate SQLite transactions only cover claim/release, never I/O
 * or network awaits. PID reuse conservatively delays recovery. */
export function acquireProcessLock(resource: string): ProcessLock {
  const db = getDb(),
    token = randomUUID()
  const read = (): Owner | undefined =>
    db.prepare('SELECT token,pid FROM process_locks WHERE resource=?').get(resource) as
      Owner | undefined
  db.transaction(() => {
    const owner = read()
    if (owner) {
      if (!exited(owner.pid)) throw new GraphWriteInProgressError()
      const changed = db
        .prepare('UPDATE process_locks SET token=?,pid=? WHERE resource=? AND token=? AND pid=?')
        .run(token, process.pid, resource, owner.token, owner.pid)
      if (changed.changes !== 1) throw new GraphWriteInProgressError()
    } else
      db.prepare('INSERT INTO process_locks (resource,token,pid) VALUES (?,?,?)').run(
        resource,
        token,
        process.pid
      )
  }).immediate()
  const assertOwned = (): void => {
    const owner = read()
    if (!owner || owner.token !== token || owner.pid !== process.pid)
      throw new GraphWriteInProgressError()
  }
  return {
    assertOwned,
    release(cleanup): void {
      db.transaction(() => {
        const owner = read()
        if (!owner || owner.token !== token || owner.pid !== process.pid) return
        cleanup?.()
        db.prepare('DELETE FROM process_locks WHERE resource=? AND token=?').run(resource, token)
      }).immediate()
    }
  }
}
