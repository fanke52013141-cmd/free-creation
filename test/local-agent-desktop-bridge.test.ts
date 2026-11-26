import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => ({
  on: new Map<string, (...args: any[]) => any>(),
  handle: new Map<string, (...args: any[]) => any>()
}))
const nativeDialog = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: any[]) => any) => ipc.on.set(channel, listener),
    handle: (channel: string, listener: (...args: any[]) => any) =>
      ipc.handle.set(channel, listener)
  },
  dialog: { showMessageBox: nativeDialog.show }
}))
import { createAccessDesktop } from '../src/main/agent-access/desktop'
import { ACCESS_DESKTOP_REPLY, ACCESS_DESKTOP_COMMIT } from '../src/shared/agent-access/desktop'
beforeEach(() => {
  ipc.on.clear()
  ipc.handle.clear()
  nativeDialog.show.mockReset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())
function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: contents
  })
  const desktop = createAccessDesktop(() => window as any)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const reply = (input: object, sender = event) => ipc.on.get(ACCESS_DESKTOP_REPLY)!(sender, input)
  return { contents, window, desktop, event, reply, request: () => contents.send.mock.calls[0][1] }
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
  // 协议早已升级为返回 { graphVersion, result? }（main 需要同时拿到版本与载荷），
  // 这里的旧断言还在等数字，属于测试没跟上实现——不是产品回退。
  await expect(result).resolves.toMatchObject({ graphVersion: 4 })
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
  await expect(result).resolves.toMatchObject({ graphVersion: 8 })
  expect(commit).toHaveBeenCalledTimes(1)
})
it('classifies renderer loss as unknown and releases the bounded request', async () => {
  const f = fixture(),
    result = f.desktop.run({ action: 'open', projectId: 'p' })
  f.contents.emit('render-process-gone')
  await expect(result).rejects.toMatchObject({ code: 'DESKTOP_LOST', unknownOutcome: true })
})

it('headless native confirmation works without an active canvas and never uses renderer replies', async () => {
  const f = fixture()
  nativeDialog.show.mockResolvedValue({ response: 0 })
  await expect(f.desktop.ask({
    action: 'confirm-sensitive',
    projectId: 'headless-run-1',
    headless: true,
    confirmText: '允许',
    cancelText: '拒绝'
  }, 1000)).resolves.toEqual({ authorized: true })
  expect(f.contents.send).not.toHaveBeenCalled()
})

it('headless timeout is final; a late native allow cannot change it', async () => {
  const f = fixture()
  let answer!: (value: { response: number }) => void
  nativeDialog.show.mockReturnValue(new Promise<{ response: number }>((resolve) => { answer = resolve }))
  const result = f.desktop.ask({
    action: 'confirm-sensitive', projectId: 'headless-run-1', headless: true
  }, 1000)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(result).resolves.toEqual({
    authorized: false,
    code: 'PUBLISH_AUTHORIZATION_EXPIRED'
  })
  answer({ response: 0 })
  await Promise.resolve()
  expect(nativeDialog.show).toHaveBeenCalledTimes(1)
})
