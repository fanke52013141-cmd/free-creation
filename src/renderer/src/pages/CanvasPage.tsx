import { useEffect, useState } from 'react'
import type { TLShapeId } from 'tldraw'
import type { ProjectFile } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { useEngineStore } from '../engine/store'
import { useEditorStore } from '../stores/editor'
import { CanvasEditor } from '../canvas/CanvasEditor'
import { ProjectMenu } from '../canvas/ProjectMenu'
import { useSearchStore } from '../stores/search'
import { Icon } from '../components/Icon'
import { CanvasTopHistory } from '../canvas/CanvasHistoryDock'
import { inspectProjectFile, type ProjectWarning } from '../nodes/migrations/legacy'
import { toast } from '../stores/toast'

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
  const isRunning = enginePhase === 'running' || enginePhase === 'stopping'
  // 错误面板可见性：默认展开；用户关闭后记住到当前轮（hiddenAtSeq === runSeq），
  // 新一轮运行 runSeq 自增即自动重新展开——纯派生，无需 effect
  const runSeq = useEngineStore((s) => s.runSeq)
  const [hiddenAtSeq, setHiddenAtSeq] = useState<number | null>(null)
  const showErrors = hiddenAtSeq === null || hiddenAtSeq < runSeq

  // WP2 项目预检警告：打开项目时由 inspectProjectFile 产出，画布顶部可展开警告条呈现
  const [projectWarnings, setProjectWarnings] = useState<ProjectWarning[]>([])
  const [showWarnings, setShowWarnings] = useState(true)

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
        // WP2 预检：恢复画布前检查未知 nodeType / 未知端口 / 高版本契约，纯函数不修改数据
        const warnings = inspectProjectFile(res.data)
        setProjectWarnings(warnings)
        setShowWarnings(true)
        if (warnings.length > 0) {
          const errors = warnings.filter((w) => w.level === 'error').length
          toast(
            `项目检查发现 ${warnings.length} 项警告${errors > 0 ? `（含 ${errors} 项严重）` : ''}，详见画布顶部提示`,
            6000
          )
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

  /** 点击错误条目的"定位"按钮：选中并缩放至出错节点 */
  const locateNode = (nodeId: string): void => {
    const ed = useEditorStore.getState().editor
    if (!ed) return
    const shapeId = nodeId as TLShapeId
    const shape = ed.getShape(shapeId)
    if (!shape) return
    ed.setSelectedShapes([shapeId])
    ed.zoomToSelection({ animation: { duration: 300 } })
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

  if (loading) {
    return <div className="canvas-loading">打开项目中…</div>
  }
  if (!file) {
    return <div className="canvas-loading">项目不存在</div>
  }

  return (
    <div className="canvas-page">
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
                {enginePhase === 'stopping' ? '停止中…' : engineCurrent || '执行中…'}
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
          <button
            className={`run-btn ${isRunning ? 'running' : ''}`}
            title={isRunning ? '停止工作流' : '运行工作流'}
            onClick={() => {
              if (isRunning) {
                engineStop?.()
              } else {
                engineRun?.()
              }
            }}
          >
            <>
              <Icon name={isRunning ? 'close' : 'play'} size={14} /> {isRunning ? '停止' : '运行'}
            </>
          </button>
        </div>

        <div className="topbar-actions">
          {/* 模型供应商设置：常驻顶栏快捷按钮 */}
          <button className="topbar-shortcut" title="模型供应商设置" onClick={openSettings}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
              <path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {/* 回到主页：常驻顶栏快捷按钮 */}
          <button
            className="topbar-shortcut"
            title="回到主页"
            onClick={() => void window.api.closeProject().then(() => setHome())}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 11.5L12 4l9 7.5M5 10v9a1 1 0 001 1h12a1 1 0 001-1v-9"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M9 20v-6h6v6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
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
                setHiddenAtSeq(runSeq)
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
                      : e.phase === 'topology'
                        ? '拓扑'
                        : '错误'}
              </span>
              <span className="error-label">{e.label}</span>
              {e.nodeType && (
                <span className="error-meta-tag" title="节点类型 / 契约版本">
                  {e.nodeType}
                  {e.contractVersion !== undefined ? `@v${e.contractVersion}` : ''}
                </span>
              )}
              <span className="error-reason" title={e.reason}>
                {e.reason}
              </span>
              {e.portId && (
                <span className="error-meta-tag" title="出错端口">
                  端口:{e.portId}
                </span>
              )}
              {e.nodeId && (
                <button
                  className="error-locate-btn"
                  title="点击定位节点"
                  onClick={() => locateNode(e.nodeId!)}
                >
                  定位
                </button>
              )}
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
      {projectWarnings.length > 0 && (
        <div className="project-warnings">
          <div className="project-warnings-head">
            <button
              className="project-warnings-toggle"
              onClick={() => setShowWarnings((v) => !v)}
              title={showWarnings ? '收起警告' : '展开警告'}
            >
              <Icon name="warning" size={14} />
              <span>项目检查警告（{projectWarnings.length}）</span>
              <span className={`project-warnings-chevron ${showWarnings ? 'open' : ''}`}>▾</span>
            </button>
            <button
              className="engine-errors-clear"
              title="本次会话不再显示"
              onClick={() => setProjectWarnings([])}
            >
              忽略
            </button>
          </div>
          {showWarnings && (
            <div className="project-warnings-list">
              {projectWarnings.map((w, i) => (
                <div key={i} className="project-warning-item">
                  <span className={`warning-level-badge level-${w.level}`}>
                    {w.level === 'error' ? '严重' : w.level === 'warn' ? '警告' : '提示'}
                  </span>
                  <span className="error-reason" title={w.message}>
                    {w.message}
                  </span>
                  {w.portId && (
                    <span className="error-meta-tag" title="涉及的端口">
                      端口:{w.portId}
                    </span>
                  )}
                  {w.nodeId && (
                    <button
                      className="error-locate-btn"
                      title="点击定位节点"
                      onClick={() => locateNode(w.nodeId!)}
                    >
                      定位
                    </button>
                  )}
                  {w.suggestion && (
                    <span className="project-warning-suggestion">{w.suggestion}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <CanvasEditor project={currentProject ?? file.meta} initialSnapshot={file.tldrawSnapshot} />
    </div>
  )
}
