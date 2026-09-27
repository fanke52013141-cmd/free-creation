import { useState } from 'react'
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
  const [busy, setBusy] = useState(false)

  const exportStructure = async (): Promise<void> => {
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
    <div className="canvas-transfer-actions" role="group" aria-label="画布导入导出">
      <button
        className="canvas-transfer-button"
        title="导入画布结构"
        aria-label="导入画布"
        disabled={busy}
        onClick={() => void importStructure()}
      >
        <Icon name="upload" size={16} />
      </button>
      <button
        className="canvas-transfer-button"
        title="导出画布结构"
        aria-label="导出画布"
        disabled={busy}
        onClick={() => void exportStructure()}
      >
        <Icon name="download" size={16} />
      </button>
    </div>
  )
}
