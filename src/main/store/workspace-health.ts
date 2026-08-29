import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
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
