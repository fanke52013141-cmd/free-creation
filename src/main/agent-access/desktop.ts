import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  ACCESS_DESKTOP_REQUEST,
  ACCESS_DESKTOP_REPLY,
  ACCESS_DESKTOP_COMMIT,
  DesktopReplySchema,
  DesktopCommitSchema,
  type DesktopRequest
} from '../../shared/agent-access/desktop'
import type { ProjectMeta } from '../../shared/types'

export class DesktopAccessError extends Error {
  constructor(
    readonly code: string,
    readonly unknownOutcome = false,
    readonly detail?: string,
    /** 版本冲突时宿主报告的当前图版本（结构化回传，客户端可直接用它重试）。 */
    readonly currentGraphVersion?: number
  ) {
    super(code)
  }
}
export interface DesktopAskResult {
  /** 人是否明确允许（false 也可能是拒绝或授权窗口超时）。 */
  authorized: boolean
  code?: string
  detail?: string
}
export interface AccessDesktop {
  run(
    input: Omit<DesktopRequest, 'requestId' | 'expiresAt'>,
    commit?: (version: number) => ProjectMeta,
    /**
     * 宿主执行窗口。编辑类请求用默认 10 秒即可；导演台发布要真实渲染/编码，
     * 短视频编码会超过 10 秒，必须显式放宽，否则会得到假的 DESKTOP_TIMEOUT。
     */
    timeoutMs?: number
  ): Promise<{ graphVersion: number; result?: unknown }>
  /**
   * 交互式请求：需要人亲眼确认的动作（导演台发布授权）。
   *
   * 它与 run 的关键区别是**不占用唯一写入槽**：人工确认可能需要几十秒到几分钟，
   * 长时间占用写入槽会把画布保存、执行等正常操作全部堵成 RESOURCE_BUSY，
   * 而且 mutation 请求的 10 秒过期时间也不适合人工步骤。回复仍走同一条
   * 受控回复通道，按 requestId 路由，并同样校验 sender/frame。
   */
  ask(
    input: Omit<DesktopRequest, 'requestId' | 'expiresAt'>,
    timeoutMs: number
  ): Promise<DesktopAskResult>
}
/** One bounded, sender-bound request. A late response cannot authorize another mutation. */
export function createAccessDesktop(getWindow: () => BrowserWindow | null): AccessDesktop {
  let pending: {
    request: DesktopRequest
    sender: BrowserWindow['webContents']
    commit?: (version: number) => ProjectMeta
    committed: boolean
    finish: (version?: number, error?: DesktopAccessError, result?: unknown) => void
  } | null = null
  const interactive = new Map<
    string,
    {
      request: DesktopRequest
      sender: BrowserWindow['webContents']
      timer: ReturnType<typeof setTimeout>
      settle: (result: DesktopAskResult) => void
    }
  >()
  const authorized = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    !!pending &&
    Date.now() < pending.request.expiresAt &&
    event.sender === pending.sender &&
    event.senderFrame === pending.sender.mainFrame
  ipcMain.on(ACCESS_DESKTOP_REPLY, (event, raw: unknown) => {
    const parsed = DesktopReplySchema.safeParse(raw)
    if (!parsed.success) return
    const reply = parsed.data
    // 交互式（人工授权）回复：按 requestId 路由，不影响正在进行的写入请求。
    const waiting = interactive.get(reply.requestId)
    if (waiting) {
      if (
        event.sender !== waiting.sender ||
        event.senderFrame !== waiting.sender.mainFrame ||
        reply.projectId !== waiting.request.projectId
      )
        return
      interactive.delete(reply.requestId)
      clearTimeout(waiting.timer)
      waiting.settle({
        authorized: reply.ok === true,
        ...(reply.errorCode ? { code: reply.errorCode } : {}),
        ...(reply.errorDetail ? { detail: reply.errorDetail } : {})
      })
      return
    }
    if (!authorized(event) || !pending) return
    if (
      reply.requestId !== pending.request.requestId ||
      reply.projectId !== pending.request.projectId
    )
      return
    if (!reply.ok || reply.graphVersion === undefined) {
      // validated=true：失败发生在任何变更之前；否则按 unknown 核对处理。
      pending.finish(
        undefined,
        new DesktopAccessError(
          reply.errorCode ?? 'DESKTOP_OPERATION_FAILED',
          reply.validated !== true,
          reply.errorDetail,
          // 版本冲突时把宿主看到的当前版本带上，客户端无需解析 detail 文本
          reply.errorCode === 'REVISION_CONFLICT' ? reply.graphVersion : undefined
        ),
        undefined
      )
    } else if (pending.commit && !pending.committed) {
      pending.finish(undefined, new DesktopAccessError('DESKTOP_OPERATION_FAILED'))
    } else pending.finish(reply.graphVersion, undefined, reply.result)
  })
  ipcMain.handle(ACCESS_DESKTOP_COMMIT, (event, raw: unknown) => {
    const parsed = DesktopCommitSchema.safeParse(raw)
    if (
      !authorized(event) ||
      !parsed.success ||
      !pending ||
      !pending.commit ||
      pending.committed ||
      parsed.data.requestId !== pending.request.requestId ||
      parsed.data.projectId !== pending.request.projectId
    )
      return { ok: false }
    try {
      const meta = pending.commit(parsed.data.graphVersion)
      pending.committed = true
      return { ok: true, meta }
    } catch {
      return { ok: false }
    }
  })
  return {
    run(input, commit, timeoutMs = 10000): Promise<{ graphVersion: number; result?: unknown }> {
      if (pending) return Promise.reject(new DesktopAccessError('RESOURCE_BUSY'))
      const window = getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed())
        return Promise.reject(new DesktopAccessError('DESKTOP_UNAVAILABLE'))
      return new Promise((resolve, reject) => {
        const sender = window.webContents
        const bounded = Math.max(1000, Math.min(timeoutMs, 5 * 60 * 1000))
        const request = { ...input, requestId: randomUUID(), expiresAt: Date.now() + bounded }
        const lost = (): void => finish(undefined, new DesktopAccessError('DESKTOP_LOST', true))
        const timer = setTimeout(
          () => finish(undefined, new DesktopAccessError('DESKTOP_TIMEOUT', true)),
          bounded
        )
        const finish = (version?: number, error?: DesktopAccessError, result?: unknown): void => {
          clearTimeout(timer)
          sender.off('render-process-gone', lost)
          sender.off('destroyed', lost)
          pending = null
          if (error) reject(error)
          else resolve({ graphVersion: version!, ...(result !== undefined ? { result } : {}) })
        }
        pending = { request, sender, commit, committed: false, finish }
        sender.once('render-process-gone', lost)
        sender.once('destroyed', lost)
        try {
          sender.send(ACCESS_DESKTOP_REQUEST, request)
        } catch {
          lost()
        }
      })
    },
    ask(input, timeoutMs): Promise<DesktopAskResult> {
      const window = getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed())
        return Promise.reject(new DesktopAccessError('DESKTOP_UNAVAILABLE'))
      const bounded = Math.max(1000, Math.min(timeoutMs, 10 * 60 * 1000))
      const request: DesktopRequest = {
        ...input,
        requestId: randomUUID(),
        expiresAt: Date.now() + bounded
      }
      return new Promise((resolve) => {
        const sender = window.webContents
        let settled = false
        function settle(result: DesktopAskResult): void {
          if (settled) return
          settled = true
          clearTimeout(timer)
          // 交互式请求可能持续数分钟：结算时必须摘掉监听，否则每次申请都留下
          // 一对 render-process-gone/destroyed 监听器，长会话会持续增长。
          sender.off('render-process-gone', lost)
          sender.off('destroyed', lost)
          interactive.delete(request.requestId)
          resolve(result)
        }
        function lost(): void {
          if (!interactive.has(request.requestId)) return
          clearTimeout(timer)
          settle({ authorized: false, code: 'DESKTOP_LOST' })
        }
        const timer = setTimeout(() => {
          settle({ authorized: false, code: 'PUBLISH_AUTHORIZATION_EXPIRED' })
        }, bounded)
        interactive.set(request.requestId, { request, sender, timer, settle })
        sender.once('render-process-gone', lost)
        sender.once('destroyed', lost)
        try {
          sender.send(ACCESS_DESKTOP_REQUEST, request)
        } catch {
          lost()
        }
      })
    }
  }
}
