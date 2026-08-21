import { useEffect, useState } from 'react'
import type { ProjectFile } from '@shared/types'
import { useAppStore } from '../stores/app'
import { CanvasEditor } from '../canvas/CanvasEditor'
import { ProjectMenu } from '../canvas/ProjectMenu'

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
        <ProjectMenu project={currentProject ?? file.meta} />
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
        <span className="topbar-spacer" />
        <span className="topbar-version">v{file.meta.graphVersion}</span>
      </div>
      <CanvasEditor project={currentProject ?? file.meta} initialSnapshot={file.tldrawSnapshot} />
    </div>
  )
}
