import { beforeEach, expect, it, vi } from 'vitest'
import type { DiagnosticsEventInput } from '../src/shared/observability'
import { IPC } from '../src/shared/contracts'

const fixture = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), fail: false }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => fixture.handlers.set(name, handler) }, dialog: {}, clipboard: {}, shell: {}, app: { getPath: () => '', getAppPath: () => '' } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/store/media.repo', () => ({
  saveBufferAsset: async () => {
    if (fixture.fail) throw new Error('private attachment filename')
    return { id: 'media-1', mime: 'image/png', path: 'projects/project-1/media/image.png' }
  },
  getMediaAbsPath: vi.fn(), importMedia: vi.fn(), listMedia: vi.fn(), deleteMedia: vi.fn()
}))
import { registerMediaIpc } from '../src/main/ipc/media.ipc'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

const events: DiagnosticsEventInput[] = []
beforeEach(() => {
  fixture.handlers.clear(); fixture.fail = false; events.length = 0
  setGatewayEventSink({ emit: event => { if (event) events.push(event) } })
  registerMediaIpc()
})
it('记录附件导入开始与完成，且日志不包含文件名或数据', async () => {
  const input = { projectId: 'project-1', mime: 'image/png', name: 'private attachment filename.png', data: new Uint8Array([1, 2, 3]) }
  const result = await fixture.handlers.get(IPC.media.importBuffer)!(null, input)
  expect(result.ok).toBe(true)
  expect(events.map(event => event.event)).toEqual(['media.buffer_import.started', 'media.buffer_import.completed'])
  expect(events[0].traceId).toBe(events[1].traceId)
  expect(JSON.stringify(events)).not.toContain('private attachment filename')
})
it('写入失败时产生失败终态，不泄露原始异常', async () => {
  fixture.fail = true
  const result = await fixture.handlers.get(IPC.media.importBuffer)!(null, { projectId: 'project-1', mime: 'image/png', data: new Uint8Array([1]) })
  expect(result).toMatchObject({ ok: false, error: { code: 'MEDIA_WRITE_FAILED' } })
  expect(events.map(event => event.event)).toEqual(['media.buffer_import.started', 'media.buffer_import.failed'])
  expect(JSON.stringify(events)).not.toContain('private attachment filename')
})
it('非法路径和空数据拒绝写入并记录失败', async () => {
  const result = await fixture.handlers.get(IPC.media.importBuffer)!(null, { projectId: '../other', mime: 'image/png', data: new Uint8Array([1]) })
  expect(result.ok).toBe(false)
  expect(events.map(event => event.event)).toEqual(['media.buffer_import.started', 'media.buffer_import.failed'])
})
it('日志不可用不会影响附件成功导入', async () => {
  setGatewayEventSink({ emit: () => { throw new Error('logger offline') } })
  const result = await fixture.handlers.get(IPC.media.importBuffer)!(null, { projectId: 'project-1', mime: 'image/png', data: new Uint8Array([1]) })
  expect(result.ok).toBe(true)
})
