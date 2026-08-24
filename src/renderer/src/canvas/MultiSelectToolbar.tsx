import { useEffect, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'

interface MultiSelectToolbarProps {
  editor: Editor
}

type AlignMode = 'left' | 'right' | 'center-h' | 'center-v' | 'distribute-h' | 'distribute-v'

interface ShapeBounds {
  id: TLShapeId
  x: number
  y: number
  w: number
  h: number
}

export function MultiSelectToolbar({ editor }: MultiSelectToolbarProps): React.JSX.Element | null {
  const [selectedIds, setSelectedIds] = useState<TLShapeId[]>([])

  useEffect((): (() => void) => {
    const update = (): void => {
      const ids = editor
        .getSelectedShapes()
        .filter((s) => s.type === 'node-card')
        .map((s) => s.id)
      setSelectedIds(ids)
    }
    update()
    const unsub = editor.store.listen(update, { scope: 'session' })
    return unsub
  }, [editor])

  if (selectedIds.length < 2) return null

  const getBounds = (): ShapeBounds[] =>
    selectedIds.map((id) => {
      const s = editor.getShape(id)
      const w = (s?.props as { w?: number })?.w ?? 200
      const h = (s?.props as { h?: number })?.h ?? 120
      return { id, x: s?.x ?? 0, y: s?.y ?? 0, w, h }
    })

  const applyAlign = (mode: AlignMode): void => {
    const bounds = getBounds()
    if (bounds.length < 2) return

    editor.markHistoryStoppingPoint('align-nodes')

    const minX = Math.min(...bounds.map((b) => b.x))
    const maxX = Math.max(...bounds.map((b) => b.x + b.w))
    const minY = Math.min(...bounds.map((b) => b.y))
    const maxY = Math.max(...bounds.map((b) => b.y + b.h))
    const totalW = maxX - minX
    const totalH = maxY - minY

    switch (mode) {
      case 'left':
        bounds.forEach((b) => editor.updateShape({ id: b.id, type: 'node-card', x: minX }))
        break
      case 'right':
        bounds.forEach((b) => editor.updateShape({ id: b.id, type: 'node-card', x: maxX - b.w }))
        break
      case 'center-h': {
        const cx = (minX + maxX) / 2
        bounds.forEach((b) => editor.updateShape({ id: b.id, type: 'node-card', x: cx - b.w / 2 }))
        break
      }
      case 'center-v': {
        const cy = (minY + maxY) / 2
        bounds.forEach((b) => editor.updateShape({ id: b.id, type: 'node-card', y: cy - b.h / 2 }))
        break
      }
      case 'distribute-h': {
        // 横向均分：按 x 排序后等间距排列
        const sorted = [...bounds].sort((a, b) => a.x - b.x)
        const totalNodeW = sorted.reduce((sum, b) => sum + b.w, 0)
        const gap = sorted.length > 1 ? (totalW - totalNodeW) / (sorted.length - 1) : 0
        let cursor = minX
        sorted.forEach((b) => {
          editor.updateShape({ id: b.id, type: 'node-card', x: cursor })
          cursor += b.w + gap
        })
        break
      }
      case 'distribute-v': {
        // 纵向均分：按 y 排序后等间距排列
        const sorted = [...bounds].sort((a, b) => a.y - b.y)
        const totalNodeH = sorted.reduce((sum, b) => sum + b.h, 0)
        const gap = sorted.length > 1 ? (totalH - totalNodeH) / (sorted.length - 1) : 0
        let cursor = minY
        sorted.forEach((b) => {
          editor.updateShape({ id: b.id, type: 'node-card', y: cursor })
          cursor += b.h + gap
        })
        break
      }
    }
  }

  const handleGroup = (): void => {
    editor.markHistoryStoppingPoint('group-nodes')
    editor.groupShapes(selectedIds)
  }

  return (
    <div className="multiselect-toolbar">
      <button className="ms-btn" title="左对齐" onClick={() => applyAlign('left')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 7h16M4 12h10M4 17h13"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button className="ms-btn" title="右对齐" onClick={() => applyAlign('right')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M20 7H4M20 12h-10M20 17H7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button className="ms-btn" title="水平居中" onClick={() => applyAlign('center-h')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 5v14M4 8h16M7 12h10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button className="ms-btn" title="垂直居中" onClick={() => applyAlign('center-v')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 12h14M8 4v16M12 7v10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <span className="ms-divider" />
      <button className="ms-btn" title="横向均分" onClick={() => applyAlign('distribute-h')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 6v12M20 6v12M8 12h8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button className="ms-btn" title="纵向均分" onClick={() => applyAlign('distribute-v')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M6 4h12M6 20h12M12 8v8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <span className="ms-divider" />
      <button className="ms-btn ms-group" title="打组" onClick={handleGroup}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="2" />
          <rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="2" />
          <path
            d="M7 11v2a2 2 0 002 2h2M17 13v-2a2 2 0 00-2-2h-2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}
