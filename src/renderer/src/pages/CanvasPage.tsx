import { useEffect, useRef, useState } from 'react'
import type { ProjectFile } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { useEngineStore } from '../engine/store'
import { CanvasEditor } from '../canvas/CanvasEditor'
import { ProjectMenu } from '../canvas/ProjectMenu'
import { useSearchStore } from '../stores/search'

interface CanvasPageProps {
  projectId: string
}

export function CanvasPage({ projectId }: CanvasPageProps): React.JSX.Element {
  const [file, setFile] = useState<ProjectFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [userOpen, setUserOpen] = useState(false)
  const userRef = useRef<HTMLDivElement>(null)
  const setHome = useAppStore((s) => s.setHome)
  const openProject = useAppStore((s) => s.openProject)
  const currentProject = useAppStore((s) => s.currentProject)
  const openSettings = useGatewayStore((s) => s.openSettings)

  // 执行引擎状态：phase 控制按钮形态，done/total 显示进度
  const enginePhase = useEngineStore((s) => s.phase)
  const engineDone = useEngineStore((s) => s.done)
  const engineTotal = useEngineStore((s) => s.total)
  const engineCurrent = useEngineStore((s) => s.currentLabel)
  const engineRun = useEngineStore((s) => s.run)
  const engineStop = useEngineStore((s) => s.stop)
  const isRunning = enginePhase === 'running' || enginePhase === 'stopping'

  // 右上角个人中心下拉：点击外部 / Esc 关闭
  useEffect(() => {
    if (!userOpen) return
    const onDown = (e: MouseEvent): void => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setUserOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [userOpen])

  // Ctrl+K 唤起搜索面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
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
          {/* 版本号 + 搜索按钮 */}
          <span className="engine-version">v1.0</span>
          <button
            className="run-btn search-trigger"
            title="搜索节点（Ctrl+K）"
            onClick={() => useSearchStore.getState().toggle()}
          >
            🔍
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
            {isRunning ? '■ 停止' : '▶ 运行'}
          </button>
        </div>

        <div className="topbar-actions">
          <div className="topbar-user" ref={userRef}>
            <button className="avatar-btn" title="个人中心" onClick={() => setUserOpen((v) => !v)}>
              <span className="avatar-dot">我</span>
            </button>
            {userOpen && (
              <div className="user-menu">
                <div className="user-menu-header">
                  <span className="user-avatar">我</span>
                  <div className="user-meta">
                    <strong>本地用户</strong>
                    <span>免费版</span>
                  </div>
                </div>
                <div className="node-menu-divider" />
                <button
                  className="node-menu-item"
                  onClick={() => {
                    setUserOpen(false)
                    openSettings()
                  }}
                >
                  <span className="item-icon">⚙</span>
                  <span>模型供应商设置</span>
                </button>
                <button
                  className="node-menu-item"
                  onClick={() => {
                    setUserOpen(false)
                    void window.api.closeProject().then(() => setHome())
                  }}
                >
                  <span className="item-icon">🏠</span>
                  <span>回到主页</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <CanvasEditor project={currentProject ?? file.meta} initialSnapshot={file.tldrawSnapshot} />
    </div>
  )
}
