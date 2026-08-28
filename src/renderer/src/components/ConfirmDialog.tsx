// 深色风格确认弹窗：替代 window.confirm，与 LibTV 风格一致
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useConfirmStore } from '../stores/confirm'
import { Icon } from './Icon'

export function ConfirmDialog(): React.JSX.Element | null {
  const options = useConfirmStore((s) => s.options)
  const resolve = useConfirmStore((s) => s.resolve)
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // 对话框拥有焦点、Esc 可撤销、Tab 不会跳到遮罩后的画布。危险操作默认聚焦
  // 「取消」，避免键盘误触直接执行不可恢复动作。
  useEffect(() => {
    if (!options) return
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const initialFocus = options.danger ? cancelRef.current : confirmRef.current
    window.setTimeout(() => initialFocus?.focus(), 0)

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolve(false)
        return
      }
      if (e.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [options, resolve])

  if (!options) return null

  return createPortal(
    <div
      className="confirm-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) resolve(false)
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={options.message ? 'confirm-dialog-message' : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-icon">
          <Icon name={options.danger ? 'warning' : 'help'} size={24} />
        </div>
        <div className="confirm-body">
          <div className="confirm-title" id="confirm-dialog-title">
            {options.title}
          </div>
          {options.message && (
            <div className="confirm-message" id="confirm-dialog-message">
              {options.message}
            </div>
          )}
        </div>
        <div className="confirm-actions">
          <button ref={cancelRef} className="confirm-btn cancel" onClick={() => resolve(false)}>
            {options.cancelText ?? '取消'}
          </button>
          <button
            ref={confirmRef}
            className={`confirm-btn ${options.danger ? 'danger' : 'primary'}`}
            onClick={() => resolve(true)}
          >
            {options.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
