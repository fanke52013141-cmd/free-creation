import { useCallback, useEffect, useState } from 'react'
import type { ProjectMeta } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useConfirmStore } from '../stores/confirm'
import { useToastStore } from '../stores/toast'
import { Icon } from '../components/Icon'

function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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

  const handleOpenDemo = async (): Promise<void> => {
    const res = await window.api.importDemoProject()
    if (!res.ok) {
      useToastStore.getState().show(`打开示例项目失败：${res.error.message}`)
      return
    }
    openProject(res.data)
  }

  return (
    <div className="home">
      <header className="home-header">
        <h1>无限画布创作平台</h1>
        <div className="home-actions">
          <button className="btn-ghost" onClick={() => void handleOpenDemo()}>
            <Icon name="spark" size={16} /> 打开示例项目
          </button>
          <button className="btn-ghost" onClick={() => void handleImport()}>
            <Icon name="upload" size={16} /> 导入项目
          </button>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="add" size={16} /> 新建项目
          </button>
        </div>
      </header>

      {creating && (
        <div className="create-row">
          <input
            autoFocus
            placeholder="项目名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
              if (e.key === 'Escape') setCreating(false)
            }}
          />
          <button className="btn-primary" onClick={() => void handleCreate()}>
            创建
          </button>
          <button className="btn-ghost" onClick={() => setCreating(false)}>
            取消
          </button>
        </div>
      )}

      <div className="project-grid">
        {loading && <div className="empty">加载中…</div>}
        {!loading && projects.length === 0 && !creating && (
          <div className="empty">还没有项目，点击右上角新建一个开始创作</div>
        )}
        {projects.map((p) => (
          <div key={p.id} className="project-card" onClick={() => handleOpen(p)}>
            {renamingId === p.id ? (
              <input
                autoFocus
                value={renameValue}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleRename()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
              />
            ) : (
              <div className="project-name">{p.name}</div>
            )}
            <div className="project-time">{formatDate(p.updatedAt)}</div>
            <div className="project-actions">
              <button
                className="icon-btn"
                title="导出"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleExport(p)
                }}
              >
                <Icon name="download" size={15} />
              </button>
              <button
                className="icon-btn"
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation()
                  setRenamingId(p.id)
                  setRenameValue(p.name)
                }}
              >
                <Icon name="edit" size={15} />
              </button>
              <button
                className="icon-btn danger"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleDelete(p.id, p.name)
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
