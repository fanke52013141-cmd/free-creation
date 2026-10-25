// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunTimeline } from '@renderer/canvas/RunTimeline'

let root: Root | undefined
let container: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

async function renderReply(data: unknown): Promise<void> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(window, { api: { queryDiagnostics: vi.fn(async () => data) } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(RunTimeline, { traceId: 'trace-local' })))
}

describe('local diagnostic timeline evidence', () => {
  it('keeps readable failure events while warning about truncation and damaged rows', async () => {
    await renderReply({
      ok: true,
      data: {
        events: [
          {
            eventId: 'e',
            timestamp: '2026-10-24T00:00:00Z',
            event: 'node.failed',
            level: 'error',
            message: '<script>private</script>'
          }
        ],
        truncated: true,
        badLines: 2
      }
    })
    expect(container.textContent).toContain('已截断')
    expect(container.textContent).toContain('跳过 2 条损坏记录')
    expect(container.querySelectorAll('li')).toHaveLength(1)
    expect(container.textContent).toContain('node.failed')
    expect(container.querySelector('script')).toBeNull()
  })
  it('shows no-coverage or unavailable states without claiming success', async () => {
    await renderReply({ ok: true, data: { events: [], truncated: false, badLines: 0 } })
    expect(container.textContent).toContain('未覆盖或已按保留策略清理')
    Object.assign(window, {
      api: {
        queryDiagnostics: async () => ({ ok: false, error: { code: 'DIAGNOSTICS_UNAVAILABLE' } })
      }
    })
    await act(async () => root!.render(createElement(RunTimeline, { traceId: 'trace-other' })))
    expect(container.textContent).toContain('DIAGNOSTICS_UNAVAILABLE')
    expect(container.textContent).not.toContain('成功')
  })
})
