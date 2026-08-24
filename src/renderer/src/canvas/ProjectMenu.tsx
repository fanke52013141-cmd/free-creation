// LibTV 1.4.1 项目菜单栏：左上角 Logo 弹出项目管理菜单
import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useConfirmStore } from '../stores/confirm'
import { useGatewayStore } from '../stores/gateway'
import { Icon } from '../components/Icon'

interface ProjectMenuProps {
  project: ProjectMeta
}

export function ProjectMenu({ project }: ProjectMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const setHome = useAppStore((s) => s.setHome)
  const openProjectInStore = useAppStore((s) => s.openProject)
  const openSettings = useGatewayStore((s) => s.openSettings)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const goHome = async (): Promise<void> => {
    setOpen(false)
    await window.api.closeProject()
    setHome()
  }

  const createNew = async (): Promise<void> => {
    setOpen(false)
    const res = await window.api.createProject({ name: '未命名项目' })
    if (res.ok) openProjectInStore(res.data)
  }

  const removeCurrent = async (): Promise<void> => {
    setOpen(false)
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除项目「${project.name}」`,
        message: '删除后项目数据将不可恢复。',
        confirmText: '删除',
        danger: true
      }))
    )
      return
    const res = await window.api.deleteProject(project.id)
    if (res.ok) {
      await window.api.closeProject()
      setHome()
    }
  }

  return (
    <div className="project-menu" ref={ref}>
      <button
        className="logo-btn"
        title="项目菜单"
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        <span className="logo-mark">
          <Icon name="grid" size={15} />
        </span>
        <span className="logo-text">无限画布</span>
      </button>
      {open && (
        <div className="project-menu-panel">
          <button className="node-menu-item" onClick={() => void goHome()}>
            <span className="item-icon">
              <Icon name="home" size={17} />
            </span>
            <span>回到主页</span>
          </button>
          <button className="node-menu-item" onClick={() => void goHome()}>
            <span className="item-icon">
              <Icon name="assets" size={17} />
            </span>
            <span>全部项目</span>
          </button>
          <div className="node-menu-divider" />
          <button className="node-menu-item" onClick={() => void createNew()}>
            <span className="item-icon">
              <Icon name="add" size={17} />
            </span>
            <span>创建新项目</span>
          </button>
          <div className="node-menu-divider" />
          <button
            className="node-menu-item"
            onClick={() => {
              setOpen(false)
              openSettings()
            }}
          >
            <span className="item-icon">
              <Icon name="settings" size={17} />
            </span>
            <span>模型供应商设置</span>
          </button>
          <button className="node-menu-item danger" onClick={() => void removeCurrent()}>
            <span className="item-icon">
              <Icon name="trash" size={17} />
            </span>
            <span>删除项目</span>
          </button>
        </div>
      )}
    </div>
  )
}
