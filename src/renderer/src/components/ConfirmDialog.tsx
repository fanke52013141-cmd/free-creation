// 深色风格确认弹窗：替代 window.confirm，与 LibTV 风格一致
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useConfirmStore } from '../stores/confirm'

export function ConfirmDialog(): React.JSX.Element | null {
  const options = useConfirmStore((s) => s.options)
  const resolve = useConfirmStore((s) => s.resolve)

  // ESC → 取消
  useEffect(() => {
    if (!options) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') resolve(false)
      if (e.key === 'Enter') resolve(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [options, resolve])

  if (!options) return null

  return createPortal(
    <div
      className="confirm-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) resolve(false)
      }}
    >
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-icon">{options.danger ? '⚠️' : '❓'}</div>
        <div className="confirm-body">
          <div className="confirm-title">{options.title}</div>
          {options.message && <div className="confirm-message">{options.message}</div>}
        </div>
        <div className="confirm-actions">
          <button className="confirm-btn cancel" onClick={() => resolve(false)}>
            {options.cancelText ?? '取消'}
          </button>
          <button
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
