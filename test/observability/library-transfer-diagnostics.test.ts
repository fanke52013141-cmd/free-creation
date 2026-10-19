import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticsEventInput } from '@shared/observability'
import { IPC } from '../../src/shared/contracts'
import { setGatewayEventSink } from '../../src/main/diagnostics/gateway-events'
import { initDiagnosticsService } from '../../src/main/diagnostics/service'
import { memoryFsStore } from '../../src/main/diagnostics/fs-types'

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  selection: {
    canceled: false,
    filePath: undefined as string | undefined,
    filePaths: [] as string[]
  },
  dialogError: null as unknown,
  repoError: null as unknown,
  wait: null as Promise<void> | null,
  exporter: vi.fn(),
  importer: vi.fn()
}))
vi.mock('electron', () => {
  const choose = async () => {
    await state.wait
    if (state.dialogError) throw state.dialogError
    return state.selection
  }
  return {
    dialog: { showSaveDialog: choose, showOpenDialog: choose },
    ipcMain: {
      handle: (key: string, handler: (...args: any[]) => any) => {
        state.handlers[key] = handler
      }
    }
  }
})
vi.mock('../../src/main/store/library-materialization.repo', () => ({
  materializeResource: vi.fn(),
  discardMaterialization: vi.fn()
}))
vi.mock('../../src/main/store/library-categories.repo', () => ({
  listCategories: vi.fn(),
  saveCategory: vi.fn()
}))
vi.mock('../../src/main/store/library.repo', () => ({
  exportResourcePackage: state.exporter,
  importResourcePackage: state.importer
}))
vi.mock('../../src/main/store/db', () => ({ getDataDir: () => '/unused' }))
import { registerLibraryIpc } from '../../src/main/ipc/library.ipc'

const events: DiagnosticsEventInput[] = []
const secret = 'private-transfer-body /private/user-file sk-private-transfer'
beforeEach(() => {
  state.handlers = {}
  state.selection = {
    canceled: false,
    filePath: '/private/export.canvaslib',
    filePaths: ['/private/import.canvaslib']
  }
  state.dialogError = null
  state.repoError = null
  state.wait = null
  state.exporter.mockReset().mockImplementation((path) => {
    if (state.repoError) throw state.repoError
    return path
  })
  state.importer.mockReset().mockImplementation(() => {
    if (state.repoError) throw state.repoError
    return 2
  })
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  registerLibraryIpc()
})
afterEach(() => setGatewayEventSink(null))

type Operation = 'import' | 'export'
function invoke(operation: Operation) {
  return state.handlers[operation === 'export' ? IPC.library.export : IPC.library.import](
    {},
    { resourceIds: ['private-resource-id'] }
  )
}
function assertPair(operation: Operation, terminal: string) {
  expect(events.map((event) => event.event)).toEqual([
    'library.transfer.started',
    `library.transfer.${terminal}`
  ])
  expect(events[0].traceId).toBeTruthy()
  expect(events[1]).toMatchObject({
    traceId: events[0].traceId,
    spanId: events[0].spanId,
    attributes: { operation }
  })
  expect(JSON.stringify(events)).not.toMatch(/private-transfer|private-resource|\/private\//)
}

describe('asset package transfer public IPC diagnostics', () => {
  it.each(['import', 'export'] as const)(
    'preserves %s success and calls the repository exactly once',
    async (operation) => {
      expect(await invoke(operation)).toEqual({
        ok: true,
        data: operation === 'export' ? { path: '/private/export.canvaslib' } : { imported: 2 }
      })
      if (operation === 'export')
        expect(state.exporter).toHaveBeenCalledExactlyOnceWith('/private/export.canvaslib', [
          'private-resource-id'
        ])
      else expect(state.importer).toHaveBeenCalledExactlyOnceWith('/private/import.canvaslib')
      assertPair(operation, 'completed')
      expect(events[1].status).toBe('success')
    }
  )

  it.each(['import', 'export'] as const)(
    'records %s cancellation without calling the repository',
    async (operation) => {
      state.selection.canceled = true
      expect(await invoke(operation)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
      expect(state.exporter).not.toHaveBeenCalled()
      expect(state.importer).not.toHaveBeenCalled()
      assertPair(operation, 'cancelled')
      expect(events[1]).toMatchObject({ status: 'cancelled', attributes: { phase: 'dialog' } })
    }
  )

  it.each(['import', 'export'] as const)(
    'treats an empty %s selection as cancellation',
    async (operation) => {
      state.selection.filePath = undefined
      state.selection.filePaths = []
      expect(await invoke(operation)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
      assertPair(operation, 'cancelled')
      expect(state.exporter).not.toHaveBeenCalled()
      expect(state.importer).not.toHaveBeenCalled()
    }
  )

  it.each(['import', 'export'] as const)(
    'returns a controlled %s envelope for dialog failure',
    async (operation) => {
      state.dialogError = new Error(secret)
      expect(await invoke(operation)).toMatchObject({
        ok: false,
        error: { code: operation === 'export' ? 'EXPORT_FAILED' : 'IMPORT_FAILED', message: secret }
      })
      assertPair(operation, 'failed')
      expect(events[1]).toMatchObject({ status: 'failed', attributes: { phase: 'dialog' } })
      expect(state.exporter).not.toHaveBeenCalled()
      expect(state.importer).not.toHaveBeenCalled()
    }
  )

  it.each(['import', 'export'] as const)(
    'records %s repository failure without copying raw details',
    async (operation) => {
      state.repoError = new Error(secret)
      const result = await invoke(operation)
      expect(result).toMatchObject({ ok: false, error: { message: secret } })
      assertPair(operation, 'failed')
      expect(events[1]).toMatchObject({
        status: 'failed',
        attributes: { phase: 'repository', code: result.error.code }
      })
    }
  )

  it.each(['import', 'export'] as const)(
    'preserves all %s outcomes if the logger throws',
    async (operation) => {
      setGatewayEventSink({
        emit: () => {
          throw new Error('private-sink-failure')
        }
      })
      expect((await invoke(operation)).ok).toBe(true)
      state.selection.canceled = true
      expect(await invoke(operation)).toMatchObject({ error: { code: 'CANCELLED' } })
      state.selection.canceled = false
      state.dialogError = new Error('dialog failed')
      expect(await invoke(operation)).toMatchObject({
        ok: false,
        error: { message: 'dialog failed' }
      })
      state.dialogError = null
      state.repoError = new Error('repository failed')
      expect(await invoke(operation)).toMatchObject({
        ok: false,
        error: { message: 'repository failed' }
      })
    }
  )

  it('keeps an awaiting file dialog started without fabricating a terminal result', async () => {
    let release!: () => void
    state.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = invoke('export')
    expect(events.map((event) => event.event)).toEqual(['library.transfer.started'])
    expect(state.exporter).not.toHaveBeenCalled()
    release()
    await pending
    assertPair('export', 'completed')
  })

  it('serializes registered lifecycle events with independent traces and no raw paths or errors', async () => {
    const store = memoryFsStore()
    const service = await initDiagnosticsService({ dataDir: '/data', store, disableTimers: true })
    setGatewayEventSink(service)
    await invoke('export')
    state.repoError = new Error(secret)
    await invoke('import')
    state.selection.canceled = true
    await invoke('import')
    await service.flushNow()
    const result = await service.query({ limit: 20 })
    expect(result.events).toHaveLength(6)
    const starts = result.events.filter((event) => event.event === 'library.transfer.started')
    expect(new Set(starts.map((event) => event.traceId)).size).toBe(3)
    for (const start of starts)
      expect(
        result.events.filter(
          (event) => event.traceId === start.traceId && event.spanId === start.spanId
        )
      ).toHaveLength(2)
    expect([...store.files.values()].join('\n')).not.toMatch(
      /private-transfer|private-resource|\/private\//
    )
    expect(service.health().droppedTotal).toBe(0)
  })
})
