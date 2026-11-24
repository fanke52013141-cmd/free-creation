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
  const claim = (): void => {
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
  }
  // 满载/多进程恢复时 WAL 写锁可能瞬时被占：SQLITE_BUSY 是等待信号，不是业务终态。
  // 有界重试 3 次（50/100ms）后仍抢不到才如实抛出，避免把「稍后再试」写成失败。
  for (let attempt = 0; ; attempt++) {
    try {
      claim()
      break
    } catch (error) {
      const busy = error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)
      if (!busy || attempt >= 2) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
    }
  }
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
