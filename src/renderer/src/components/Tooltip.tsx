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

export type TooltipPlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right'

export function Tooltip({
  label,
  children,
  placement = 'auto',
  anchorSelector
}: {
  label: string
  children: ReactElement<TooltipChildProps>
  /** auto 适合普通操作；图标栏可明确指定展示方向。 */
  placement?: TooltipPlacement
  /** 用子元素里的局部锚点定位，例如左栏只对齐图标而不是图标加标签。 */
  anchorSelector?: string
}): React.JSX.Element {
  const tooltipId = useId()
  const [position, setPosition] = useState<{
    top: number
    left: number
    side: Exclude<TooltipPlacement, 'auto'>
  } | null>(null)
  const show = (element: HTMLElement): void => {
    const anchor = anchorSelector
      ? (element.querySelector<HTMLElement>(anchorSelector) ?? element)
      : element
    const rect = anchor.getBoundingClientRect()
    // 普通工具栏默认垂直提示；左栏节点使用 right，避免遮住其它节点图标。
    const side: Exclude<TooltipPlacement, 'auto'> =
      placement === 'auto' ? (rect.top >= 48 ? 'top' : 'bottom') : placement
    const top =
      side === 'top'
        ? rect.top - 8
        : side === 'bottom'
          ? rect.bottom + 8
          : rect.top + rect.height / 2
    const left =
      side === 'left'
        ? rect.left - 10
        : side === 'right'
          ? rect.right + 10
          : Math.max(12, Math.min(window.innerWidth - 12, rect.left + rect.width / 2))
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
                transform:
                  position.side === 'top'
                    ? 'translate(-50%, -100%)'
                    : position.side === 'bottom'
                      ? 'translate(-50%, 0)'
                      : position.side === 'left'
                        ? 'translate(-100%, -50%)'
                        : 'translate(0, -50%)'
              }
            },
            label
          ),
          document.body
        )}
    </>
  )
}
