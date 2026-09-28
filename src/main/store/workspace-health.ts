import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

export interface WorkspaceHealthReport {
  recoveredImports: string[]
  orphanedProjectIds: string[]
  temporaryFiles: string[]
}

export interface WorkspaceHealthInput {
  projectsDir: string
  projectIds: readonly string[]
  now?: number
}

/** downloadToTempFile 的临时文件前缀；任务失败路径漏删的残骸靠启动清扫兜底。 */
const VIDEO_TEMP_PREFIX = 'tmp-video-'
/** 只清超过 24 小时的残骸：并行实例可能正在写新的成片临时文件，不能误删。 */
const VIDEO_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 启动清扫数据根目录下超过 24 小时的 tmp-video-* 残骸。
 * 返回已删除的路径列表；目录不可读或单个文件被占用都不得阻断启动。
 */
export function sweepStaleVideoTempFiles(dataDir: string, now: number = Date.now()): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dataDir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of entries) {
    if (!name.startsWith(VIDEO_TEMP_PREFIX)) continue
    const path = join(dataDir, name)
    try {
      if (now - statSync(path).mtimeMs < VIDEO_TEMP_MAX_AGE_MS) continue
      unlinkSync(path)
      removed.push(path)
    } catch {
      // 单个文件被并行实例占用或已消失：跳过，不影响其余清扫
    }
  }
  return removed
}

/**
 * Reconciles interrupted import staging folders without deleting user data.
 * Staging folders are moved under `.recovery`, and every other anomaly is
 * only reported for later user-facing recovery tooling.
 */
export function reconcileWorkspace(input: WorkspaceHealthInput): WorkspaceHealthReport {
  const report: WorkspaceHealthReport = {
    recoveredImports: [],
    orphanedProjectIds: [],
    temporaryFiles: []
  }
  if (!existsSync(input.projectsDir)) return report

  let entries: string[]
  try {
    entries = readdirSync(input.projectsDir)
  } catch {
    return report
  }
  const recoveryDir = join(input.projectsDir, '.recovery')
  const timestamp = input.now ?? Date.now()
  for (const name of entries) {
    const path = join(input.projectsDir, name)
    let isDirectory = false
    try {
      isDirectory = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (name.endsWith('.importing') && isDirectory) {
      mkdirSync(recoveryDir, { recursive: true })
      let sequence = 0
      let destination = join(recoveryDir, `${name}-${timestamp}`)
      while (existsSync(destination))
        destination = join(recoveryDir, `${name}-${timestamp}-${++sequence}`)
      try {
        renameSync(path, destination)
        report.recoveredImports.push(destination)
      } catch {
        // A transient file lock must not prevent the app from starting.
        // Preserve the original directory and report it for a later retry.
        report.temporaryFiles.push(path)
      }
      continue
    }
    if (name === '.recovery' || !isDirectory) continue
    let children: string[]
    try {
      children = readdirSync(path)
    } catch {
      continue
    }
    for (const child of children) {
      if (child.endsWith('.tmp')) report.temporaryFiles.push(join(path, child))
    }
  }

  for (const projectId of input.projectIds) {
    if (!existsSync(join(input.projectsDir, projectId, 'project.json'))) {
      report.orphanedProjectIds.push(projectId)
    }
  }
  return report
}
