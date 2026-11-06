// 通用「拖到画布」机制：pointer 阈值 + 全局 ghost + 落点判断。
// 资产卡片与资源库卡片复用同一套交互：点击与拖拽互不干扰，只有真正拖到画布才放置。
import { useCallback, useRef } from 'react'
import { create } from 'zustand'
import type { IconName } from '../components/Icon'

// 左侧节点面板宽度：pointerup 的 clientX 超过该值才视为落入画布区域。
export const CANVAS_DROP_EDGE = 72
const DRAG_THRESHOLD = 6

export interface DragGhostPayload {
  label: string
  icon?: IconName
  image?: string
}

interface DragGhostState {
  ghost: (DragGhostPayload & { x: number; y: number }) | null
  setGhost: (ghost: DragGhostState['ghost']) => void
}

export const useDragGhostStore = create<DragGhostState>((set) => ({
  ghost: null,
  setGhost: (ghost) => set({ ghost })
}))

export interface DragToCanvas {
  startDrag: (
    e: React.PointerEvent,
    payload: DragGhostPayload,
    onDrop: (x: number, y: number) => void
  ) => void
  handleClick: (cb: () => void) => void
}

export function useDragToCanvas(): DragToCanvas {
  const suppressClickRef = useRef(false)

  const startDrag = useCallback(
    (
      e: React.PointerEvent,
      payload: DragGhostPayload,
      onDrop: (x: number, y: number) => void
    ): void => {
      const startX = e.clientX
      const startY = e.clientY
      let dragged = false
      // 每次新的 pointer 交互都清掉上一轮可能残留的抑制标记。
      suppressClickRef.current = false

      const onMove = (ev: PointerEvent): void => {
        if (
          !dragged &&
          (Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
            Math.abs(ev.clientY - startY) > DRAG_THRESHOLD)
        ) {
          dragged = true
        }
        if (dragged) {
          useDragGhostStore.getState().setGhost({ ...payload, x: ev.clientX, y: ev.clientY })
        }
      }
      const onUp = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        useDragGhostStore.getState().setGhost(null)
        if (dragged) {
          // 抑制拖拽后紧接着派发的 click，避免一次拖拽既落点又触发点击动作。
          suppressClickRef.current = true
          if (ev.clientX > CANVAS_DROP_EDGE) onDrop(ev.clientX, ev.clientY)
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    []
  )

  const handleClick = useCallback((cb: () => void): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    cb()
  }, [])

  return { startDrag, handleClick }
}
