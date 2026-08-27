import './assets/app.css'

import { createRoot } from 'react-dom/client'
import type { RunLogEntry } from '@shared/contracts'
import { sanitizeText } from '@shared/sanitize'
import App from './App'
import { installBrowserMock } from './dev/browserMock'

if (import.meta.env.DEV) {
  installBrowserMock()
}

/**
 * 全局兜底：未被 try/catch 捕获的同步错误与 Promise 拒绝统一上报落盘。
 * 这些错误不属于工作流执行范畴，直接写入日志而非 engine store。
 */
function reportGlobalError(phase: string, message: string): void {
  try {
    const entry: RunLogEntry = {
      label: sanitizeText(message, 200),
      reason: sanitizeText(message, 500),
      phase,
      timestamp: Date.now()
    }
    window.api?.log?.write(entry)
  } catch {
    // 兜底中的兜底：静默
  }
}

window.addEventListener('error', (e) => {
  reportGlobalError('uncaught', e.message || String(e.error) || '未知错误')
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason)
  reportGlobalError('unhandled-rejection', reason)
})

// 不用 StrictMode：避免开发模式双挂载导致 tldraw onMount 触发两次
createRoot(document.getElementById('root')!).render(<App />)
