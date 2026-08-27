import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import type { RunLogEntry } from '@shared/contracts'
import { sanitizeText } from '@shared/sanitize'
import { useAppStore } from './stores/app'
import { ProjectListPage } from './pages/ProjectListPage'
import { CanvasPage } from './pages/CanvasPage'
import { Toast } from './components/Toast'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ProviderSettingsPanel } from './gateway/ProviderSettingsPanel'

/**
 * React 渲染层兜底：捕获子树渲染异常，上报落盘并显示友好恢复界面，
 * 避免整个应用白屏不可用。
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean; message: string } {
    return { hasError: true, message: error.message || '未知错误' }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      const entry: RunLogEntry = {
        label: sanitizeText(error.message || 'React 渲染错误', 200),
        reason: sanitizeText(`${error.stack ?? error.message}\n${info.componentStack ?? ''}`, 1000),
        phase: 'react-error',
        timestamp: Date.now()
      }
      window.api?.log?.write(entry)
    } catch {
      // 静默
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            gap: 16,
            fontFamily: 'system-ui, sans-serif',
            color: '#e0e0e0',
            background: '#1a1a2e'
          }}
        >
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>应用遇到严重错误</h2>
          <p style={{ maxWidth: 480, textAlign: 'center', opacity: 0.7, fontSize: 14 }}>
            {this.state.message}
          </p>
          <button
            onClick={() => location.reload()}
            style={{
              padding: '8px 24px',
              borderRadius: 8,
              border: 'none',
              background: '#6366f1',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 14
            }}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function Content(): React.JSX.Element {
  const view = useAppStore((s) => s.view)
  const currentProject = useAppStore((s) => s.currentProject)
  const openProject = useAppStore((s) => s.openProject)
  const [booted, setBooted] = useState(false)

  // 启动恢复：上次打开的项目直接进画布（M0 出口标准）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.api.bootstrap()
      if (cancelled) return
      if (res.ok && res.data.lastProjectId) {
        const openRes = await window.api.openProject(res.data.lastProjectId)
        if (openRes.ok && openRes.data) {
          openProject(openRes.data.meta)
        }
      }
      setBooted(true)
    })()
    return () => {
      cancelled = true
    }
  }, [openProject])

  if (!booted) {
    return <div className="boot-screen">加载中…</div>
  }

  if (view === 'canvas' && currentProject) {
    return <CanvasPage projectId={currentProject.id} />
  }
  return <ProjectListPage />
}

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <Content />
      <Toast />
      <ConfirmDialog />
      <ProviderSettingsPanel />
    </ErrorBoundary>
  )
}
