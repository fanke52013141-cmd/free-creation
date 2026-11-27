import { TopbarIconButton } from '../components/TopbarIconButton'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { useConfirmStore } from '../stores/confirm'
import { useToastStore } from '../stores/toast'
import { useSaveCoordinator } from '../stores/save-coordinator'
import type { DiagnosticsEventInput } from '@shared/observability'
import { drainDiagnosticsEvents, emitDiagnosticsEvent } from '../engine/diagnosticsReporter'
import { Icon } from '../components/Icon'
import { ModalShell } from '../components/ModalShell'
import { modalBtn } from '../components/modal-btn'
import { ProjectCreateDialog } from '../components/ProjectCreateDialog'
import { ResourceLibraryPage } from '../library/ResourceLibraryPage'
import { buildExternalAgentBrief } from '../lib/external-agent-brief'
import freeCreationLogo from '../assets/free-creation-logo.png'
import './project-list-page.css'

function formatDate(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function ProjectListPage(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [cloning, setCloning] = useState<ProjectMeta | null>(null)
  const [cloneName, setCloneName] = useState('')
  const [cloneBusy, setCloneBusy] = useState(false)
  const cloneInputRef = useRef<HTMLInputElement>(null)
  const [cloneError, setCloneError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const openProject = useAppStore((s) => s.openProject)
  const openModelSettings = useGatewayStore((s) => s.openSettings)
  const projectOpenFailure = useAppStore((s) => s.projectOpenFailure)
  const clearProjectOpenFailure = useAppStore((s) => s.clearProjectOpenFailure)

  // ── 开发模式专属：主页顶栏「重载」按钮（固定放「新建项目」左侧） ──
  // 改完渲染层代码后一键生效，免去关闭重启。仅在真实 Electron 开发会话显示：
  // 打包版非 DEV；浏览器验收页没有 preload（window.api 缺失）——两者都不渲染。
  const devReloadAvailable = import.meta.env.DEV && Boolean(window.api)
  const [devReloading, setDevReloading] = useState(false)
  const [agentGuideCopied, setAgentGuideCopied] = useState(false)
  const agentGuideTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (agentGuideTimerRef.current !== null) window.clearTimeout(agentGuideTimerRef.current)
    },
    []
  )
  const copyExternalAgentGuide = useCallback(async (): Promise<void> => {
    const brief = buildExternalAgentBrief(projects.map((p) => ({ id: p.id, name: p.name })))
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(brief)
      } else {
        throw new Error('clipboard unavailable')
      }
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = brief
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setAgentGuideCopied(true)
    if (agentGuideTimerRef.current !== null) window.clearTimeout(agentGuideTimerRef.current)
    agentGuideTimerRef.current = window.setTimeout(() => setAgentGuideCopied(false), 2000)
    useToastStore
      .getState()
      .show('已复制外部 Agent 对接说明，可直接粘贴给 Claude / Cursor / Antigravity 等外部 Agent')
  }, [projects])
  const reloadRendererUi = useCallback((): void => {
    if (devReloading) return
    setDevReloading(true)
    // 主页通常没有未落盘改动；防御性冲刷一次保存协调器（无脏数据时是空操作）。
    useSaveCoordinator.getState().flush()
    const reloadStartEvent: DiagnosticsEventInput = {
      event: 'dev.renderer_reload',
      level: 'info',
      phase: 'start',
      message: '主页开发工具触发界面重载'
    }
    emitDiagnosticsEvent(reloadStartEvent)
    // 健康探测：dev server 已死（孤儿窗口）时不白屏刷新，给出诚实提示。
    const probeTimeout = new Promise<'timeout'>((resolve) => {
      window.setTimeout(() => resolve('timeout'), 3000)
    })
    const probe = window
      .fetch(window.location.href, { method: 'HEAD', cache: 'no-store' })
      .then((response): 'ok' | 'unreachable' => (response.ok ? 'ok' : 'unreachable'))
      .catch((): 'unreachable' => 'unreachable')
    void Promise.race([probe, probeTimeout])
      .then(async (result) => {
        if (result !== 'ok') {
          setDevReloading(false)
          const reloadFailedEvent: DiagnosticsEventInput = {
            event: 'dev.renderer_reload',
            level: 'warn',
            phase: 'failed',
            message: `开发服务不可达（${result}），未执行重载`
          }
          emitDiagnosticsEvent(reloadFailedEvent)
          useToastStore.getState().show('开发会话已结束，请重新运行 npm run dev 后再试')
          return
        }
        // 重载会丢弃缓冲中的诊断事件，先冲刷（带 1.5s 上限，transport 死了也照常重载）。
        await Promise.race([
          drainDiagnosticsEvents(),
          new Promise<'timeout'>((resolve) => {
            window.setTimeout(() => resolve('timeout'), 1500)
          })
        ])
        window.location.reload()
      })
      .catch(() => {
        setDevReloading(false)
        useToastStore.getState().show('重载失败，请重新运行 npm run dev')
      })
  }, [devReloading])

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.api.listProjects()
    if (res.ok) setProjects(res.data)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.api.listProjects()
      if (!cancelled) {
        if (res.ok) setProjects(res.data)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleCreate = async (
    name: string,
    workspaceProfile: import('@shared/workspace-profile').WorkspaceProfile
  ): Promise<void> => {
    const res = await window.api.createProject({ name, workspaceProfile })
    if (res.ok) {
      setCreating(false)
      openProject(res.data)
      return
    }
    throw new Error(res.error.message)
  }

  const handleClone = async (): Promise<void> => {
    if (!cloning || !cloneName.trim()) return
    setCloneBusy(true)
    setCloneError('')
    try {
      const res = await window.api.cloneProject({ sourceId: cloning.id, name: cloneName.trim() })
      if (!res.ok) throw new Error(res.error.message)
      setCloning(null)
      setCloneName('')
      await refresh()
      useToastStore.getState().show(`已复制项目「${res.data.name}」`)
    } catch (error) {
      setCloneError(error instanceof Error ? error.message : String(error))
    } finally {
      setCloneBusy(false)
    }
  }

  const handleDelete = async (id: string, projectName: string): Promise<void> => {
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除项目「${projectName}」`,
        message: '项目、画布和全部项目素材将被彻底删除，此操作不可恢复。',
        confirmText: '彻底删除',
        danger: true
      }))
    )
      return
    const res = await window.api.deleteProject(id)
    if (res.ok) void refresh()
  }

  const handleRename = async (): Promise<void> => {
    if (!renamingId) return
    // 失焦提交是默认路径；空名视为取消，不报错。
    if (!renameValue.trim()) {
      setRenamingId(null)
      return
    }
    const res = await window.api.renameProject({ id: renamingId, name: renameValue.trim() })
    if (res.ok) {
      setRenamingId(null)
      void refresh()
      return
    }
    useToastStore.getState().show(`重命名失败：${res.error.message}`)
  }

  const handleOpen = (p: ProjectMeta): void => {
    openProject(p)
  }

  const exportOpenFailureDiagnostics = async (): Promise<void> => {
    if (!projectOpenFailure) return
    setExportingDiagnostics(true)
    try {
      const result = await window.api.exportDiagnosticsBundle({
        scope: { since: Math.max(0, projectOpenFailure.failedAt - 60_000), until: Date.now() },
        label: '项目打开失败'
      })
      if (result.ok) {
        useToastStore.getState().show(`诊断包已导出（${result.data.totalEvents} 条事件）`)
      } else if (result.error.code !== 'CANCELLED') {
        useToastStore.getState().show(`导出诊断包失败：${result.error.message}`)
      }
    } finally {
      setExportingDiagnostics(false)
    }
  }

  const handleExport = async (p: ProjectMeta): Promise<void> => {
    const res = await window.api.exportProject({ id: p.id, name: p.name })
    if (!res.ok) {
      if (res.error.code !== 'CANCELLED')
        useToastStore.getState().show(`导出失败：${res.error.message}`)
      return
    }
    // 导出包不完整必须告警：缺失媒体在导入端会成为悬挂引用（R-33）。
    if (res.data.missingMediaCount > 0) {
      useToastStore
        .getState()
        .show(`导出完成，但有 ${res.data.missingMediaCount} 个媒体文件缺失`, 5000)
      return
    }
    useToastStore.getState().show(`已导出到 ${res.data.path}`)
  }

  const handleImport = async (): Promise<void> => {
    const res = await window.api.importProject()
    if (!res.ok) {
      if (res.error.code !== 'CANCELLED')
        useToastStore.getState().show(`导入失败：${res.error.message}`)
      return
    }
    useToastStore.getState().show(`已导入项目「${res.data.name}」`)
    void refresh()
  }

  if (showLibrary) return <ResourceLibraryPage onBack={() => setShowLibrary(false)} />

  return (
    <div className="project-home">
      <header className="project-home-topbar">
        <div className="project-home-brand" aria-label="Free Creation">
          <img src={freeCreationLogo} alt="" />
          <h1>Free Creation</h1>
        </div>
        <div className="project-home-topbar-actions">
          {/* 2026-11-06 用户裁决：与画布顶栏一致——除新建项目保留品牌主按钮外，
              资源库 / 模型设置 / 导入项目都用纯图标按钮。 */}
          <div className="project-home-tool-group" role="group" aria-label="项目工具">
            <TopbarIconButton
              type="button"
              className="project-home-tool-btn"
              aria-label="资源库"
              onClick={() => setShowLibrary(true)}
            >
              <Icon name="assets" size={16} />
            </TopbarIconButton>
            <TopbarIconButton
              type="button"
              className="project-home-tool-btn"
              aria-label="模型设置"
              onClick={openModelSettings}
            >
              <Icon name="settings" size={16} />
            </TopbarIconButton>
            <TopbarIconButton
              type="button"
              className="project-home-tool-btn"
              aria-label="导入项目"
              onClick={() => void handleImport()}
            >
              <Icon name="download" size={16} />
            </TopbarIconButton>
          </div>
          <button
            type="button"
            className="project-home-button project-home-button-quiet project-home-agent-guide"
            onClick={() => void copyExternalAgentGuide()}
            title="复制外部 Agent（MCP / CLI）完整对接说明与全部节点端口清单，可直接发给外部 Agent 查看"
          >
            <Icon name={agentGuideCopied ? 'check' : 'agent'} size={14} />
            {agentGuideCopied ? '已复制说明' : 'Agent 对接'}
          </button>
          {/* 2026-11-21 用户裁决：开发重载按钮固定放在「新建项目」左侧。 */}
          {devReloadAvailable && (
            <button
              type="button"
              className="project-home-button project-home-button-quiet project-home-dev-reload"
              onClick={reloadRendererUi}
              disabled={devReloading}
              title="重新加载界面代码（仅开发模式）：改完渲染层代码后点击生效，无需重启应用"
            >
              <Icon name="refresh" size={14} />
              {devReloading ? '重载中…' : '重载'}
            </button>
          )}
          <button
            type="button"
            className="project-home-button project-home-button-primary"
            onClick={() => setCreating(true)}
          >
            <Icon name="add" size={15} /> 新建项目
          </button>
        </div>
      </header>
      <div className="project-home-content">

        {projectOpenFailure && (
          <section
            className="project-open-failure"
            role="alert"
            aria-labelledby="project-open-failure-title"
          >
            <div>
              <h2 id="project-open-failure-title">无法打开“{projectOpenFailure.projectName}”</h2>
              <p>项目文件和备份都无法读取。原文件已保留，没有被覆盖。你可以导出诊断包供排查。</p>
            </div>
            <div className="project-open-failure-actions">
              <button
                type="button"
                className="project-home-button project-home-button-quiet"
                disabled={exportingDiagnostics}
                onClick={() => void exportOpenFailureDiagnostics()}
              >
                {exportingDiagnostics ? '导出中…' : '导出诊断包'}
              </button>
              <button
                type="button"
                className="project-home-button project-home-button-quiet"
                aria-label="关闭项目打开失败提示"
                onClick={clearProjectOpenFailure}
              >
                关闭提示
              </button>
            </div>
          </section>
        )}

        {creating && (
          <ProjectCreateDialog
            title="新建项目"
            submitLabel="创建项目"
            onCancel={() => setCreating(false)}
            onSubmit={handleCreate}
          />
        )}

        {cloning && (
          <ModalShell
            size="s"
            title="复制项目"
            onClose={() => !cloneBusy && setCloning(null)}
            closeOnEscape={!cloneBusy}
            closeOnOverlay={!cloneBusy}
            initialFocusRef={cloneInputRef}
            footer={
              <>
                <button
                  type="button"
                  className={modalBtn('secondary')}
                  disabled={cloneBusy}
                  onClick={() => setCloning(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  form="project-clone-form"
                  className={modalBtn('primary')}
                  disabled={cloneBusy || !cloneName.trim()}
                >
                  {cloneBusy ? '复制中…' : '创建副本'}
                </button>
              </>
            }
          >
            <form
              id="project-clone-form"
              onSubmit={(event) => {
                event.preventDefault()
                void handleClone()
              }}
            >
              <p className="modal-shell-hint" style={{ margin: '0 0 14px' }}>
                复制画布、项目配置和全部项目素材，副本可以独立修改。
              </p>
              <label className="modal-field">
                <span>副本名称</span>
                <input
                  ref={cloneInputRef}
                  maxLength={120}
                  value={cloneName}
                  onChange={(event) => setCloneName(event.currentTarget.value)}
                />
              </label>
              {cloneError && (
                <div className="modal-error" role="alert" style={{ marginTop: 12 }}>
                  复制失败：{cloneError}
                </div>
              )}
            </form>
          </ModalShell>
        )}

        <main className="project-home-workspace">
          <div className="project-home-grid">
            {!loading && projects.length === 0 && !creating && (
              <div className="project-home-empty project-home-empty-action">
                <span>还没有项目</span>
                <button type="button" className="project-home-button project-home-button-primary"
                  onClick={() => setCreating(true)}>
                  <Icon name="add" size={15} /> 创建第一个项目
                </button>
              </div>
            )}
            {projects.map((p) => (
              <article
                key={p.id}
                className="project-home-card"
                onPointerMove={(event) => {
                  // 与画布节点一致：柔光跟随指针；只写 CSS 变量，不触发 React 重渲染。
                  const rect = event.currentTarget.getBoundingClientRect()
                  event.currentTarget.style.setProperty(
                    '--project-card-mx',
                    `${((event.clientX - rect.left) / rect.width) * 100}%`
                  )
                  event.currentTarget.style.setProperty(
                    '--project-card-my',
                    `${((event.clientY - rect.top) / rect.height) * 100}%`
                  )
                }}
              >
                {renamingId === p.id ? (
                  <div className="project-home-card-open">
                    <input
                      autoFocus
                      className="project-home-name-input"
                      aria-label={`重命名项目 ${p.name}`}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void handleRename()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                    <span className="project-home-time">{formatDate(p.updatedAt)}</span>
                  </div>
                ) : (
                  <button
                    className="project-home-card-open"
                    aria-label={`打开项目 ${p.name}`}
                    onClick={() => handleOpen(p)}
                  >
                    <span className="project-home-name">{p.name}</span>
                    <span className="project-home-time">{formatDate(p.updatedAt)}</span>
                  </button>
                )}
                <div className="project-home-card-actions">
                  <button
                    className="project-home-icon-button"
                    title="导出"
                    aria-label={`导出项目 ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleExport(p)
                    }}
                  >
                    <Icon name="download" size={15} />
                  </button>
                  <button
                    className="project-home-icon-button"
                    title="复制项目"
                    aria-label={`复制项目 ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setCloning(p)
                      setCloneName(`${p.name} · 副本`)
                    }}
                  >
                    <Icon name="copy" size={15} />
                  </button>
                  <button
                    className="project-home-icon-button"
                    title="重命名"
                    aria-label={`重命名项目 ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenamingId(p.id)
                      setRenameValue(p.name)
                    }}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                  <button
                    className="project-home-icon-button project-home-icon-button-danger"
                    title="删除"
                    aria-label={`删除项目 ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDelete(p.id, p.name)
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}
