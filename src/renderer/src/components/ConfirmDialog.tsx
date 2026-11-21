// 统一确认弹窗：ModalShell S 档封装，替代 window.confirm。
// API 保持 useConfirmStore 不变（全应用 30 个调用点零改动）。
// 视觉走弹窗统一规范：S 400px / 语义图标 / 右上关闭钮 / 底部右对齐按钮。
import { useRef } from 'react'
import { useConfirmStore } from '../stores/confirm'
import { ModalShell } from './ModalShell'
import { modalBtn } from './modal-btn'

export function ConfirmDialog(): React.JSX.Element | null {
  const options = useConfirmStore((s) => s.options)
  const resolve = useConfirmStore((s) => s.resolve)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  if (!options) return null

  // 危险操作默认聚焦「取消」，避免键盘误触直接执行不可恢复动作。
  const initialFocusRef = options.danger ? cancelRef : confirmRef

  return (
    <ModalShell
      size="s"
      title={options.title}
      icon={options.danger ? 'warning' : 'info'}
      danger={options.danger}
      onClose={() => resolve(false)}
      initialFocusRef={initialFocusRef}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className={modalBtn('secondary')}
            onClick={() => resolve(false)}
          >
            {options.cancelText ?? '取消'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={modalBtn(options.danger ? 'danger' : 'primary')}
            onClick={() => resolve(true)}
          >
            {options.confirmText ?? '确定'}
          </button>
        </>
      }
    >
      {options.message ? <p className="modal-shell-message">{options.message}</p> : null}
    </ModalShell>
  )
}
