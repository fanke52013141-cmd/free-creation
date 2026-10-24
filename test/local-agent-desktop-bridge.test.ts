import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => ({
  on: new Map<string, (...args: any[]) => any>(),
  handle: new Map<string, (...args: any[]) => any>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: any[]) => any) => ipc.on.set(channel, listener),
    handle: (channel: string, listener: (...args: any[]) => any) =>
      ipc.handle.set(channel, listener)
  }
}))
import { createAccessDesktop } from '../src/main/agent-access/desktop'
import { ACCESS_DESKTOP_REPLY, ACCESS_DESKTOP_COMMIT } from '../src/shared/agent-access/desktop'
beforeEach(() => {
  ipc.on.clear()
  ipc.handle.clear()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())
function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn()
  })
  const desktop = createAccessDesktop(
    () => ({ isDestroyed: () => false, webContents: contents }) as any
  )
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const reply = (input: object, sender = event) => ipc.on.get(ACCESS_DESKTOP_REPLY)!(sender, input)
  return { contents, desktop, event, reply, request: () => contents.send.mock.calls[0][1] }
}
it('accepts only matching main-frame sender, project and request', async () => {
  const f = fixture(),
    result = f.desktop.run({ action: 'flush', projectId: 'p' })
  const request = f.request()
  const payload = { requestId: request.requestId, projectId: 'p', ok: true, graphVersion: 4 }
  f.reply(payload, { ...f.event, senderFrame: {} })
  f.reply({ ...payload, projectId: 'other' })
  await expect(f.desktop.run({ action: 'open', projectId: 'p' })).rejects.toMatchObject({
    code: 'RESOURCE_BUSY'
  })
  f.reply(payload)
  await expect(result).resolves.toBe(4)
})
it('expires authorization and rejects late metadata commits after timeout', async () => {
  const f = fixture(),
    commit = vi.fn(),
    result = f.desktop.run({ action: 'rename', projectId: 'p', name: 'n' }, commit)
  const rejected = expect(result).rejects.toMatchObject({
    code: 'DESKTOP_TIMEOUT',
    unknownOutcome: true
  })
  const request = f.request()
  await vi.advanceTimersByTimeAsync(10000)
  await rejected
  expect(
    ipc.handle.get(ACCESS_DESKTOP_COMMIT)!(f.event, {
      requestId: request.requestId,
      projectId: 'p',
      graphVersion: 0
    })
  ).toEqual({ ok: false })
  expect(commit).not.toHaveBeenCalled()
})
it('commits once and waits for renderer version acknowledgement', async () => {
  const f = fixture(),
    commit = vi.fn(() => ({ id: 'p', name: 'n', graphVersion: 8 })),
    result = f.desktop.run({ action: 'rename', projectId: 'p', name: 'n' }, commit as any)
  const request = f.request(),
    payload = { requestId: request.requestId, projectId: 'p', graphVersion: 7 }
  expect(ipc.handle.get(ACCESS_DESKTOP_COMMIT)!(f.event, payload).ok).toBe(true)
  expect(ipc.handle.get(ACCESS_DESKTOP_COMMIT)!(f.event, payload).ok).toBe(false)
  f.reply({ ...payload, graphVersion: 8, ok: true })
  await expect(result).resolves.toBe(8)
  expect(commit).toHaveBeenCalledTimes(1)
})
it('classifies renderer loss as unknown and releases the bounded request', async () => {
  const f = fixture(),
    result = f.desktop.run({ action: 'open', projectId: 'p' })
  f.contents.emit('render-process-gone')
  await expect(result).rejects.toMatchObject({ code: 'DESKTOP_LOST', unknownOutcome: true })
})
