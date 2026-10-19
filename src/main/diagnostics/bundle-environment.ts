import { join } from 'node:path'
import type { DiagnosticsFileStore } from './fs-types'

/** Export only bounded runtime facts; never copy arbitrary session metadata. */
export function bundleEnvironment(value: unknown): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const env = value as Record<string, unknown>
  for (const key of ['appVersion', 'electron', 'chromium', 'node']) {
    const version = env[key]
    if (typeof version === 'string' && /^\d[\dA-Za-z.+_-]{0,63}$/.test(version))
      result[key] = version
  }
  if (
    typeof env.platform === 'string' &&
    ['win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'aix', 'sunos', 'android'].includes(
      env.platform
    )
  )
    result.platform = env.platform
  if (
    typeof env.arch === 'string' &&
    [
      'x64',
      'arm64',
      'ia32',
      'arm',
      'ppc64',
      's390x',
      'riscv64',
      'loong64',
      'mips',
      'mipsel'
    ].includes(env.arch)
  )
    result.arch = env.arch
  if (typeof env.packaged === 'boolean') result.packaged = env.packaged
  if (typeof env.commit === 'string' && /^[a-f0-9]{7,40}$/i.test(env.commit))
    result.commit = env.commit
  return result
}

export async function bundleSessionEnvironments(
  store: DiagnosticsFileStore,
  sessionsDir: string,
  sessionIds: string[],
  current: { sessionId: string; env: unknown }
): Promise<{
  sessions: {
    sessionId: string
    environment: Record<string, string | boolean>
    environmentAvailable: boolean
  }[]
  omittedSessions: number
}> {
  // Current exporter is explicit even when a filtered bundle contains only older events.
  const ids = [...new Set([current.sessionId, ...sessionIds])]
  const sessions: {
    sessionId: string
    environment: Record<string, string | boolean>
    environmentAvailable: boolean
  }[] = []
  for (const sessionId of ids.slice(0, 128)) {
    let environment: Record<string, string | boolean> = {}
    if (sessionId === current.sessionId) environment = bundleEnvironment(current.env)
    else if (/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      try {
        const path = join(sessionsDir, `session-${sessionId}.json`)
        const stat = await store.stat(path)
        if (stat && stat.size <= 64 * 1024) {
          const state = JSON.parse(await store.readFile(path))
          if (state?.sessionId === sessionId) environment = bundleEnvironment(state.env)
        }
      } catch {
        // Missing, unreadable or damaged history must not prevent exporting events.
      }
    }
    sessions.push({
      sessionId,
      environment,
      environmentAvailable: Object.keys(environment).length > 0
    })
  }
  return { sessions, omittedSessions: Math.max(0, ids.length - sessions.length) }
}
