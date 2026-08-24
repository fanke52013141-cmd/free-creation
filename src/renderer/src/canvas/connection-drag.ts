// 连线拖拽控制（非组件模块）：pointerdown 时同步挂载 window 监听，
// 监听必须先于后续 pointer 事件就绪；松手交给 CanvasEditor 注册的回调
import type { ConnectionFrom, Pt } from '../stores/connection'
import { useConnectionStore } from '../stores/connection'

export interface ConnectionFinish {
  from: ConnectionFrom
  startPt: Pt
  screenPt: Pt
}

let finishHandler: ((r: ConnectionFinish) => void) | null = null
let detachListeners: (() => void) | null = null

export function setConnectionFinishHandler(fn: ((r: ConnectionFinish) => void) | null): void {
  finishHandler = fn
}

/** 从输出端口开始拖线（由端口 pointerdown 调用，同步挂载监听） */
export function beginConnectionDrag(from: ConnectionFrom, pt: Pt): void {
  detachListeners?.()
  useConnectionStore.getState().start(from, pt)

  const onMove = (e: PointerEvent): void => {
    useConnectionStore.getState().move({ x: e.clientX, y: e.clientY })
  }
  const onUp = (e: PointerEvent): void => {
    const current = useConnectionStore.getState().draft
    cleanup()
    useConnectionStore.getState().clear()
    if (!current) return
    // 原地点击端口（无拖动）不算拉线，静默取消
    const moved = Math.abs(e.clientX - current.startPt.x) + Math.abs(e.clientY - current.startPt.y)
    if (moved < 4) return
    finishHandler?.({
      from: current.from,
      startPt: current.startPt,
      screenPt: { x: e.clientX, y: e.clientY }
    })
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      cleanup()
      useConnectionStore.getState().clear()
    }
  }
  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('keydown', onKey)
    if (detachListeners === cleanup) detachListeners = null
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('keydown', onKey)
  detachListeners = cleanup
}

/** 画布页卸载时兜底清理（防监听残留） */
export function teardownConnectionDrag(): void {
  detachListeners?.()
  detachListeners = null
  finishHandler = null
  useConnectionStore.getState().clear()
}
