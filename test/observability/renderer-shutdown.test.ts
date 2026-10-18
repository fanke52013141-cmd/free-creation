import { describe, expect, it, vi } from 'vitest'
import {
  drainRendererDiagnostics,
  RENDERER_DIAGNOSTICS_DRAIN_SCRIPT,
  type RendererDiagnosticsWindow
} from '../../src/main/diagnostics/renderer-shutdown'

function rendererWindow(
  result: unknown | Promise<unknown>
): RendererDiagnosticsWindow & { executeJavaScript: ReturnType<typeof vi.fn> } {
  const executeJavaScript = vi.fn().mockReturnValue(Promise.resolve(result))
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      executeJavaScript
    },
    executeJavaScript
  }
}

describe('renderer diagnostics shutdown bridge', () => {
  it('asks the renderer to drain and succeeds after IPC acknowledgements settle', async () => {
    const target = rendererWindow({ available: true, dropped: 0 })

    await expect(drainRendererDiagnostics(target)).resolves.toBe(true)

    expect(target.executeJavaScript).toHaveBeenCalledWith(RENDERER_DIAGNOSTICS_DRAIN_SCRIPT)
  })

  it('treats an unloaded reporter as an empty renderer queue', async () => {
    await expect(drainRendererDiagnostics(rendererWindow({ available: false, dropped: 0 }))).resolves.toBe(
      true
    )
  })

  it('fails if the renderer reports dropped diagnostics or an invalid result', async () => {
    await expect(drainRendererDiagnostics(rendererWindow({ available: true, dropped: 2 }))).resolves.toBe(
      false
    )
    await expect(drainRendererDiagnostics(rendererWindow({ available: true }))).resolves.toBe(false)
  })

  it('fails when executeJavaScript rejects or the window is already destroyed', async () => {
    const rejected = rendererWindow(Promise.reject(new Error('renderer unavailable')))
    await expect(drainRendererDiagnostics(rejected)).resolves.toBe(false)

    const destroyed = rendererWindow({ available: true, dropped: 0 })
    destroyed.isDestroyed = () => true
    await expect(drainRendererDiagnostics(destroyed)).resolves.toBe(false)
    expect(destroyed.executeJavaScript).not.toHaveBeenCalled()
  })

  it('fails when renderer drain exceeds the shutdown budget', async () => {
    vi.useFakeTimers()
    try {
      const target = rendererWindow(new Promise(() => undefined))
      const draining = drainRendererDiagnostics(target, 25)

      await vi.advanceTimersByTimeAsync(25)

      await expect(draining).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
