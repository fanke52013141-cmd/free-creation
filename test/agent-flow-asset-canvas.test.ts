import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSaveCoordinator } from '../src/renderer/src/stores/save-coordinator'
import { ensureCanvasSaved } from '../src/renderer/src/canvas/flow-asset-actions'
import { beginAssetPlacement } from '../src/renderer/src/canvas/flow-asset-diagnostics'
import type { DiagnosticsEventInput } from '../src/shared/observability'

const diagnostic = vi.hoisted(() => ({ events: [] as DiagnosticsEventInput[], fail: false }))
vi.mock('tldraw', () => ({ createShapeId: () => 'shape:fixed' }))
vi.mock('../src/renderer/src/nodes/registry', () => ({ getNodeType: () => null }))
vi.mock('../src/renderer/src/canvas/history', () => ({ markUndoPoint: () => {} }))
vi.mock('../src/renderer/src/engine/diagnosticsReporter', () => ({
  emitDiagnosticsEvent: (event: DiagnosticsEventInput): void => {
    if (diagnostic.fail) throw new Error('private-fake-secret')
    if (event) diagnostic.events.push(event)
  }
}))
function reset(): void {
  useSaveCoordinator.setState({
    phase: 'saved',
    dirtyVersion: 0,
    persistedVersion: 0,
    inFlight: false,
    savingFrom: -1,
    lastError: null,
    deps: null
  })
  diagnostic.events = []
  diagnostic.fail = false
}
afterEach(reset)

describe('asset submission waits for authoritative canvas save', () => {
  it('rejects unbound and paused saves', async () => {
    reset()
    await expect(ensureCanvasSaved()).rejects.toThrow('无法保存')
    useSaveCoordinator.setState({ phase: 'paused' })
    await expect(ensureCanvasSaved()).rejects.toThrow('无法保存')
  })
  it('does not resolve while an earlier save is in flight; waits for the next merged save', async () => {
    reset()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const save = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        return { graphVersion: 1 }
      })
      .mockResolvedValue({ graphVersion: 2 })
    useSaveCoordinator.getState().bind({ save, onConflict: vi.fn(), onFailure: vi.fn() })
    useSaveCoordinator.getState().markDirty()
    const prior = useSaveCoordinator.getState().flush()
    let settled = false
    const committed = ensureCanvasSaved().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
    release()
    await prior
    await committed
    expect(save).toHaveBeenCalledTimes(2)
    expect(useSaveCoordinator.getState().dirtyVersion).toBe(
      useSaveCoordinator.getState().persistedVersion
    )
  })
  it('surfaces save failures and conflicts instead of authorizing an asset from dirty state', async () => {
    reset()
    const onConflict = vi.fn()
    useSaveCoordinator.getState().bind({
      save: async () => {
        throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT' })
      },
      onConflict,
      onFailure: vi.fn()
    })
    await expect(ensureCanvasSaved()).rejects.toThrow('版本冲突')
    expect(onConflict).toHaveBeenCalledOnce()
    expect(useSaveCoordinator.getState().phase).not.toBe('saved')
  })
  it('allows a successful retry after an earlier save failure', async () => {
    reset()
    useSaveCoordinator.setState({ phase: 'failed', lastError: 'earlier failure' })
    useSaveCoordinator
      .getState()
      .bind({ save: async () => ({ graphVersion: 1 }), onConflict: vi.fn(), onFailure: vi.fn() })
    await ensureCanvasSaved()
    expect(useSaveCoordinator.getState().phase).toBe('saved')
  })
})

describe('asset placement diagnostics', () => {
  it('emits a correlated start and exactly one in-memory apply terminal without body', () => {
    reset()
    const finish = beginAssetPlacement('project-a', 'shape:a')
    finish(true)
    finish(false)
    expect(diagnostic.events.map((item) => item.event)).toEqual([
      'asset.placement.started',
      'asset.placement.applied'
    ])
    expect(diagnostic.events[0].traceId).toBe(diagnostic.events[1].traceId)
    expect(diagnostic.events[1].attributes).toEqual({ phase: 'canvas-apply' })
    expect(diagnostic.events[1].status).toBe('success')
  })
  it('diagnostic transport failures never change the canvas result', () => {
    reset()
    diagnostic.fail = true
    expect(() => {
      beginAssetPlacement('project-a', 'shape:a')(false)
    }).not.toThrow()
  })
})
