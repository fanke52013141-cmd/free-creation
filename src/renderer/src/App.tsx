import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { useAppStore } from './stores/app'
import { ProjectListPage } from './pages/ProjectListPage'
import { CanvasPage } from './pages/CanvasPage'
import { Toast } from './components/Toast'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ProviderSettingsPanel } from './gateway/ProviderSettingsPanel'

type BootState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; message: string }

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('渲染界面初始化失败', error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      return <StartupFailure message={`界面渲染失败：${this.state.error.message}`} />
    }
    return this.props.children
  }
}

function StartupFailure({ message }: { message: string }): React.JSX.Element {
  return (
    <main className="boot-screen boot-screen-error" role="alert">
      <section className="boot-card">
        <span className="boot-eyebrow">Canvas Studio</span>
        <h1>应用未能正常启动</h1>
        <p>{message}</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>
          重新尝试
        </button>
      </section>
    </main>
  )
}

function Content(): React.JSX.Element {
  const view = useAppStore((s) => s.view)
  const currentProject = useAppStore((s) => s.currentProject)
  const openProject = useAppStore((s) => s.openProject)
  const [bootState, setBootState] = useState<BootState>({ kind: 'loading' })

  // 启动恢复：上次打开的项目直接进画布（M0 出口标准）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await Promise.race([
          window.api.bootstrap(),
          new Promise<never>((_resolve, reject) =>
            window.setTimeout(() => reject(new Error('本地服务初始化超时，请重新尝试')), 10_000)
          )
        ])
        if (cancelled) return
        if (res.ok && res.data.lastProjectId) {
          const openRes = await window.api.openProject(res.data.lastProjectId)
          if (openRes.ok && openRes.data) openProject(openRes.data.meta)
        }
        setBootState({ kind: 'ready' })
      } catch (error) {
        if (!cancelled) {
          setBootState({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [openProject])

  if (bootState.kind === 'loading') return <div className="boot-screen">正在打开本地创作空间…</div>
  if (bootState.kind === 'failed') return <StartupFailure message={bootState.message} />

  if (view === 'canvas' && currentProject) {
    return <CanvasPage projectId={currentProject.id} />
  }
  return <ProjectListPage />
}

export default function App(): React.JSX.Element {
  return (
    <AppErrorBoundary>
      <Content />
      <Toast />
      <ConfirmDialog />
      <ProviderSettingsPanel />
    </AppErrorBoundary>
  )
}
