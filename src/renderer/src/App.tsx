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
import { useGatewayStore } from './stores/gateway'
import { runCompositeIsolated } from './composite/run-composite'
import type { ContractInputMap, NodeValuePacket } from '@shared/engine/inputs'
import type { NodeValue } from '@shared/engine/values'
import type { PortType } from '@shared/types'
import type { Editor } from 'tldraw'
import type { DesktopRequest } from '@shared/agent-access/desktop'

type BootState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; message: string }

/** NodeValue → 端口类型（headless 输入包构造用）。 */
function nodeValuePortType(value: NodeValue): PortType {
  switch (value.kind) {
    case 'text':
      return 'text'
    case 'markdown':
      return 'markdown'
    case 'json':
      return 'json'
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'file':
      return 'file'
    default:
      return 'any'
  }
}

/**
 * headless 节点流执行受理（脱离项目/画布）：立即回执释放 desktop 写入槽，
 * 隔离 editor 异步运行，终态与输出经运行台账（composite.run.get）回填。
 * 与画布执行共用 runCompositeIsolated，输出契约一致。
 */
async function handleHeadlessCompositeExecute(request: DesktopRequest): Promise<void> {
  const reply = (ok: boolean, errorCode?: string): void => {
    window.api.replyLocalAgentDesktop({
      requestId: request.requestId,
      projectId: request.projectId,
      ok,
      graphVersion: 0,
      ...(ok ? {} : { validated: true, ...(errorCode ? { errorCode } : {}) })
    })
  }
  try {
    if (Date.now() >= request.expiresAt) throw new Error('REQUEST_EXPIRED')
    const manifest = request.compositeManifest
    if (!manifest) throw new Error('MANIFEST_MISSING')
    await useGatewayStore.getState().load()
    const providers = useGatewayStore.getState().providers
    const runId = request.ownRunId ?? ''
    const inputs = new Map<string, NodeValuePacket[]>()
    for (const entry of request.compositeInputs ?? []) {
      const value = entry.value as NodeValue
      const packet: NodeValuePacket = {
        type: nodeValuePortType(value),
        value,
        source: { nodeId: 'headless-input', portId: entry.portId, runId },
        createdAt: Date.now()
      }
      const list = inputs.get(entry.portId) ?? []
      list.push(packet)
      inputs.set(entry.portId, list)
    }
    reply(true)
    void runCompositeIsolated(null as unknown as Editor, request.projectId, providers, {
      manifest,
      inputs: inputs as ContractInputMap,
      ownRunId: runId || undefined,
      headless: true,
      // W4 受控重试：公开输入值/重试链随运行创建原子落盘。
      inputValues: request.compositeInputValues,
      retryOf: request.compositeRetryOf,
      // AF-07：人工等待续跑——复用 runId、消费已满足提交、跳过已完成步骤。
      resumeRunId: request.compositeResumeRunId,
      humanSubmissions: request.compositeHumanSubmissions as
        | Record<string, { kind: 'text'; text: string } | { kind: 'json'; data: unknown }>
        | undefined,
      completedSteps: request.compositeCompletedSteps,
      stepOutputs: request.compositeStepOutputs as
        Record<string, { nodeResult: string | null; nodeRun: unknown }> | undefined
    }).catch(() => {
      // 失败已由 runCompositeIsolated 写入台账；此处仅兜底未捕获异常。
    })
  } catch (error) {
    reply(false, error instanceof Error ? error.message.slice(0, 80) : 'HEADLESS_EXECUTE_FAILED')
  }
}

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
      if (request.action === 'execute-composite-headless') {
        void handleHeadlessCompositeExecute(request)
        return
      }
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

  if (bootState.kind === 'loading') {
    return <div className="boot-screen" aria-busy="true" />
  }
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
