import { useEffect, useState } from 'react'
import type { ProjectFile } from '@shared/types'
import type { WorkspaceProfile } from '@shared/workspace-profile'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { useEngineStore } from '../engine/store'
import { ResourceQueuePanel } from '../engine/ResourceQueuePanel'
import { CanvasEditor } from '../canvas/CanvasEditor'
import { ProjectMenu } from '../canvas/ProjectMenu'
import { useSearchStore } from '../stores/search'
import { Icon } from '../components/Icon'
import { Tooltip } from '../components/Tooltip'
import { CanvasTopHistory } from '../canvas/CanvasHistoryDock'
import { CanvasTransferMenu } from '../canvas/CanvasTransferMenu'
import { ProjectCreateDialog } from '../components/ProjectCreateDialog'
import { SaveStatusBadge } from '../components/SaveStatusBadge'
import { toast } from '../stores/toast'

interface CanvasPageProps {
  projectId: string
}

export function CanvasPage({ projectId }: CanvasPageProps): React.JSX.Element {
  const [file, setFile] = useState<ProjectFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [recoveryPrompt, setRecoveryPrompt] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const setHome = useAppStore((s) => s.setHome)
  const openProject = useAppStore((s) => s.openProject)
  const currentProject = useAppStore((s) => s.currentProject)
  const openSettings = useGatewayStore((s) => s.openSettings)

  // 执行引擎状态：phase 控制按钮形态，done/total 显示进度
  const enginePhase = useEngineStore((s) => s.phase)
  const engineDone = useEngineStore((s) => s.done)
  const engineTotal = useEngineStore((s) => s.total)
  const engineCurrent = useEngineStore((s) => s.currentLabel)
  const engineErrors = useEngineStore((s) => s.errors)
  const engineRun = useEngineStore((s) => s.run)
  const engineStop = useEngineStore((s) => s.stop)
  const enginePause = useEngineStore((s) => s.pause)
  const engineResume = useEngineStore((s) => s.resume)
  const isRunning = enginePhase !== 'idle'
  const isPaused = enginePhase === 'paused'
  const [showErrors, setShowErrors] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false)

  // Ctrl+K 唤起搜索面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        // 在输入框/文本编辑中不抢占 Ctrl+K，交给用户当前焦点
        const active = document.activeElement
        const typing =
          active instanceof HTMLElement &&
          (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
        if (typing) return
        e.preventDefault()
        useSearchStore.getState().toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.api.openProject(projectId)
      if (cancelled) return
      if (res.ok && res.data) {
        setFile(res.data)
        openProject(res.data.meta)
        // T04（F01）：上次关窗冲突写入的恢复副本 → 请用户裁决后才进入画布
        try {
          const rec = await window.api.hasRecoveryCopy({ id: projectId })
          if (!cancelled && rec.ok && rec.data) setRecoveryPrompt(true)
        } catch {
          // 检测失败不阻断打开
        }
      } else {
        setHome()
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // T04：恢复副本裁决。「使用副本」经主进程正式落盘（推进版本、磁盘旧版进 .bak）；
  // 「丢弃副本」保留磁盘版本，两者都会移除副本文件。
  const resolveRecovery = async (useRecovery: boolean): Promise<void> => {
    setRecoveryBusy(true)
    try {
      if (useRecovery) {
        const restored = await window.api.restoreRecoveryCopy({ id: projectId })
        if (restored.ok && restored.data) {
          setFile(restored.data)
          openProject(restored.data.meta)
        } else {
          toast('恢复副本读取失败，已保留磁盘版本')
          await window.api.discardRecoveryCopy({ id: projectId }).catch(() => undefined)
        }
      } else {
        await window.api.discardRecoveryCopy({ id: projectId }).catch(() => undefined)
      }
      setRecoveryPrompt(false)
    } finally {
      setRecoveryBusy(false)
    }
  }

  const commitRename = async (): Promise<void> => {
    setRenaming(false)
    const name = nameDraft.trim()
    if (!name || !currentProject || name === currentProject.name) return
    const res = await window.api.renameProject({ id: currentProject.id, name })
    if (res.ok && res.data) {
      openProject(res.data)
      setFile((f) => (f ? { ...f, meta: { ...f.meta, name: res.data!.name } } : f))
    }
  }

  const createProject = async (name: string, workspaceProfile: WorkspaceProfile): Promise<void> => {
    const result = await window.api.createProject({ name, workspaceProfile })
    if (!result.ok) throw new Error(result.error.message)
    setShowCreateDialog(false)
    openProject(result.data)
  }

  const saveWorkspaceProfile = async (
    _name: string,
    workspaceProfile: WorkspaceProfile
  ): Promise<void> => {
    const result = await window.api.saveWorkspaceProfile({ projectId, workspaceProfile })
    if (!result.ok) throw new Error(result.error.message)
    if (!result.data) throw new Error('项目不存在，工作台设置未保存')
    setFile((current) =>
      current
        ? {
            ...current,
            meta: result.data!,
            workspaceProfile
          }
        : current
    )
    openProject(result.data)
    setShowWorkspaceDialog(false)
  }

  if (loading) {
    return <div className="canvas-loading">打开项目中…</div>
  }
  // T04（F01）：上次关窗冲突留下的恢复副本——进入画布前请用户裁决。
  if (recoveryPrompt && file) {
    return (
      <div className="canvas-loading">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="检测到未保存副本"
          style={{
            maxWidth: 460,
            padding: '20px 22px',
            border: '1px solid var(--line)',
            borderRadius: 12,
            background: 'var(--card)'
          }}
        >
          <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>检测到上次关闭时的未保存副本</h2>
          <p style={{ margin: '0 0 8px', fontSize: 13, lineHeight: 1.6 }}>
            上次关闭时，本项目的保存与外部修改发生冲突。你关闭前的最后视图已保存为
            <strong> 恢复副本</strong>；当前磁盘上是另一份版本（未受影响）。
          </p>
          <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--muted)' }}>
            选择「使用恢复副本」会把副本内容正式保存为新版本（当前磁盘版本会备份为 .bak
            可回退）；选择「保留磁盘版本」将丢弃副本，此操作不可撤销。
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              type="button"
              disabled={recoveryBusy}
              onClick={() => void resolveRecovery(false)}
              style={{
                minHeight: 32,
                padding: '6px 14px',
                borderRadius: 7,
                border: '1px solid var(--line)',
                background: 'var(--card)',
                color: 'var(--txt)',
                fontSize: 12,
                fontWeight: 600,
                cursor: recoveryBusy ? 'wait' : 'pointer'
              }}
            >
              保留磁盘版本
            </button>
            <button
              type="button"
              disabled={recoveryBusy}
              onClick={() => void resolveRecovery(true)}
              style={{
                minHeight: 32,
                padding: '6px 14px',
                borderRadius: 7,
                border: '1px solid rgba(103, 190, 215, 0.38)',
                background: 'var(--brand)',
                color: '#0b1726',
                fontSize: 12,
                fontWeight: 700,
                cursor: recoveryBusy ? 'wait' : 'pointer'
              }}
            >
              {recoveryBusy ? '恢复中…' : '使用恢复副本'}
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (!file) {
    return <div className="canvas-loading">项目不存在</div>
  }

  return (
    <div className="canvas-page canvas-theme-dark">
      <div className="canvas-topbar">
        {/* 左侧：项目菜单（撤销/重做已移到画布右侧历史簇） */}
        <ProjectMenu
          project={currentProject ?? file.meta}
          onCreateProject={() => setShowCreateDialog(true)}
          onConfigureWorkspace={() => setShowWorkspaceDialog(true)}
        />

        {/* 中间：项目名称（绝对居中） */}
        <div className="topbar-center">
          {renaming ? (
            <input
              className="title-input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <Tooltip label="双击重命名">
              <span
                className="canvas-title editable"
                role="button"
                tabIndex={0}
                aria-label="项目名称，按 Enter 重命名"
                onDoubleClick={() => {
                  if (currentProject) {
                    setNameDraft(currentProject.name)
                    setRenaming(true)
                  }
                }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && currentProject) {
                    e.preventDefault()
                    setNameDraft(currentProject.name)
                    setRenaming(true)
                  }
                }}
              >
                {currentProject?.name ?? file.meta.name}
              </span>
            </Tooltip>
          )}
        </div>

        {/* 右侧：保存状态 + 进度 + 搜索 + 运行 + 个人中心 */}
        <span className="topbar-spacer" />

        {/* T04（F01）：保存状态常驻徽标（五态，失败持续显示） */}
        <SaveStatusBadge />

        {/* 运行/停止工作流 + 进度（执行引擎核心控件） */}
        <div className="engine-controls">
          <ResourceQueuePanel projectId={projectId} />
          {isRunning && (
            <div className="engine-progress" title={engineCurrent || '执行中…'}>
              <div className="engine-progress-bar">
                <div
                  className="engine-progress-fill"
                  style={{ width: `${engineTotal > 0 ? (engineDone / engineTotal) * 100 : 0}%` }}
                />
              </div>
              <span className="engine-progress-text">
                {engineDone}/{engineTotal} ·{' '}
                {enginePhase === 'stopping'
                  ? '停止中…'
                  : isPaused
                    ? '已暂停（将在当前项结束后停下）'
                    : engineCurrent || '执行中…'}
              </span>
            </div>
          )}
          {/* 搜索按钮；撤销 / 重做紧挨搜索左侧 */}
          <CanvasTopHistory />
          <Tooltip label="搜索节点（Ctrl+K）">
            <button
              className="run-btn search-trigger"
              aria-label="搜索节点（Ctrl+K）"
              onClick={() => useSearchStore.getState().toggle()}
            >
              <Icon name="search" size={16} />
            </button>
          </Tooltip>
          {isRunning ? (
            <>
              <Tooltip label={isPaused ? '继续工作流' : '在当前原子任务结束后暂停'}>
                <button
                  className={`run-btn ${enginePhase === 'stopping' ? 'running' : ''}`}
                  disabled={enginePhase === 'stopping'}
                  onClick={() => (isPaused ? engineResume?.() : enginePause?.())}
                >
                  <Icon name={isPaused ? 'play' : 'pause'} size={14} /> {isPaused ? '继续' : '暂停'}
                </button>
              </Tooltip>
              <Tooltip label="停止工作流">
                <button className="run-btn running" onClick={() => engineStop?.()}>
                  <Icon name="close" size={14} /> 停止
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip label="运行工作流">
              <button
                className="run-btn"
                onClick={() => {
                  // 由用户发起新一轮运行时立即恢复错误面板；不在 effect 内同步 setState。
                  setShowErrors(true)
                  engineRun?.()
                }}
              >
                <Icon name="play" size={14} /> 运行
              </button>
            </Tooltip>
          )}
        </div>

        <div className="topbar-actions">
          <CanvasTransferMenu project={currentProject ?? file.meta} />
          {/* 模型供应商设置：常驻顶栏快捷按钮 */}
          <Tooltip label="模型供应商设置">
            <button className="topbar-shortcut" aria-label="模型供应商设置" onClick={openSettings}>
              <Icon name="settings" size={16} />
            </button>
          </Tooltip>
          {/* 回到主页：常驻顶栏快捷按钮 */}
          <Tooltip label="回到主页">
            <button
              className="topbar-shortcut"
              aria-label="回到主页"
              onClick={() => void window.api.closeProject().then(() => setHome())}
            >
              <Icon name="home" size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
      {engineErrors.length > 0 && showErrors && (
        <div className="engine-errors">
          <div className="engine-errors-head">
            <span>运行错误（{engineErrors.length}）</span>
            <button
              className="engine-errors-clear"
              onClick={() => {
                useEngineStore.setState({ errors: [] })
                setShowErrors(false)
              }}
            >
              清空
            </button>
          </div>
          {engineErrors.map((e, i) => (
            <div key={i} className="engine-error-item">
              <span className={`error-phase-badge phase-${e.phase ?? 'unknown'}`}>
                {e.phase === 'input'
                  ? '输入'
                  : e.phase === 'execution'
                    ? '执行'
                    : e.phase === 'output'
                      ? '输出'
                      : '错误'}
              </span>
              <span className="error-label">{e.label}</span>
              <span className="error-reason" title={e.reason}>
                {e.reason}
              </span>
              <span className="error-time">
                {new Date(e.timestamp).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </span>
            </div>
          ))}
        </div>
      )}
      <CanvasEditor
        project={currentProject ?? file.meta}
        initialSnapshot={file.tldrawSnapshot}
        workspaceProfile={file.workspaceProfile}
      />
      {showCreateDialog && (
        <ProjectCreateDialog
          title="新建项目"
          submitLabel="创建项目"
          onCancel={() => setShowCreateDialog(false)}
          onSubmit={createProject}
        />
      )}
      {showWorkspaceDialog && (
        <ProjectCreateDialog
          title="工作台节点设置"
          nameRequired={false}
          initialProfile={file.workspaceProfile}
          submitLabel="保存设置"
          onCancel={() => setShowWorkspaceDialog(false)}
          onSubmit={saveWorkspaceProfile}
        />
      )}
    </div>
  )
}
