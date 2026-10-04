// 会话状态文件（LOGGING_SPEC.md §7/§9）：原子写（tmp + rename）。
// 启动时检测上次未正常结束，只说明事实，不补写假时间线。
import { join } from 'path'
import type { DiagnosticsFileStore } from './fs-types'

export interface DiagnosticsSessionState {
  sessionId: string
  startedAt: string
  ended: boolean
  endedAt?: string
  appVersion?: string
  /** 环境/构建标识快照（规范 §5：版本、平台、架构随 session 头保存）。 */
  env?: Record<string, string | number | boolean>
}

const SESSION_PREFIX = 'session-'
const SESSION_SUFFIX = '.json'

export function sessionStatePath(dir: string, sessionId: string): string {
  return join(dir, `${SESSION_PREFIX}${sessionId}${SESSION_SUFFIX}`)
}

/** 原子写会话状态：先写临时文件再 rename；失败不抛出到调用方业务路径。 */
export async function writeSessionState(
  store: DiagnosticsFileStore,
  dir: string,
  state: DiagnosticsSessionState
): Promise<boolean> {
  const finalPath = sessionStatePath(dir, state.sessionId)
  const tmpPath = `${finalPath}.tmp`
  try {
    await store.writeFile(tmpPath, JSON.stringify(state))
    await store.rename(tmpPath, finalPath)
    return true
  } catch {
    return false
  }
}

/** 列出尚未正常结束的历史会话（含当前实现无法识别的残缺文件）。 */
export async function findUncleanSessions(
  store: DiagnosticsFileStore,
  dir: string
): Promise<DiagnosticsSessionState[]> {
  let names: string[] = []
  try {
    names = await store.readdir(dir)
  } catch {
    return []
  }
  const unclean: DiagnosticsSessionState[] = []
  for (const name of names) {
    if (!name.startsWith(SESSION_PREFIX) || !name.endsWith(SESSION_SUFFIX)) continue
    try {
      const raw = await store.readFile(join(dir, name))
      const state = JSON.parse(raw) as Partial<DiagnosticsSessionState>
      if (typeof state.sessionId === 'string' && state.ended !== true) {
        unclean.push({
          sessionId: state.sessionId,
          startedAt: typeof state.startedAt === 'string' ? state.startedAt : '',
          ended: false
        })
      }
    } catch {
      // 残缺会话文件按未正常结束处理（只报告 sessionId 未知）。
      unclean.push({ sessionId: name, startedAt: '', ended: false })
    }
  }
  return unclean
}
