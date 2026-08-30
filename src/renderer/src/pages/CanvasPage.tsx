import { useEffect, useState } from 'react'
import type { ProjectFile } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { useEngineStore } from '../engine/store'
import { CanvasEditor } from '../canvas/CanvasEditor'
import { ProjectMenu } from '../canvas/ProjectMenu'
import { useSearchStore } from '../stores/search'
import { Icon } from '../components/Icon'
import { CanvasTopHistory } from '../canvas/CanvasHistoryDock'

interface CanvasPageProps {
  projectId: string
}

export function CanvasPage({ projectId }: CanvasPageProps): React.JSX.Element {
  const [file, setFile] = useState<ProjectFile | null>(null)
  const [loading, setLoading] = useState(true)
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
  const [canvasTheme, setCanvasTheme] = useState<'dark' | 'light'>('dark')

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

  if (loading) {
    return <div className="canvas-loading">打开项目中…</div>
  }
  if (!file) {
    return <div className="canvas-loading">项目不存在</div>
  }

  return (
    <div className={`canvas-page canvas-theme-${canvasTheme}`}>
      <div className="canvas-topbar">
        {/* 左侧：项目菜单（撤销/重做已移到画布右侧历史簇） */}
        <ProjectMenu project={currentProject ?? file.meta} />

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
            <span
              className="canvas-title editable"
              title="双击重命名"
              onDoubleClick={() => {
                if (currentProject) {
                  setNameDraft(currentProject.name)
                  setRenaming(true)
                }
              }}
            >
              {currentProject?.name ?? file.meta.name}
            </span>
          )}
        </div>

        {/* 右侧：进度 + 版本 + 搜索 + 运行 + 个人中心 */}
        <span className="topbar-spacer" />

        {/* 运行/停止工作流 + 进度（执行引擎核心控件） */}
        <div className="engine-controls">
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
          {/* 版本号 + 搜索按钮；撤销 / 重做紧挨搜索左侧 */}
          <span className="engine-version">v1.0</span>
          <CanvasTopHistory />
          <button
            className="run-btn search-trigger"
            title="搜索节点（Ctrl+K）"
            onClick={() => useSearchStore.getState().toggle()}
          >
            <Icon name="search" size={16} />
          </button>
          {isRunning ? (
            <>
              <button
                className={`run-btn ${enginePhase === 'stopping' ? 'running' : ''}`}
                disabled={enginePhase === 'stopping'}
                title={isPaused ? '继续工作流' : '在当前原子任务结束后暂停'}
                onClick={() => (isPaused ? engineResume?.() : enginePause?.())}
              >
                <Icon name={isPaused ? 'play' : 'pause'} size={14} /> {isPaused ? '继续' : '暂停'}
              </button>
              <button className="run-btn running" title="停止工作流" onClick={() => engineStop?.()}>
                <Icon name="close" size={14} /> 停止
              </button>
            </>
          ) : (
            <button
              className="run-btn"
              title="运行工作流"
              onClick={() => {
                // 由用户发起新一轮运行时立即恢复错误面板；不在 effect 内同步 setState。
                setShowErrors(true)
                engineRun?.()
              }}
            >
              <Icon name="play" size={14} /> 运行
            </button>
          )}
        </div>

        <div className="topbar-actions">
          {/* 模型供应商设置：常驻顶栏快捷按钮 */}
          <button
            className="topbar-shortcut"
            title="模型供应商设置"
            aria-label="模型供应商设置"
            onClick={openSettings}
          >
            <Icon name="settings" size={16} />
          </button>
          {/* 回到主页：常驻顶栏快捷按钮 */}
          <button
            className="topbar-shortcut"
            title="回到主页"
            aria-label="回到主页"
            onClick={() => void window.api.closeProject().then(() => setHome())}
          >
            <Icon name="home" size={16} />
          </button>
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
        onThemeChange={setCanvasTheme}
      />
    </div>
  )
}
