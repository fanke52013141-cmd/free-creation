// 画布右侧操作栏：选中节点时常驻显示 删除 / 复制 / 置顶 / 置底
// 按钮带半透明背景 + 彩色图标，始终可见，无需悬浮
import { useEffect, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { markUndoPoint } from './history'

interface ActionsDockProps {
  editor: Editor
}

export function NodeActionsDock({ editor }: ActionsDockProps): React.JSX.Element | null {
  const [selectedIds, setSelectedIds] = useState<TLShapeId[]>([])

  useEffect((): (() => void) => {
    const update = (): void => {
      setSelectedIds(editor.getSelectedShapeIds().filter((id) => {
        const s = editor.getShape(id)
        return s?.type === 'node-card'
      }))
    }
    update()
    const unsub = editor.store.listen(update, { scope: 'session' })
    return unsub
  }, [editor])

  if (selectedIds.length === 0) return null

  // 单个 chat 节点被选中时右侧会弹出聊天面板，操作栏与之重叠，此处隐藏
  if (selectedIds.length === 1) {
    const s = editor.getShape(selectedIds[0])
    if (s?.type === 'node-card' && (s.props as { nodeType?: string }).nodeType === 'chat') return null
  }

  const handleDelete = (): void => {
    markUndoPoint(editor, 'delete-nodes')
    editor.deleteShapes(selectedIds)
  }

  const handleDuplicate = (): void => {
    markUndoPoint(editor, 'duplicate-nodes')
    editor.duplicateShapes(selectedIds)
  }

  const handleBringToFront = (): void => {
    markUndoPoint(editor, 'bring-front')
    editor.bringToFront(selectedIds)
  }

  const handleSendToBack = (): void => {
    markUndoPoint(editor, 'send-back')
    editor.sendToBack(selectedIds)
  }

  return (
    <div className="node-actions-dock">
      <button className="action-dock-btn danger" title="删除选中节点" onClick={handleDelete}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" stroke="#f85149" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10 11v6M14 11v6" stroke="#f85149" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span>删除</span>
      </button>
      <button className="action-dock-btn" title="复制选中节点" onClick={handleDuplicate}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="#09caf5" strokeWidth="2" />
          <path d="M5 15V5a2 2 0 012-2h10" stroke="#09caf5" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span>复制</span>
      </button>
      <div className="action-dock-divider" />
      <button className="action-dock-btn" title="移到最前面" onClick={handleBringToFront}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <rect x="4" y="4" width="16" height="16" rx="2" stroke="#34d399" strokeWidth="2" />
          <path d="M12 8v8M8 12l4-4 4 4" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>置顶</span>
      </button>
      <button className="action-dock-btn" title="移到最后面" onClick={handleSendToBack}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <rect x="4" y="4" width="16" height="16" rx="2" stroke="#fbbf24" strokeWidth="2" />
          <path d="M12 16V8M8 12l4 4 4-4" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>置底</span>
      </button>
    </div>
  )
}
