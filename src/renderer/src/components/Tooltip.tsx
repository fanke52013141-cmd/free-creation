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
    side: 'left' | 'right'
  } | null>(null)
  const show = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    const top = Math.max(12, Math.min(window.innerHeight - 12, rect.top + rect.height / 2))
    // 不先渲染再测量，避免 tooltip 在边缘先闪到屏幕外；宽度按设计令牌的上限预留。
    const side = window.innerWidth - rect.right < 228 ? 'left' : 'right'
    setPosition({ top, left: side === 'right' ? rect.right + 10 : rect.left - 10, side })
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
                transform: `translate(${position.side === 'left' ? '-100%' : '0'}, -50%)`
              }
            },
            label
          ),
          document.body
        )}
    </>
  )
}
