import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { Icon } from '../components/Icon'
import { markUndoPoint } from './history'

interface NodeContextMenuProps {
  editor: Editor
  ids: TLShapeId[]
  x: number
  y: number
  onClose: () => void
  /** 复制按钮写入节点剪贴板（由 CanvasEditor 提供），之后可在空白处 Ctrl+V 或右键粘贴；不可用时回退为原地复制。 */
  onCopy?: () => number
}

export function NodeContextMenu({
  editor,
  ids,
  x,
  y,
  onCopy,
  onClose
}: NodeContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(168)

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  useLayoutEffect(() => setHeight(ref.current?.getBoundingClientRect().height ?? 168), [])
  const left = Math.max(12, Math.min(x, window.innerWidth - 196))
  const top = Math.max(12, Math.min(y, window.innerHeight - height - 12))
  const run = (action: () => void): void => {
    action()
    onClose()
  }

  return (
    <div className="node-context-menu" ref={ref} style={{ left, top }}>
      <div className="node-menu-title">节点操作</div>
      <button
        className="node-menu-item"
        onClick={() =>
          run(() => {
            editor.setEditingShape(ids[0])
          })
        }
      >
        <Icon name="edit" size={16} />
        编辑
      </button>
      <div className="node-menu-divider" />
      <button
        className="node-menu-item"
        onClick={() =>
          run(() => {
            const copied = onCopy?.() ?? 0
            if (copied === 0) {
              // 画布外未提供剪贴板回调时保持旧行为：原地复制一份
              markUndoPoint(editor, 'duplicate-nodes')
              editor.duplicateShapes(ids)
            }
          })
        }
      >
        <Icon name="copy" size={16} />
        复制
      </button>
      <button
        className="node-menu-item"
        onClick={() =>
          run(() => {
            markUndoPoint(editor, 'bring-front')
            editor.bringToFront(ids)
          })
        }
      >
        <Icon name="bring-front" size={16} />
        置顶
      </button>
      <button
        className="node-menu-item"
        onClick={() =>
          run(() => {
            markUndoPoint(editor, 'send-back')
            editor.sendToBack(ids)
          })
        }
      >
        <Icon name="send-back" size={16} />
        置底
      </button>
      <div className="node-menu-divider" />
      <button
        className="node-menu-item danger"
        onClick={() =>
          run(() => {
            markUndoPoint(editor, 'delete-nodes')
            editor.deleteShapes(ids)
          })
        }
      >
        <Icon name="trash" size={16} />
        删除
      </button>
    </div>
  )
}
