import { TopbarIconButton } from '../components/TopbarIconButton'
// 顶栏历史操作：位于搜索按钮左侧，避免遮挡画布与节点。
import { useEffect, useState } from 'react'
import { useEditorStore } from '../stores/editor'
import { Icon } from '../components/Icon'

export function CanvasTopHistory(): React.JSX.Element {
  const editor = useEditorStore((state) => state.editor)
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false })

  useEffect(() => {
    if (!editor) return
    // session 每次相机帧都会触发监听；只在 canUndo/canRedo 真正变化时才重渲染。
    const sync = (): void => {
      const next = { canUndo: editor.canUndo(), canRedo: editor.canRedo() }
      setHistoryState((current) =>
        current.canUndo === next.canUndo && current.canRedo === next.canRedo ? current : next
      )
    }
    sync()
    // 监听全部变更但按结果判等：相机帧不再触发重渲染，历史栈变化仍即时刷新。
    const unsub = editor.store.listen(sync, { scope: 'all' })
    return () => {
      unsub?.()
    }
  }, [editor])

  const { canUndo, canRedo } = historyState

  return (
    <div className="undo-redo-group" aria-label="历史操作">
      <TopbarIconButton
        className="undo-redo-btn"
        aria-label="撤销"
        disabled={!canUndo}
        onClick={() => editor?.undo()}
      >
        <Icon name="undo" size={16} />
      </TopbarIconButton>
      <TopbarIconButton
        className="undo-redo-btn"
        aria-label="重做"
        disabled={!canRedo}
        onClick={() => editor?.redo()}
      >
        <Icon name="redo" size={16} />
      </TopbarIconButton>
    </div>
  )
}
