export type ProjectSavePhase =
  'read-snapshot' | 'write-tmp' | 'flush-tmp' | 'rotate-bak' | 'promote-tmp' | 'update-db'

/** Safe storage failure metadata; original paths, file contents and messages stay out of IPC/logs. */
export class ProjectSaveStorageError extends Error {
  readonly code = 'STORAGE_WRITE_FAILED'

  constructor(
    readonly phase: ProjectSavePhase,
    readonly backupUsed: boolean,
    readonly rollbackFailed: boolean,
    cause: unknown
  ) {
    const code = (cause as { code?: unknown } | null)?.code
    const allowed = new Set([
      'ENOSPC',
      'EIO',
      'EACCES',
      'EPERM',
      'EBUSY',
      'ENOENT',
      'SQLITE_FULL',
      'SQLITE_IOERR',
      'SQLITE_BUSY',
      'SQLITE_READONLY',
      'SQLITE_CONSTRAINT_TRIGGER',
      'SQLITE_ERROR'
    ])
    super('项目保存未完成，请检查磁盘空间或存储状态后重试', {
      cause:
        typeof code === 'string' && allowed.has(code)
          ? Object.assign(new Error('项目存储操作失败'), { code })
          : undefined
    })
    this.name = 'ProjectSaveStorageError'
  }
}

export function projectSaveFailureDiagnostics(error: unknown): {
  error: unknown
  attributes: { phase: string; backupUsed?: boolean; rollbackFailed?: boolean }
} {
  return {
    error,
    attributes:
      error instanceof ProjectSaveStorageError
        ? { phase: error.phase, backupUsed: error.backupUsed, rollbackFailed: error.rollbackFailed }
        : { phase: 'storage' }
  }
}
