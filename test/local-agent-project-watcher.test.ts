import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  watchers: [] as Array<{
    close: ReturnType<typeof vi.fn>
    error?: () => void
    on: ReturnType<typeof vi.fn>
  }>,
  unavailable: false,
  events: [] as any[]
}))
vi.mock('fs', () => ({
  existsSync: () => true,
  readFileSync: () => JSON.stringify({ meta: { graphVersion: 0 } }),
  watch: () => {
    if (state.unavailable) throw Error('private watch path')
    const watcher = { close: vi.fn(), on: vi.fn() } as (typeof state.watchers)[number]
    watcher.on.mockImplementation((event: string, callback: () => void) => {
      if (event === 'error') watcher.error = callback
      return watcher
    })
    state.watchers.push(watcher)
    return watcher
  }
}))
vi.mock('../src/main/store/db', () => ({ getProjectsDir: () => '/isolated-fixture' }))
vi.mock('../src/main/diagnostics/ipc-domain-events', () => ({
  emitDomainEvent: (...args: any[]) => state.events.push(args)
}))
import { ProjectFileWatcher } from '../src/main/ipc/project-watcher'
beforeEach(() => {
  state.watchers = []
  state.unavailable = false
  state.events = []
})
describe('desktop ownership survives file watcher failure', () => {
  it('retains an open project claim when the watch stream fails, until explicit close', () => {
    const watcher = new ProjectFileWatcher(() => null)
    watcher.startWatching('open-project')
    state.watchers[0].error?.()
    expect(watcher.isWatching).toBe(false)
    expect(watcher.activeProjectId).toBe('open-project')
    expect(state.events[0]).toMatchObject([
      'project.watch.failed',
      expect.any(String),
      {
        context: { projectId: 'open-project' },
        attributes: { phase: 'watch', code: 'WATCH_UNAVAILABLE' }
      }
    ])
    watcher.stopWatching()
    expect(watcher.activeProjectId).toBeNull()
  })
  it('retains the claim when filesystem watching cannot start', () => {
    state.unavailable = true
    const watcher = new ProjectFileWatcher(() => null)
    watcher.startWatching('open-project')
    expect(watcher.activeProjectId).toBe('open-project')
    expect(watcher.isWatching).toBe(false)
    expect(JSON.stringify(state.events)).not.toContain('private watch path')
    watcher.stopWatching()
  })
  it('ignores a late failure from a previously closed watcher', () => {
    const watcher = new ProjectFileWatcher(() => null)
    watcher.startWatching('old-project')
    const old = state.watchers[0]
    watcher.startWatching('new-project')
    old.error?.()
    expect(watcher.activeProjectId).toBe('new-project')
    expect(watcher.isWatching).toBe(true)
    expect(state.watchers[1].close).not.toHaveBeenCalled()
    watcher.stopWatching()
  })
})
