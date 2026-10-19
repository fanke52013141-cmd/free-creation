import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticsEventInput } from '@shared/observability'
import { IPC } from '../../src/shared/contracts'
import { setGatewayEventSink } from '../../src/main/diagnostics/gateway-events'
import { initDiagnosticsService } from '../../src/main/diagnostics/service'
import { memoryFsStore } from '../../src/main/diagnostics/fs-types'

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  error: null as unknown,
  saved: { id: 'private-category-id', name: 'private-category-name', version: 2 },
  calls: 0
}))
vi.mock('electron', () => ({
  dialog: {},
  ipcMain: {
    handle: (key: string, handler: (...args: any[]) => any) => {
      state.handlers[key] = handler
    }
  }
}))
vi.mock('../../src/main/store/library-materialization.repo', () => ({
  materializeResource: vi.fn(),
  discardMaterialization: vi.fn()
}))
vi.mock('../../src/main/store/library.repo', () => ({}))
vi.mock('../../src/main/store/db', () => ({ getDataDir: () => '/unused' }))
vi.mock('../../src/main/store/library-categories.repo', () => ({
  listCategories: () => {
    state.calls++
    if (state.error) throw state.error
    return [state.saved]
  },
  saveCategory: (input: unknown) => {
    state.calls++
    if (state.error) throw state.error
    return input
  }
}))
import { registerLibraryIpc } from '../../src/main/ipc/library.ipc'

const events: DiagnosticsEventInput[] = []
beforeEach(() => {
  state.error = null
  state.calls = 0
  state.handlers = {}
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  registerLibraryIpc()
})
afterEach(() => setGatewayEventSink(null))

function invoke(operation: 'list' | 'save') {
  return state.handlers[
    operation === 'list' ? IPC.library.listCategories : IPC.library.saveCategory
  ]({}, state.saved)
}

describe('library category public IPC diagnostic lifecycle', () => {
  it.each(['list', 'save'] as const)(
    'pairs %s success and preserves its business result',
    (operation) => {
      expect(invoke(operation)).toEqual({
        ok: true,
        data: operation === 'list' ? [state.saved] : state.saved
      })
      expect(state.calls).toBe(1)
      expect(events.map((event) => event.event)).toEqual([
        'library.category.started',
        'library.category.completed'
      ])
      expect(events[0].traceId).toBeTruthy()
      expect(events[1]).toMatchObject({
        traceId: events[0].traceId,
        spanId: events[0].spanId,
        status: 'success',
        attributes: { operation }
      })
      expect(JSON.stringify(events)).not.toContain('private-category')
    }
  )

  it.each(['list', 'save'] as const)(
    'pairs %s failure without serializing repository details',
    (operation) => {
      state.error = new Error('private-category-body /private/database sk-private-secret')
      const result = invoke(operation)
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: operation === 'list' ? 'READ_FAILED' : 'SAVE_FAILED',
          message: (state.error as Error).message
        }
      })
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({
        event: 'library.category.failed',
        traceId: events[0].traceId,
        spanId: events[0].spanId,
        status: 'failed',
        attributes: { operation, phase: 'repository', code: result.error.code }
      })
      expect(JSON.stringify(events)).not.toMatch(
        /private-category|private\/database|sk-private-secret/
      )
    }
  )

  it.each(['list', 'save'] as const)(
    'keeps %s success and failure unchanged when the logger throws',
    (operation) => {
      setGatewayEventSink({
        emit: () => {
          throw new Error('private-sink-failure')
        }
      })
      expect(invoke(operation).ok).toBe(true)
      state.error = new Error('validation rejected')
      expect(invoke(operation)).toMatchObject({
        ok: false,
        error: { message: 'validation rejected' }
      })
      expect(state.calls).toBe(2)
    }
  )

  it('persists registered events with independent operation traces and no private metadata', async () => {
    const store = memoryFsStore()
    const service = await initDiagnosticsService({ dataDir: '/data', store, disableTimers: true })
    setGatewayEventSink(service)
    invoke('list')
    state.error = new Error('private-category-body')
    invoke('save')
    await service.flushNow()
    const result = await service.query({ limit: 10 })
    expect(result.events).toHaveLength(4)
    const starts = result.events.filter((event) => event.event === 'library.category.started')
    expect(new Set(starts.map((event) => event.traceId)).size).toBe(2)
    for (const start of starts) {
      const ends = result.events.filter(
        (event) => event.traceId === start.traceId && event.event !== 'library.category.started'
      )
      expect(ends).toHaveLength(1)
      expect(ends[0].spanId).toBe(start.spanId)
    }
    expect([...store.files.values()].join('\n')).not.toContain('private-category')
    expect(service.health().droppedTotal).toBe(0)
  })
})
