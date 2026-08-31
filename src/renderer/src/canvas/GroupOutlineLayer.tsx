import { useEffect, useState, type RefObject } from 'react'
import type { Editor, TLShapeId } from 'tldraw'

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
        item.count === other.count
      )
    })
  )
}

/**
 * tldraw 原生 group 是一种父子状态，不是业务节点；这里仅补一层常驻视觉框。
 * 实际选择、移动、撤销和嵌套仍全部由 tldraw 的 groupShapes 管理。
 */
export function GroupOutlineLayer({ editor, hostRef }: GroupOutlineLayerProps): React.JSX.Element {
  const [outlines, setOutlines] = useState<GroupOutline[]>([])
  const [selection, setSelection] = useState<SelectionOutline | null>(null)

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
        next.push({
          id: shape.id,
          left: topLeft.x - hostBounds.left - 12,
          top: topLeft.y - hostBounds.top - 12,
          width: bottomRight.x - topLeft.x + 24,
          height: bottomRight.y - topLeft.y + 24,
          count
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
        left: topLeft.x - hostBounds.left - 12,
        top: topLeft.y - hostBounds.top - 12,
        width: bottomRight.x - topLeft.x + 24,
        height: bottomRight.y - topLeft.y + 24
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
          <span>分组 · {outline.count} 个节点</span>
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
