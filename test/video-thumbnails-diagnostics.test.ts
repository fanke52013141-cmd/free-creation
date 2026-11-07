import { beforeEach, expect, it, vi } from 'vitest'
import type { DiagnosticsEventInput } from '../src/shared/observability'
import { IPC } from '../src/shared/contracts'

const fixture = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), fail: false }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => fixture.handlers.set(name, handler) }, dialog: {}, clipboard: {}, shell: {}, app: { getPath: () => '', getAppPath: () => '' } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/media/video-transform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/media/video-transform')>(),
  generateVideoThumbnails: async () => {
    if (fixture.fail) throw new Error('private source path')
    return { thumbnails: ['data:image/jpeg;base64,private-data'] }
  }
}))
import { registerMediaIpc } from '../src/main/ipc/media.ipc'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

const events: DiagnosticsEventInput[] = []
beforeEach(() => {
  fixture.handlers.clear()
  fixture.fail = false
  events.length = 0
  setGatewayEventSink({ emit: event => { if (event) events.push(event) } })
  registerMediaIpc()
})

it('records correlated thumbnail completion without image content', async () => {
  const result = await fixture.handlers.get(IPC.media.videoThumbnails)!(null, { projectId: 'project-1', sourceMediaId: 'media-1', count: 10 })
  expect(result.ok).toBe(true)
  expect(events.map(event => event.event)).toEqual(['media.video_thumbnails.started', 'media.video_thumbnails.completed'])
  expect(events[0].traceId).toBe(events[1].traceId)
  expect(JSON.stringify(events)).not.toContain('private-data')
})

it('records failure stages without logging original errors', async () => {
  fixture.fail = true
  const result = await fixture.handlers.get(IPC.media.videoThumbnails)!(null, { projectId: 'project-1', sourceMediaId: 'media-1', count: 10 })
  expect(result.ok).toBe(false)
  expect(events.map(event => event.event)).toEqual(['media.video_thumbnails.started', 'media.video_thumbnails.failed'])
  expect(events[1].phase).toBe('generate')
  expect(JSON.stringify(events)).not.toContain('private source path')
  events.length = 0
  await fixture.handlers.get(IPC.media.videoThumbnails)!(null, {})
  expect(events[1].phase).toBe('input')
})

it('keeps thumbnail results when diagnostics are unavailable', async () => {
  setGatewayEventSink({ emit: () => { throw new Error('logger offline') } })
  const result = await fixture.handlers.get(IPC.media.videoThumbnails)!(null, { projectId: 'project-1', sourceMediaId: 'media-1', count: 10 })
  expect(result.ok).toBe(true)
})
