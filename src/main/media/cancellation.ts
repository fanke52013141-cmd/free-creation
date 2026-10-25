// 本地媒体作业取消注册表（P1-A 运行中停止）。
//
// 媒体 IPC 处理器用 runWithMediaScope(projectId, nodeId, fn) 包住一次变换；
// 作用域内 runFfmpeg/runProcess 注册子进程终止句柄，拆分循环轮询取消标记。
// 渲染器停止工作流时调用 cancelMediaJobs(projectId, nodeId)：
// 终止信号发出后，进行中的变换以 MEDIA_TRANSFORM_CANCELLED 稳定失败，
// 已落盘的半成品沿各变换自己的回滚规则清理。
import { AsyncLocalStorage } from 'node:async_hooks'

export const MEDIA_TRANSFORM_CANCELLED = 'MEDIA_TRANSFORM_CANCELLED'

interface MediaJobScope {
  kills: Set<() => void>
  cancelled: boolean
}

const scopes = new Map<string, MediaJobScope>()
const current = new AsyncLocalStorage<string>()

export function mediaScopeKey(projectId: string | undefined, nodeId: string | undefined): string | null {
  if (!projectId || !nodeId) return null
  return `${projectId}/${nodeId}`
}

/** 在可取消作用域内执行一次媒体变换；key 为 null 时保持不可取消的旧行为。 */
export async function runWithMediaScope<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn()
  let scope = scopes.get(key)
  if (!scope) {
    scope = { kills: new Set(), cancelled: false }
    scopes.set(key, scope)
  }
  try {
    return await current.run(key, fn)
  } finally {
    // 同一节点由资源队列保证串行；计数归零才移除，防止终止信号错过窗口。
    const live = scopes.get(key)
    if (live && live.kills.size === 0) scopes.delete(key)
  }
}

/** 作用域内注册一个终止句柄（通常是 child.kill）。返回解除注册函数。 */
export function trackMediaJob(kill: () => void): () => void {
  const key = current.getStore()
  if (!key) return () => undefined
  const scope = scopes.get(key)
  if (!scope) return () => undefined
  scope.kills.add(kill)
  return () => {
    scope.kills.delete(kill)
  }
}

/** 作用域内的变换查询是否已被停止；拆分等分段循环在每个单元之间检查。 */
export function isMediaCancelled(): boolean {
  const key = current.getStore()
  if (!key) return false
  return scopes.get(key)?.cancelled ?? false
}

/** 终止该节点名下仍在执行的本地媒体作业，返回收到信号的作业数量。 */
export function cancelMediaJobs(key: string | null): number {
  if (!key) return 0
  const scope = scopes.get(key)
  if (!scope) return 0
  scope.cancelled = true
  const kills = [...scope.kills]
  scope.kills.clear()
  for (const kill of kills) {
    try {
      kill()
    } catch {
      // 终止单个作业失败不阻断其余作业；进程退出后按普通失败收尾。
    }
  }
  return kills.length
}
