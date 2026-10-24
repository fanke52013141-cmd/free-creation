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
    readonly unknownOutcome = false
  ) {
    super(code)
  }
}
export interface AccessDesktop {
  run(
    input: Omit<DesktopRequest, 'requestId' | 'expiresAt'>,
    commit?: (version: number) => ProjectMeta
  ): Promise<number>
}
/** One bounded, sender-bound request. A late response cannot authorize another mutation. */
export function createAccessDesktop(getWindow: () => BrowserWindow | null): AccessDesktop {
  let pending: {
    request: DesktopRequest
    sender: BrowserWindow['webContents']
    commit?: (version: number) => ProjectMeta
    committed: boolean
    finish: (version?: number, error?: DesktopAccessError) => void
  } | null = null
  const authorized = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    !!pending &&
    Date.now() < pending.request.expiresAt &&
    event.sender === pending.sender &&
    event.senderFrame === pending.sender.mainFrame
  ipcMain.on(ACCESS_DESKTOP_REPLY, (event, raw: unknown) => {
    const parsed = DesktopReplySchema.safeParse(raw)
    if (!authorized(event) || !parsed.success || !pending) return
    const reply = parsed.data
    if (
      reply.requestId !== pending.request.requestId ||
      reply.projectId !== pending.request.projectId
    )
      return
    if (!reply.ok || reply.graphVersion === undefined) {
      pending.finish(undefined, new DesktopAccessError('DESKTOP_OPERATION_FAILED', true))
    } else if (pending.commit && !pending.committed) {
      pending.finish(undefined, new DesktopAccessError('DESKTOP_OPERATION_FAILED'))
    } else pending.finish(reply.graphVersion)
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
    run(input, commit): Promise<number> {
      if (pending) return Promise.reject(new DesktopAccessError('RESOURCE_BUSY'))
      const window = getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed())
        return Promise.reject(new DesktopAccessError('DESKTOP_UNAVAILABLE'))
      return new Promise((resolve, reject) => {
        const sender = window.webContents
        const request = { ...input, requestId: randomUUID(), expiresAt: Date.now() + 10000 }
        const lost = (): void => finish(undefined, new DesktopAccessError('DESKTOP_LOST', true))
        const timer = setTimeout(
          () => finish(undefined, new DesktopAccessError('DESKTOP_TIMEOUT', true)),
          10000
        )
        const finish = (version?: number, error?: DesktopAccessError): void => {
          clearTimeout(timer)
          sender.off('render-process-gone', lost)
          sender.off('destroyed', lost)
          pending = null
          if (error) reject(error)
          else resolve(version!)
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
    }
  }
}
