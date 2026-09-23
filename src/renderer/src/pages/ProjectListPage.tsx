import { useCallback, useEffect, useState } from 'react'
import type { ProjectMeta } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useConfirmStore } from '../stores/confirm'
import { useToastStore } from '../stores/toast'
import { Icon } from '../components/Icon'
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
  const [name, setName] = useState('')
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

  const handleCreate = async (): Promise<void> => {
    if (!name.trim()) return
    const res = await window.api.createProject({ name: name.trim() })
    if (res.ok) {
      setName('')
      setCreating(false)
      openProject(res.data)
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
          <div className="project-home-create-row">
            <input
              autoFocus
              aria-label="项目名称"
              placeholder="项目名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate()
                if (e.key === 'Escape') setCreating(false)
              }}
            />
            <button
              className="project-home-button project-home-button-primary"
              onClick={() => void handleCreate()}
            >
              创建
            </button>
            <button
              className="project-home-button project-home-button-quiet"
              onClick={() => setCreating(false)}
            >
              取消
            </button>
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
