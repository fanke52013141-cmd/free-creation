import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '@shared/types'
import { deriveGraph } from './graph'
import { useEditorStore } from '../stores/editor'
import { useAppStore } from '../stores/app'
import { toast } from '../stores/toast'
import { Icon } from '../components/Icon'

interface CanvasTransferMenuProps {
  project: ProjectMeta
}

export function CanvasTransferMenu({ project }: CanvasTransferMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const exportStructure = async (): Promise<void> => {
    setOpen(false)
    const editor = useEditorStore.getState().editor
    if (!editor) return toast('画布尚未就绪，请稍后重试')
    setBusy(true)
    try {
      const result = await window.api.exportCanvasStructure({
        id: project.id,
        name: project.name,
        snapshot: editor.store.getStoreSnapshot(),
        graph: deriveGraph(editor)
      })
      if (!result.ok) {
        if (result.error.code !== 'CANCELLED') toast(`导出失败：${result.error.message}`)
        return
      }
      toast(`已导出 ${result.data.nodeCount} 个节点；文件不包含媒体素材与运行结果`)
    } catch (error) {
      toast(`导出失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const importStructure = async (): Promise<void> => {
    setOpen(false)
    setBusy(true)
    try {
      const result = await window.api.importCanvasStructure()
      if (!result.ok) {
        if (result.error.code !== 'CANCELLED') toast(`导入失败：${result.error.message}`)
        return
      }
      await window.api.closeProject()
      const opened = await window.api.openProject(result.data.id)
      if (!opened.ok || !opened.data) {
        await window.api.openProject(project.id)
        toast(opened.ok ? '导入成功，但新画布无法打开' : `导入成功，但新画布无法打开：${opened.error.message}`)
        return
      }
      useAppStore.getState().openProject(opened.data.meta)
      toast(`已导入「${opened.data.meta.name}」，当前画布已保留`)
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-menu canvas-transfer-menu" ref={ref}>
      <button
        className="canvas-transfer-trigger"
        title="导入或导出当前画布结构，不包含音视频素材"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="upload" size={14} />
        导入导出
      </button>
      {open && (
        <div className="project-menu-panel canvas-transfer-panel" role="menu">
          <button
            className="node-menu-item"
            role="menuitem"
            disabled={busy}
            title="创建一个新项目，不覆盖当前画布"
            onClick={() => void importStructure()}
          >
            <span className="item-icon"><Icon name="upload" size={16} /></span>
            <span>导入画布结构</span>
          </button>
          <button
            className="node-menu-item"
            role="menuitem"
            disabled={busy}
            title="导出节点、连线和配置；不含媒体文件与运行结果"
            onClick={() => void exportStructure()}
          >
            <span className="item-icon"><Icon name="download" size={16} /></span>
            <span>导出画布结构</span>
          </button>
        </div>
      )}
    </div>
  )
}
