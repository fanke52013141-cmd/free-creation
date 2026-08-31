import { useCallback, useRef } from 'react'

type Direction = 'vertical' | 'horizontal'

interface DockMagnifyOptions {
  /** 放大方向：纵向面板用 vertical，横向工具栏用 horizontal */
  direction: Direction
  /** 最大放大倍率，默认 1.4 */
  maxScale?: number
  /** 影响半径（px），超出此距离的项不放大，默认 85 */
  range?: number
}

/**
 * macOS Dock 风格的连续鱼眼放大效果。
 *
 * 监听鼠标在容器内的移动，根据每个 `.palette-item` 到鼠标的距离，
 * 用余弦曲线实时计算缩放比例——离鼠标越近放得越大，形成连续平滑的凸起曲线，
 * 完全复刻 macOS Dock 的手感。
 *
 * - 分离读写遍历，避免布局抖动（layout thrashing）
 * - requestAnimationFrame 合并，每帧最多计算一次
 * - 尊重 prefers-reduced-motion：用户偏好减少动画时不做任何放大
 */
export function useDockMagnify(
  containerRef: React.RefObject<HTMLElement | null>,
  options: DockMagnifyOptions
): {
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
} {
  const { direction, maxScale = 1.4, range = 85 } = options
  const rafRef = useRef<number | undefined>(undefined)
  const mousePosRef = useRef<number | null>(null)

  const applyMagnify = useCallback((): void => {
    rafRef.current = undefined
    const container = containerRef.current
    if (!container) return

    // 尊重用户的减少动画偏好
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const items = container.querySelectorAll<HTMLElement>('.palette-item')
    if (items.length === 0) return

    const mousePos = mousePosRef.current

    // 鼠标离开容器：恢复所有 item
    if (mousePos === null) {
      items.forEach((el) => {
        el.style.transform = ''
        el.style.zIndex = ''
      })
      return
    }

    // 第一阶段：读取所有 item 的中心位置（分离读写避免布局抖动）
    const centers: number[] = []
    items.forEach((el) => {
      const rect = el.getBoundingClientRect()
      centers.push(
        direction === 'vertical' ? rect.top + rect.height / 2 : rect.left + rect.width / 2
      )
    })

    // 第二阶段：计算并设置缩放
    items.forEach((el, i) => {
      const distance = Math.abs(centers[i] - mousePos)
      if (distance >= range) {
        el.style.transform = ''
        el.style.zIndex = ''
      } else {
        const ratio = distance / range
        // 余弦曲线：距离为 0 时放大到 maxScale，到 range 边缘平滑降至 1
        const magnification = (Math.cos(ratio * Math.PI) + 1) / 2
        const scale = 1 + (maxScale - 1) * magnification
        el.style.zIndex = scale > 1.02 ? '5' : ''
        el.style.transform = `scale(${scale.toFixed(3)})`
      }
    })
  }, [containerRef, direction, maxScale, range])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>): void => {
      mousePosRef.current = direction === 'vertical' ? e.clientY : e.clientX
      if (rafRef.current === undefined) {
        rafRef.current = requestAnimationFrame(applyMagnify)
      }
    },
    [direction, applyMagnify]
  )

  const onPointerLeave = useCallback((): void => {
    mousePosRef.current = null
    if (rafRef.current === undefined) {
      rafRef.current = requestAnimationFrame(applyMagnify)
    }
  }, [applyMagnify])

  return { onPointerMove, onPointerLeave }
}
