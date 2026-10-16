import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSaveStorageError } from '../src/main/store/project-save-error'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  error: null as unknown
}))
vi.mock('electron', () => ({
  ipcMain: {
    on: (name: string, callback: (...args: any[]) => any) => {
      state.handlers[name] = callback
    },
    handle: (name: string, callback: (...args: any[]) => any) => {
      state.handlers[name] = callback
    }
  },
  dialog: {}
}))
vi.mock('../src/main/store/db', () => ({ getSetting: () => null, setSetting: () => {} }))
vi.mock('../src/main/ipc/project-watcher', () => ({ ProjectFileWatcher: class {} }))
vi.mock('../src/main/store/transfer', () => ({ exportProject: () => {}, importProject: () => {} }))
vi.mock('../src/main/store/canvas-structure-transfer', () => ({
  exportCanvasStructure: () => {},
  importCanvasStructure: () => {}
}))
vi.mock('../src/main/store/projects.repo', () => ({
  saveProject: () => {
    if (state.error) throw state.error
    return { graphVersion: 1 }
  },
  saveWorkspaceProfile: () => {
    if (state.error) throw state.error
    return { graphVersion: 1 }
  }
}))
import { registerProjectIpc } from '../src/main/ipc/project.ipc'
import { IPC } from '../src/shared/contracts'

const events: any[] = []
beforeEach(() => {
  state.handlers = {}
  state.error = null
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  registerProjectIpc()
})
afterEach(() => setGatewayEventSink(null))
function invoke(kind: 'async' | 'sync' | 'workspace') {
  const event = { returnValue: undefined as unknown }
  if (kind === 'sync') {
    state.handlers[IPC.project.saveSync](event, { id: 'project' })
    return event.returnValue
  }
  return kind === 'async'
    ? state.handlers[IPC.project.save](event, { id: 'project' })
    : state.handlers[IPC.project.saveWorkspaceProfile](event, {
        projectId: 'project',
        workspaceProfile: { schemaVersion: 1 }
      })
}
describe('R09 save failure diagnostics at public IPC boundaries', () => {
  it.each(['async', 'sync', 'workspace'] as const)(
    'reports %s flush failure without leaking the OS message or returning success',
    (kind) => {
      state.error = new ProjectSaveStorageError(
        'flush-tmp',
        true,
        false,
        Object.assign(new Error('private-flush /private/snapshot'), { code: 'EIO' })
      )
      expect(invoke(kind)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } })
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({
        event: 'project.save.failed',
        traceId: events[0].traceId,
        spanId: events[0].spanId,
        attributes: { phase: 'flush-tmp', backupUsed: true, rollbackFailed: false },
        error: { code: 'STORAGE_WRITE_FAILED', causeCode: 'EIO' }
      })
      expect(JSON.stringify(events)).not.toMatch(/private-flush|private\/snapshot/)
    }
  )
  it('records an unreadable snapshot as a failed read stage without fabricating a saved graph', () => {
    state.error = new ProjectSaveStorageError('read-snapshot', false, false, null)
    expect(invoke('async')).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      event: 'project.save.failed',
      attributes: { phase: 'read-snapshot', backupUsed: false },
      error: { code: 'STORAGE_WRITE_FAILED' }
    })
  })
  it.each(['async', 'sync', 'workspace'] as const)(
    'pairs %s storage failure with safe stage and cause',
    (kind) => {
      state.error = new ProjectSaveStorageError(
        'promote-tmp',
        true,
        true,
        Object.assign(new Error('private-key /private/snapshot/private-prompt'), { code: 'ENOSPC' })
      )
      expect(invoke(kind)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } })
      expect(events.map((event) => event.event)).toEqual([
        'project.save.started',
        'project.save.failed'
      ])
      expect(events[1]).toMatchObject({
        traceId: events[0].traceId,
        spanId: events[0].spanId,
        status: 'failed',
        error: { code: 'STORAGE_WRITE_FAILED', causeCode: 'ENOSPC' },
        attributes: { phase: 'promote-tmp', backupUsed: true, rollbackFailed: true }
      })
      expect(JSON.stringify(events)).not.toMatch(/private-key|private-prompt|private\/snapshot/)
    }
  )
  it('records one workspace success and keeps its graph version', () => {
    expect(invoke('workspace')).toEqual({ ok: true, data: { graphVersion: 1 } })
    expect(events.map((event) => event.event)).toEqual([
      'project.save.started',
      'project.save.completed'
    ])
    expect(events[1]).toMatchObject({
      attributes: { graphVersion: 1, operation: 'workspace-profile' }
    })
  })
  it('does not change success or failure results when the diagnostic sink throws', () => {
    setGatewayEventSink({
      emit: () => {
        throw new Error('diagnostic-storage-full')
      }
    })
    expect(invoke('async')).toMatchObject({ ok: true })
    state.error = new ProjectSaveStorageError('write-tmp', false, false, null)
    expect(invoke('sync')).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } })
  })
})
