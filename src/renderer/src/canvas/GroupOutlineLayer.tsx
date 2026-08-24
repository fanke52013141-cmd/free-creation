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
    </div>
  )
}
