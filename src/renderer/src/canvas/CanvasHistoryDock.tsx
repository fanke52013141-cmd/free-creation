// 画布右侧历史操作簇：撤销 / 重做 常驻显示（不随选中状态变化）
// 订阅 editor store 动态启用/禁用，位置在画布右侧，远离左上角
import { useEffect, useState } from 'react'
import type { Editor } from 'tldraw'

interface HistoryDockProps {
  editor: Editor | null
}

export function CanvasHistoryDock({ editor }: HistoryDockProps): React.JSX.Element | null {
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

  if (!editor) return null
  const canUndo = editor.canUndo()
  const canRedo = editor.canRedo()

  return (
    <div className="history-dock">
      <button
        className="history-dock-btn"
        title="撤销（Ctrl+Z）"
        disabled={!canUndo}
        onClick={() => editor.undo()}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 7L4 12l5 5M4 12h11a5 5 0 015 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button
        className="history-dock-btn"
        title="重做（Ctrl+Shift+Z）"
        disabled={!canRedo}
        onClick={() => editor.redo()}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M15 7l5 5-5 5M20 12H9a5 5 0 00-5 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}