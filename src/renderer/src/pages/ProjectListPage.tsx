import { useCallback, useEffect, useState } from 'react'
import type { ProjectMeta } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useConfirmStore } from '../stores/confirm'
import { useToastStore } from '../stores/toast'
import { Icon } from '../components/Icon'
import { ProjectCreateDialog } from '../components/ProjectCreateDialog'
import { ResourceLibraryPage } from '../library/ResourceLibraryPage'
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
  const [cloneError, setCloneError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const openProject = useAppStore((s) => s.openProject)

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

  const handleCreate = async (name: string, workspaceProfile: import('@shared/workspace-profile').WorkspaceProfile): Promise<void> => {
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
        message: '删除后项目数据将不可恢复。',
        confirmText: '删除',
        danger: true
      }))
    )
      return
    const res = await window.api.deleteProject(id)
    if (res.ok) void refresh()
  }

  const handleRename = async (): Promise<void> => {
    if (!renamingId || !renameValue.trim()) return
    const res = await window.api.renameProject({ id: renamingId, name: renameValue.trim() })
    if (res.ok) {
      setRenamingId(null)
      void refresh()
    }
  }

  const handleOpen = (p: ProjectMeta): void => {
    openProject(p)
  }

  const handleExport = async (p: ProjectMeta): Promise<void> => {
    const res = await window.api.exportProject({ id: p.id, name: p.name })
    if (!res.ok) {
      if (res.error.code !== 'CANCELLED')
        useToastStore.getState().show(`导出失败：${res.error.message}`)
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
      <div className="project-home-ambient" aria-hidden="true" />
      <div className="project-home-content">
        <header className="project-home-header">
          <div className="project-home-brand" aria-label="Free Creation">
            <img src={freeCreationLogo} alt="" />
            <h1>Free Creation</h1>
          </div>
          <div className="project-home-actions">
            <button className="project-home-button project-home-button-quiet" onClick={() => setShowLibrary(true)}>
              <Icon name="assets" size={16} /> 资源库
            </button>
            <button
              className="project-home-button project-home-button-quiet"
              onClick={() => void handleImport()}
            >
              <Icon name="upload" size={16} /> 导入项目
            </button>
            <button
              className="project-home-button project-home-button-primary"
            onClick={() => setCreating(true)}
            >
              <Icon name="add" size={16} /> 新建项目
            </button>
          </div>
        </header>

        {creating && (
          <ProjectCreateDialog
            title="新建项目"
            submitLabel="创建项目"
            onCancel={() => setCreating(false)}
            onSubmit={handleCreate}
          />
        )}

        {cloning && (
          <div className="project-clone-mask" onMouseDown={(event) => event.target === event.currentTarget && !cloneBusy && setCloning(null)}>
            <form
              className="project-clone-dialog"
              onSubmit={(event) => {
                event.preventDefault()
                void handleClone()
              }}
            >
              <h2>复制项目</h2>
              <p>复制画布、项目配置和全部项目素材，副本可以独立修改。</p>
              <label>
                <span>副本名称</span>
                <input autoFocus maxLength={120} value={cloneName} onChange={(event) => setCloneName(event.currentTarget.value)} />
              </label>
              {cloneError && <div className="project-clone-error" role="alert">复制失败：{cloneError}</div>}
              <div className="project-clone-actions">
                <button type="button" disabled={cloneBusy} onClick={() => setCloning(null)}>取消</button>
                <button type="submit" disabled={cloneBusy || !cloneName.trim()}>{cloneBusy ? '复制中…' : '创建副本'}</button>
              </div>
            </form>
          </div>
        )}

        <main className="project-home-workspace">
          <div className="project-home-grid">
            {loading && <div className="project-home-empty">加载中…</div>}
            {!loading && projects.length === 0 && !creating && (
              <div className="project-home-empty">还没有项目，点击右上角新建一个开始创作</div>
            )}
            {projects.map((p) => (
              <article key={p.id} className="project-home-card">
                {renamingId === p.id ? (
                  <input
                    autoFocus
                    aria-label={`重命名项目 ${renameValue}`}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRename()
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                  />
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
