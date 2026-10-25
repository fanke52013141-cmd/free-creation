// 本地媒体变换的运行中取消（P1-A）。
//
// 停止工作流时，已经发到主进程的本地媒体调用（ffmpeg 截取/取帧/提音、
// 宫格拆分循环）不会自己结束：旧行为是渲染器丢弃结果、主进程继续跑完并
// 把迟到资产落库。这里给执行器一个统一的竞速包装：取消一旦发生，
// 立即通过 gateway.cancelMediaTransforms 请求主进程终止该节点名下的
// 本地作业，并把本次调用按「已取消」处理；迟到信封可按需清理孤儿资产。
import type { NodeExecutionContext } from './executor-types'

/** 主进程终止本地媒体作业后返回的稳定错误码；信封 error.code 使用。 */
export const MEDIA_TRANSFORM_CANCELLED = 'MEDIA_TRANSFORM_CANCELLED'

export type CancellableMediaOutcome<T> =
  | { cancelled: true }
  | { cancelled: false; value: T }

interface MediaCancelGateway {
  cancelMediaTransforms?: (input: { projectId: string; nodeId: string }) => Promise<unknown>
}

/**
 * 把一次本地媒体 IPC 与节点取消竞速。
 *
 * - 未取消时等价于直接 `await call()`；
 * - 取消后返回 `{ cancelled: true }`，同时请求主进程终止该节点名下的作业；
 *   原始 promise 的迟到结果/拒绝已挂处理器，不会产生 unhandledrejection。
 * - signal 不支持 onCancel（单测最小 mock、旧宿主）时保持旧行为：
 *   等 IPC 返回后按 signal.cancelled 丢弃结果，不发终止请求。
 *
 * `onLateArtifact` 在取消路径收到主进程仍成功返回的信封（尽力而为）——
 * 同步渲染（裁剪/拆分单格）无法中断，调用方可据此删除已落盘的迟到资产，
 * 避免媒体库里留下与任何节点无关的孤儿。
 */
export async function runCancellableMedia<T>(
  ctx: Pick<NodeExecutionContext, 'signal' | 'node' | 'projectId'> & { gateway: MediaCancelGateway },
  call: () => Promise<T>,
  onLateArtifact?: (envelope: T) => void
): Promise<CancellableMediaOutcome<T>> {
  const { signal, node, projectId, gateway } = ctx
  if (signal.cancelled) return { cancelled: true }
  const cancelJobs = (): void => {
    void gateway.cancelMediaTransforms?.({ projectId, nodeId: node.id }).catch(() => undefined)
  }
  const pending = call()
  if (typeof signal.onCancel !== 'function') {
    // 无取消订阅能力：保持旧行为，返回后按 signal.cancelled 丢弃，不请求终止。
    const value = await pending
    if (signal.cancelled) return { cancelled: true }
    return { cancelled: false, value }
  }
  let rejectCancelled: ((error: Error) => void) | null = null
  const off = signal.onCancel(() => {
    cancelJobs()
    rejectCancelled?.(new Error(MEDIA_TRANSFORM_CANCELLED))
  })
  try {
    const value = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        if (signal.cancelled) {
          reject(new Error(MEDIA_TRANSFORM_CANCELLED))
          return
        }
        rejectCancelled = reject
      })
    ])
    // 竞速正常完成但 signal 恰好已取消（停止落在检查与完成之间的窗口）：
    // 按取消处理，信封交给 onLateArtifact 清理。
    if (signal.cancelled) {
      if (onLateArtifact) onLateArtifact(value)
      return { cancelled: true }
    }
    return { cancelled: false, value }
  } catch (error) {
    if (signal.cancelled || (error instanceof Error && error.message === MEDIA_TRANSFORM_CANCELLED)) {
      // 取消先于回调登记的极端窗口：这里也补一次终止请求，幂等。
      cancelJobs()
      if (onLateArtifact) {
        void pending.then((envelope) => onLateArtifact(envelope)).catch(() => undefined)
      }
      return { cancelled: true }
    }
    throw error
  } finally {
    off?.()
  }
}

/** 判断 IPC 信封是否是主进程返回的「本地媒体已取消」结果。 */
export function isMediaTransformCancelledEnvelope(envelope: unknown): boolean {
  return (
    typeof envelope === 'object' &&
    envelope !== null &&
    'ok' in envelope &&
    (envelope as { ok: boolean }).ok === false &&
    (envelope as { error?: { code?: string } }).error?.code === MEDIA_TRANSFORM_CANCELLED
  )
}
