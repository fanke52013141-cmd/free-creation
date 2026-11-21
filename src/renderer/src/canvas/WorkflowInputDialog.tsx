// 运行前补充单个缺失输入。2026-11-21 弹窗统一：原生 <dialog> 并入 ModalShell，
// 关闭通道（Esc/遮罩/右上 X/取消按钮）统一走 request.finish(null)。
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { WorkflowInput } from '@shared/agent-access/run-ops'
import { usePendingInput, type Pending } from '../stores/workflowInput'
import { PortInputField } from './PortInputField'
import { ModalShell } from '../components/ModalShell'
import { modalBtn } from '../components/modal-btn'

type InputValue = WorkflowInput['value']

function InputForm({ request }: { request: Pending }): React.JSX.Element {
  const [value, setValue] = useState<InputValue | null>(null)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (value) request.finish(value)
  }

  // 与旧原生 dialog 一致：弹窗内的按键不向外冒泡，避免触发画布快捷键。
  const swallowKeys = (event: KeyboardEvent): void => event.stopPropagation()

  return (
    <ModalShell
      size="m"
      title="补充运行输入"
      onClose={() => request.finish(null)}
      footer={
        <>
          <button type="button" className={modalBtn('secondary')} onClick={() => request.finish(null)}>
            取消运行
          </button>
          <button type="submit" form="workflow-input-form" className={modalBtn('primary')} disabled={!value}>
            继续运行
          </button>
        </>
      }
    >
      <form id="workflow-input-form" onSubmit={submit} onKeyDown={swallowKeys}>
        <label className="workflow-input-field modal-field">
          <span>
            {request.title} · {request.port.name}
          </span>
          <PortInputField
            projectId={request.projectId}
            port={request.port}
            value={value}
            onChange={setValue}
          />
        </label>
      </form>
    </ModalShell>
  )
}

export function WorkflowInputDialog(): React.JSX.Element | null {
  const request = usePendingInput((state) => state.request)
  useEffect(() => () => usePendingInput.getState().request?.finish(null), [])
  return request
    ? createPortal(<InputForm key={request.id} request={request} />, document.body)
    : null
}
