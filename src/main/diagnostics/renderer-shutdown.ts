import { DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS } from '@shared/observability'

export interface RendererDiagnosticsWindow {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    executeJavaScript(code: string): Promise<unknown>
  }
}

export const RENDERER_DIAGNOSTICS_DRAIN_SCRIPT = `(() => {
  const drain = window.__canvasDrainDiagnosticsForShutdown
  return typeof drain === 'function' ? drain() : { available: false, dropped: 0 }
})()`

function drainResultIsComplete(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const value = result as { available?: unknown; dropped?: unknown }
  if (value.available === false) return value.dropped === 0
  return value.available === true && value.dropped === 0
}

/** Ask a live renderer to drain its queue, bounded by the remaining app shutdown budget. */
export async function drainRendererDiagnostics(
  target: RendererDiagnosticsWindow,
  timeoutMs = DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS
): Promise<boolean> {
  if (target.isDestroyed() || target.webContents.isDestroyed()) return false

  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    const result = await Promise.race([
      target.webContents.executeJavaScript(RENDERER_DIAGNOSTICS_DRAIN_SCRIPT).then(
        drainResultIsComplete,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
      })
    ])
    return result
  } catch {
    return false
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}
