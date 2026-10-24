import { DiagnosticsProducer, newProducerId, newTraceId, newSpanId } from '@shared/observability'
import { emitDiagnosticsEvent } from './engine/diagnosticsReporter'
import { Component, useEffect, useState, type ReactNode } from 'react'
import { useAppStore } from './stores/app'
import { ProjectListPage } from './pages/ProjectListPage'
import { CanvasPage } from './pages/CanvasPage'
import { Toast } from './components/Toast'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ProviderSettingsPanel } from './gateway/ProviderSettingsPanel'
import { ModelCatalogPanel } from './gateway/ModelCatalogPanel'
import { ensureCanvasSaved } from './canvas/flow-asset-actions'
import { useEditorStore } from './stores/editor'
import { useSaveCoordinator } from './stores/save-coordinator'

type BootState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; message: string }

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(): void {
    const producer = new DiagnosticsProducer({
      process: 'renderer',
      producerId: newProducerId('renderer')
    })
    emitDiagnosticsEvent(
      producer.build(
        'application.render_failed',
        undefined,
        '渲染界面初始化失败',
        { traceId: newTraceId(), spanId: newSpanId() },
        { status: 'failed' }
      )
    )
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
  const setProjectOpenFailure = useAppStore((s) => s.setProjectOpenFailure)
  const [bootState, setBootState] = useState<BootState>({ kind: 'loading' })

  useEffect(() => {
    if (bootState.kind !== 'ready') return
    return window.api.onLocalAgentDesktopRequest?.((request) => {
      if (request.action !== 'open') return
      void (async () => {
        const before = useAppStore.getState().currentProject?.id
        const previousEditor = useEditorStore.getState().editor
        const previousSaver = useSaveCoordinator.getState().deps
        try {
          if (Date.now() >= request.expiresAt) throw new Error('REQUEST_EXPIRED')
          if (before) {
            if (!useEditorStore.getState().editor) throw new Error('CANVAS_NOT_READY')
            await ensureCanvasSaved()
          }
          if (useAppStore.getState().currentProject?.id !== before)
            throw new Error('CANVAS_CHANGED')
          if (Date.now() >= request.expiresAt) throw new Error('REQUEST_EXPIRED')
          const admission = await window.api.commitLocalAgentDesktop({
            requestId: request.requestId,
            projectId: request.projectId,
            graphVersion: 0
          })
          if (!admission.ok) throw new Error('PROJECT_SWITCH_NOT_ADMITTED')
          const result = await window.api.openProject(request.projectId)
          if (!result.ok || !result.data) throw new Error('PROJECT_OPEN_FAILED')
          if (
            Date.now() >= request.expiresAt ||
            useAppStore.getState().currentProject?.id !== before
          )
            throw new Error('CANVAS_CHANGED')
          useAppStore.getState().openProject(result.data.meta)
          const deadline = Math.min(Date.now() + 8000, request.expiresAt)
          while (true) {
            if (useAppStore.getState().currentProject?.id !== request.projectId)
              throw new Error('CANVAS_CHANGED')
            const coordinator = useSaveCoordinator.getState()
            if (
              useEditorStore.getState().editor &&
              (before === request.projectId ||
                useEditorStore.getState().editor !== previousEditor) &&
              coordinator.deps &&
              (before === request.projectId || coordinator.deps !== previousSaver) &&
              coordinator.phase === 'saved' &&
              document.querySelector(`[data-local-agent-project="${request.projectId}"]`)
            )
              break
            if (Date.now() > deadline) throw new Error('CANVAS_NOT_READY')
            await new Promise((done) => setTimeout(done, 20))
          }
          window.api.replyLocalAgentDesktop({
            requestId: request.requestId,
            projectId: request.projectId,
            ok: true,
            graphVersion: result.data.meta.graphVersion
          })
        } catch {
          // project:open claims main-process ownership before the new canvas mounts.
          // If mounting/switching failed, align ownership with the view that remains visible.
          const visible = useAppStore.getState().currentProject?.id
          if (visible) await window.api.openProject(visible).catch(() => undefined)
          else await window.api.closeProject().catch(() => undefined)
          window.api.replyLocalAgentDesktop({
            requestId: request.requestId,
            projectId: request.projectId,
            ok: false
          })
        }
      })()
    })
  }, [bootState.kind])

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
          if (openRes.ok && openRes.data) {
            openProject(openRes.data.meta)
          } else {
            setProjectOpenFailure({ projectName: '上次打开的项目', failedAt: Date.now() })
          }
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
  }, [openProject, setProjectOpenFailure])

  if (bootState.kind === 'loading') return <div className="boot-screen">正在打开本地创作空间…</div>
  if (bootState.kind === 'failed') return <StartupFailure message={bootState.message} />

  if (view === 'canvas' && currentProject) {
    return <CanvasPage key={currentProject.id} projectId={currentProject.id} />
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
      <ModelCatalogPanel />
    </AppErrorBoundary>
  )
}
