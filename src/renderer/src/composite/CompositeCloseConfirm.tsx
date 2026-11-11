import { Icon } from '../components/Icon'

interface Props {
  capabilityName: string
  busy: boolean
  onSaveAndClose: () => void
  onDiscard: () => void
  onContinue: () => void
}

/**
 * 关闭全屏编辑时的未保存确认（W2-B，Stitch 屏幕 acfa2724bc7f458c9efeee646466016d）：
 * 保存并关闭 / 放弃修改 / 继续编辑。保存失败时停留在全屏编辑并展示问题。
 */
export function CompositeCloseConfirm({
  capabilityName,
  busy,
  onSaveAndClose,
  onDiscard,
  onContinue
}: Props): React.JSX.Element {
  return (
    <div
      className="composite-modal-mask"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onContinue()}
    >
      <section
        className="composite-modal composite-close-confirm"
        role="dialog"
        aria-modal="true"
        aria-label="有未保存的修改"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !busy) onContinue()
        }}
      >
        <header className="composite-modal-header">
          <h3>有未保存的修改</h3>
          <button
            type="button"
            className="composite-modal-close"
            aria-label="关闭确认弹窗"
            disabled={busy}
            onClick={onContinue}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="composite-modal-scroll">
          <p className="composite-close-confirm-text">
            节点流「{capabilityName}」的内部图或公开端口已修改，尚未保存草稿。关闭前要保存吗？
          </p>
        </div>
        <footer className="composite-modal-footer is-three">
          <button
            type="button"
            className="btn-ghost small composite-close-discard"
            disabled={busy}
            onClick={onDiscard}
          >
            放弃修改
          </button>
          <button
            type="button"
            className="btn-ghost small"
            disabled={busy}
            onClick={onContinue}
          >
            继续编辑
          </button>
          <button
            type="button"
            className="run-btn"
            disabled={busy}
            onClick={onSaveAndClose}
          >
            {busy ? '保存中…' : '保存并关闭'}
          </button>
        </footer>
      </section>
    </div>
  )
}