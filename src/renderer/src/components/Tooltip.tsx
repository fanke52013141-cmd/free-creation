import {
  cloneElement,
  createElement,
  useId,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'

/**
 * 统一悬浮说明：渲染到 document.body，避免侧栏的滚动/裁切容器截断提示。
 * 它只负责说明，不接管按钮的点击、键盘或可访问性语义。
 */
type TooltipChildProps = {
  'aria-describedby'?: string
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
}

export function Tooltip({
  label,
  children
}: {
  label: string
  children: ReactElement<TooltipChildProps>
}): React.JSX.Element {
  const tooltipId = useId()
  const [position, setPosition] = useState<{
    top: number
    left: number
    side: 'top' | 'bottom'
  } | null>(null)
  const show = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    // 图标密集的 Dock 中，横向提示会遮住相邻操作。默认垂直向上，
    // 只有贴近窗口顶边时才向下展开。
    const side = rect.top >= 48 ? 'top' : 'bottom'
    const top = side === 'top' ? rect.top - 8 : rect.bottom + 8
    // 预留提示最大宽度，避免在窗口左右边缘先闪出屏幕。
    const left = Math.max(12, Math.min(window.innerWidth - 12, rect.left + rect.width / 2))
    setPosition({ top, left, side })
  }
  const hide = (): void => setPosition(null)
  const child = cloneElement(children, {
    'aria-describedby': children.props['aria-describedby']
      ? `${children.props['aria-describedby']} ${tooltipId}`
      : tooltipId,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event)
      show(event.currentTarget)
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event)
      hide()
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event)
      show(event.currentTarget)
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event)
      hide()
    }
  })
  return (
    <>
      {child}
      {position &&
        createPortal(
          createElement(
            'span',
            {
              id: tooltipId,
              className: 'app-tooltip',
              role: 'tooltip',
              style: {
                top: position.top,
                left: position.left,
                transform: `translate(-50%, ${position.side === 'top' ? '-100%' : '0'})`
              }
            },
            label
          ),
          document.body
        )}
    </>
  )
}
