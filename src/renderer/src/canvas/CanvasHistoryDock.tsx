// 顶栏历史操作：位于搜索按钮左侧，避免遮挡画布与节点。
import { useEffect, useState } from 'react'
import { useEditorStore } from '../stores/editor'
import { Icon } from '../components/Icon'

export function CanvasTopHistory(): React.JSX.Element {
  const editor = useEditorStore((state) => state.editor)
  const [, force] = useState(0)

  useEffect(() => {
    if (!editor) return
    const unsub = editor.store.listen(
      () => {
        force((n) => n + 1)
      },
      { scope: 'session' }
    )
    return () => {
      unsub?.()
    }
  }, [editor])

  const canUndo = editor?.canUndo() ?? false
  const canRedo = editor?.canRedo() ?? false

  return (
    <div className="undo-redo-group" aria-label="历史操作">
      <button
        className="undo-redo-btn"
        title="撤销（Ctrl+Z）"
        disabled={!canUndo}
        onClick={() => editor?.undo()}
      >
        <Icon name="undo" size={16} />
      </button>
      <button
        className="undo-redo-btn"
        title="重做（Ctrl+Shift+Z）"
        disabled={!canRedo}
        onClick={() => editor?.redo()}
      >
        <Icon name="redo" size={16} />
      </button>
    </div>
  )
}
