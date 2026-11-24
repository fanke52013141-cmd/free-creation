// 弹窗统一规范 v1.0 的统一壳组件（2026-11-21）。
// 全部新弹窗与分家族迁移的旧弹窗都走这里：三段式（标题栏/正文/底部操作栏）、
// 统一遮罩/容器/关闭按钮/按钮规格；焦点陷阱与 Esc 关闭在此一处实现。
// 规范依据：modal-audit-20261121/弹窗统一规范-v1.0.md。
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { claimEscapeForPopup } from './escape-owner'

export type ModalShellSize = 's' | 'm' | 'l' | 'xl' | 'fullscreen'

export interface ModalShellProps {
  /** 尺寸档位：s=400 确认 / m=560 表单 / l=760 管理台 / xl=全屏工作台（96vw×92vh）；
   *  fullscreen=真·铺满窗口的工作台（自带顶栏，配 hideHeader 用）；缺省 m */
  size?: ModalShellSize
  /** 标题（必填，名词短语） */
  title: string
  /** 可选眉题（11px 青色大写，如 WORKFLOW） */
  eyebrow?: string
  /** 可选语义图标：danger 时建议 'warning'，普通确认用 'info' */
  icon?: 'warning' | 'info'
  /** 危险语义：标题图标变红（主按钮是否红色由调用方选择 modal-btn-danger） */
  danger?: boolean
  onClose: () => void
  /** Esc 是否触发 onClose（busy 时传 false 防误触） */
  closeOnEscape?: boolean
  /** 点击遮罩是否关闭 */
  closeOnOverlay?: boolean
  /** 打开后聚焦的元素（如确认弹窗聚焦「取消」防键盘误触）；缺省聚焦弹窗容器 */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** 底部操作栏内容（按钮等）；不传则不渲染 footer */
  footer?: ReactNode
  /** 底部左侧辅助文字（如「3 个节点」）；与 footer 一起渲染 */
  footerLeft?: ReactNode
  /** 追加在容器上的类名：迁移期保留旧钩子类（如 workflow-save-dialog）供验收脚本定位 */
  className?: string
  /** 显式 aria-label（缺省用 title 作为可访问名称） */
  ariaLabel?: string
  /** 标题栏关闭钮左侧的动作按钮插槽（如「模型管理与验证」、全屏切换） */
  headerActions?: ReactNode
  /** 正文区附加类（面板型内容用 modal-shell-body--flush 去内边距、由内部窗格布局） */
  bodyClassName?: string
  /** 隐藏统一标题栏：自带工具栏的全屏工作台（如轨道线）用，仅统一遮罩与容器 */
  hideHeader?: boolean
  /** 正文内容 */
  children: ReactNode
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ModalShell(props: ModalShellProps): React.JSX.Element {
  const {
    size = 'm',
    title,
    eyebrow,
    icon,
    danger = false,
    onClose,
    closeOnEscape = true,
    closeOnOverlay = true,
    initialFocusRef,
    footer,
    footerLeft,
    className,
    ariaLabel,
    headerActions,
    bodyClassName,
    hideHeader = false,
    children
  } = props

  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // 焦点管理：打开时聚焦指定元素（缺省弹窗容器），Tab 循环不出弹窗，
  // Esc 关闭，关闭后焦点归还触发元素。逻辑自 ConfirmDialog 迁移，全弹窗共用。
  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    window.setTimeout(() => {
      const target = initialFocusRef?.current ?? dialogRef.current
      target?.focus()
    }, 0)

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 内层浮层（AppSelect 下拉、菜单）打开时，Esc 属于它：先让它关闭，
        // 不能在这里把整个弹窗关掉（否则下拉里按 Esc 会连弹窗一起消失）。
        const openPopup = document.querySelector(
          '[role="listbox"][data-state="open"], [role="menu"][data-state="open"]'
        )
        if (openPopup) {
          // 捕获阶段浮层仍在：登记本次 Esc 归浮层，页面级快捷键不再关外层。
          claimEscapeForPopup()
          return
        }
        if (closeOnEscape) {
          event.preventDefault()
          onClose()
        }
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    // 用捕获阶段监听：正文内的按键即使 stopPropagation（画布快捷键防护）也不影响 Esc/Tab。
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createPortal(
    <div
      className={
        size === 'fullscreen' ? 'modal-shell-overlay modal-shell-overlay--fullscreen' : 'modal-shell-overlay'
      }
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        if (closeOnOverlay && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className={className ? `modal-shell ${className}` : 'modal-shell'}
        data-size={size}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {!hideHeader && (
          <header className="modal-shell-header">
            {icon && (
              <span className={`modal-shell-title-icon${danger ? ' is-danger' : ''}`} aria-hidden="true">
                <Icon name={icon} size={20} />
              </span>
            )}
            <div className="modal-shell-heading">
              {eyebrow && <div className="modal-shell-eyebrow">{eyebrow}</div>}
              <h2 className="modal-shell-title" id={titleId}>
                {title}
              </h2>
            </div>
            {headerActions}
            <button
              type="button"
              className="modal-shell-close"
              aria-label="关闭"
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
        )}
        <div className={bodyClassName ? `modal-shell-body ${bodyClassName}` : 'modal-shell-body'}>
          {children}
        </div>
        {footer && (
          <footer className="modal-shell-footer">
            {footerLeft && <div className="modal-shell-footer-left">{footerLeft}</div>}
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body
  )
}
