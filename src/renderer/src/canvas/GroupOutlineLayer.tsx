import { useEffect, useState, type RefObject } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { markUndoPoint } from './history'

interface GroupOutlineLayerProps {
  editor: Editor
  hostRef: RefObject<HTMLDivElement | null>
}

interface GroupOutline {
  id: TLShapeId
  left: number
  top: number
  width: number
  height: number
  count: number
  label: string
}

interface SelectionOutline {
  left: number
  top: number
  width: number
  height: number
}

function outlinesEqual(left: GroupOutline[], right: GroupOutline[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index]
      return (
        item.id === other.id &&
        item.left === other.left &&
        item.top === other.top &&
        item.width === other.width &&
        item.height === other.height &&
        item.count === other.count &&
        item.label === other.label
      )
    })
  )
}

// 分组框上边距：节点标题栏（node-header）高 29px 悬浮在卡片上方，分组框必须整体
// 越过它，否则会框住最上一排节点的标题/正文（用户反馈的“框到节点信息”）。
const OUTLINE_TOP_PAD = 44
const OUTLINE_SIDE_PAD = 12
// 标签条带：显示在分组框上边缘外，双击进入重命名（window 捕获命中带，不拦截常规画布交互）
const LABEL_BAND_TOP = 26
const LABEL_BAND_HEIGHT = 20

/**
 * tldraw 原生 group 是一种父子状态，不是业务节点；这里仅补一层常驻视觉框。
 * 实际选择、移动、撤销和嵌套仍全部由 tldraw 的 groupShapes 管理。
 * 分组名保存在 group 形状的 meta.label（与 meta.nodeRun 等运行数据同层互不干扰）。
 */
export function GroupOutlineLayer({ editor, hostRef }: GroupOutlineLayerProps): React.JSX.Element {
  const [outlines, setOutlines] = useState<GroupOutline[]>([])
  const [selection, setSelection] = useState<SelectionOutline | null>(null)
  const [editingId, setEditingId] = useState<TLShapeId | null>(null)

  useEffect(() => {
    let frame = 0
    const updateNow = (): void => {
      const host = hostRef.current
      if (!host) return
      const hostBounds = host.getBoundingClientRect()
      const next: GroupOutline[] = []

      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== 'group') continue
        const bounds = editor.getShapePageBounds(shape.id)
        if (!bounds) continue
        const topLeft = editor.pageToScreen({ x: bounds.x, y: bounds.y })
        const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
        const count = editor
          .getSortedChildIdsForParent(shape.id)
          .filter((id) => editor.getShape(id)?.type === 'node-card').length
        if (count < 2) continue
        const meta = shape.meta as Record<string, unknown> | undefined
        const label = typeof meta?.label === 'string' ? meta.label : ''
        next.push({
          id: shape.id,
          left: topLeft.x - hostBounds.left - OUTLINE_SIDE_PAD,
          top: topLeft.y - hostBounds.top - OUTLINE_TOP_PAD,
          width: bottomRight.x - topLeft.x + OUTLINE_SIDE_PAD * 2,
          height: bottomRight.y - topLeft.y + OUTLINE_TOP_PAD + OUTLINE_SIDE_PAD,
          count,
          label
        })
      }
      setOutlines((current) => (outlinesEqual(current, next) ? current : next))

      // 多选不是分组：只在 2 个以上节点被同时选中时绘制细虚线范围框，
      // 让它和常驻的分组容器维持完全不同的视觉语义。
      const selectedNodes = editor.getSelectedShapes().filter((shape) => shape.type === 'node-card')
      if (selectedNodes.length < 2) {
        setSelection((current) => (current === null ? current : null))
        return
      }
      const bounds = selectedNodes
        .map((shape) => editor.getShapePageBounds(shape.id))
        .filter((bound): bound is NonNullable<typeof bound> => Boolean(bound))
      if (bounds.length < 2) return
      const minX = Math.min(...bounds.map((bound) => bound.x))
      const minY = Math.min(...bounds.map((bound) => bound.y))
      const maxX = Math.max(...bounds.map((bound) => bound.maxX))
      const maxY = Math.max(...bounds.map((bound) => bound.maxY))
      const topLeft = editor.pageToScreen({ x: minX, y: minY })
      const bottomRight = editor.pageToScreen({ x: maxX, y: maxY })
      const nextSelection = {
        left: topLeft.x - hostBounds.left - OUTLINE_SIDE_PAD,
        top: topLeft.y - hostBounds.top - OUTLINE_SIDE_PAD,
        width: bottomRight.x - topLeft.x + OUTLINE_SIDE_PAD * 2,
        height: bottomRight.y - topLeft.y + OUTLINE_SIDE_PAD * 2
      }
      setSelection((current) =>
        current &&
        current.left === nextSelection.left &&
        current.top === nextSelection.top &&
        current.width === nextSelection.width &&
        current.height === nextSelection.height
          ? current
          : nextSelection
      )
    }

    // 拖动时 document/session 会在同一帧内连续变化；每帧最多计算一次分组框，
    // 避免额外的 pageToScreen 与 React state 更新拖慢节点拖拽。
    const update = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        updateNow()
      })
    }

    updateNow()
    const offDocument = editor.store.listen(update, { scope: 'document' })
    const offSession = editor.store.listen(update, { scope: 'session' })
    window.addEventListener('resize', update)
    return () => {
      offDocument()
      offSession()
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
    }
  }, [editor, hostRef])

  // 双击分组名进入重命名：捕获阶段在 tldraw / 画布双击逻辑之前命中标签条带。
  // 常规单击/拖拽完全不受影响（本层 pointer-events: none，双击检测不占用任何交互）。
  useEffect(() => {
    const onDblClick = (e: MouseEvent): void => {
      if (editingId !== null) return
      const host = hostRef.current
      if (!host) return
      const hostBounds = host.getBoundingClientRect()
      const x = e.clientX - hostBounds.left
      const y = e.clientY - hostBounds.top
      for (const outline of outlines) {
        const hit =
          x >= outline.left &&
          x <= outline.left + outline.width &&
          y >= outline.top - LABEL_BAND_TOP - 4 &&
          y <= outline.top - LABEL_BAND_TOP + LABEL_BAND_HEIGHT + 4
        if (hit) {
          e.preventDefault()
          e.stopPropagation()
          setEditingId(outline.id)
          return
        }
      }
    }
    window.addEventListener('dblclick', onDblClick, { capture: true })
    return () => window.removeEventListener('dblclick', onDblClick, { capture: true })
  }, [outlines, editingId, hostRef])

  const commitGroupName = (id: TLShapeId, next: string): void => {
    const trimmed = next.trim()
    const shape = editor.getShape(id)
    if (trimmed && shape) {
      editor.updateShape({ id, type: 'group', meta: { ...shape.meta, label: trimmed } })
      markUndoPoint(editor, 'rename-group')
    }
    setEditingId(null)
  }

  return (
    <div className="canvas-group-outline-layer" aria-hidden="true">
      {outlines.map((outline) => (
        <div
          key={outline.id}
          className="canvas-group-outline"
          style={{
            left: outline.left,
            top: outline.top,
            width: outline.width,
            height: outline.height
          }}
        >
          {editingId === outline.id ? (
            <input
              className="canvas-group-name-input"
              defaultValue={outline.label || '分组'}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitGroupName(outline.id, e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commitGroupName(outline.id, e.currentTarget.value)
                else if (e.key === 'Escape') setEditingId(null)
              }}
            />
          ) : (
            <span>
              {outline.label
                ? `${outline.label} · ${outline.count} 个节点`
                : `分组 · ${outline.count} 个节点`}
            </span>
          )}
        </div>
      ))}
      {selection && (
        <div
          className="canvas-selection-outline"
          style={{
            left: selection.left,
            top: selection.top,
            width: selection.width,
            height: selection.height
          }}
        />
      )}
    </div>
  )
}
