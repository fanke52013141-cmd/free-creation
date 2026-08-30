import { useEffect, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { Icon } from '../components/Icon'

interface MultiSelectToolbarProps {
  editor: Editor
  onRunFlow: (ids: TLShapeId[]) => void
  onSaveWorkflow: () => void
}

type AlignMode = 'left' | 'right' | 'center-h' | 'center-v' | 'distribute-h' | 'distribute-v'

interface ShapeBounds {
  id: TLShapeId
  x: number
  y: number
  w: number
  h: number
}

export function MultiSelectToolbar({
  editor,
  onRunFlow,
  onSaveWorkflow
}: MultiSelectToolbarProps): React.JSX.Element | null {
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

  // 单节点运行入口位于节点右上角；浮动工具栏只服务多选操作。
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
      <>
        <button
          className="ms-btn"
          title="左对齐"
          aria-label="左对齐"
          onClick={() => applyAlign('left')}
        >
          <Icon name="align-left" size={18} />
        </button>
        <button
          className="ms-btn"
          title="右对齐"
          aria-label="右对齐"
          onClick={() => applyAlign('right')}
        >
          <Icon name="align-right" size={18} />
        </button>
        <button
          className="ms-btn"
          title="水平居中"
          aria-label="水平居中"
          onClick={() => applyAlign('center-h')}
        >
          <Icon name="align-horizontal" size={18} />
        </button>
        <button
          className="ms-btn"
          title="垂直居中"
          aria-label="垂直居中"
          onClick={() => applyAlign('center-v')}
        >
          <Icon name="align-vertical" size={18} />
        </button>
        <span className="ms-divider" />
        <button
          className="ms-btn"
          title="横向均分"
          aria-label="横向均分"
          onClick={() => applyAlign('distribute-h')}
        >
          <Icon name="distribute-horizontal" size={18} />
        </button>
        <button
          className="ms-btn"
          title="纵向均分"
          aria-label="纵向均分"
          onClick={() => applyAlign('distribute-v')}
        >
          <Icon name="distribute-vertical" size={18} />
        </button>
        <span className="ms-divider" />
        <button className="ms-btn ms-group" title="打组" aria-label="打组" onClick={handleGroup}>
          <Icon name="group" size={18} />
        </button>
        <span className="ms-divider" />
        <button
          className="ms-btn ms-run"
          title="运行所选节点及其真实上游依赖"
          aria-label="运行所选流程"
          onClick={() => onRunFlow(selectedIds)}
        >
          <Icon name="play" size={18} />
        </button>
        <button
          className="ms-btn ms-template"
          title="将所选节点与真实连线保存为工作流"
          aria-label="保存为工作流"
          onClick={onSaveWorkflow}
        >
          <Icon name="workflow" size={18} />
        </button>
      </>
    </div>
  )
}
