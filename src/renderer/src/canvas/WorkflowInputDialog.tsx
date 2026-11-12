import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { WorkflowInput } from '@shared/agent-access/run-ops'
import { usePendingInput, type Pending } from '../stores/workflowInput'
import { PortInputField } from './PortInputField'

type InputValue = WorkflowInput['value']

function InputForm({ request }: { request: Pending }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState<InputValue | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (value) request.finish(value)
  }

  return (
    <dialog
      className="workflow-input-dialog"
      ref={dialog}
      aria-labelledby="workflow-input-title"
      onCancel={(event) => {
        event.preventDefault()
        request.finish(null)
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <form className="confirm-dialog" onSubmit={submit}>
        <div id="workflow-input-title" className="confirm-title">
          补充运行输入
        </div>
        <label className="workflow-input-field">
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
        <div className="confirm-actions">
          <button type="button" className="btn-ghost" onClick={() => request.finish(null)}>
            取消运行
          </button>
          <button type="submit" className="btn-primary" disabled={!value}>
            继续运行
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function WorkflowInputDialog(): React.JSX.Element | null {
  const request = usePendingInput((state) => state.request)
  useEffect(() => () => usePendingInput.getState().request?.finish(null), [])
  return request
    ? createPortal(<InputForm key={request.id} request={request} />, document.body)
    : null
}
