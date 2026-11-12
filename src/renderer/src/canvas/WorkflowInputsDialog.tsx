import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkflowInput } from '@shared/agent-access/run-ops'
import type { WorkflowInputGap } from '../engine/workflow-inputs'
import { usePendingInputs, type PendingInputs } from '../stores/workflowInput'
import { PortInputField } from './PortInputField'

type InputValue = WorkflowInput['value']
const keyOf = (nodeId: string, portId: string): string => `${nodeId}:${portId}`

function InputsForm({ request }: { request: PendingInputs }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [values, setValues] = useState<Record<string, InputValue | null>>({})

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  // 按节点分组，保持缺口顺序。
  const groups = useMemo(() => {
    const map = new Map<string, { nodeId: string; title: string; gaps: WorkflowInputGap[] }>()
    for (const gap of request.gaps) {
      const entry = map.get(gap.nodeId) ?? { nodeId: gap.nodeId, title: gap.title, gaps: [] }
      entry.gaps.push(gap)
      map.set(gap.nodeId, entry)
    }
    return [...map.values()]
  }, [request.gaps])

  const missingRequired = request.gaps.filter(
    (gap) => gap.port.required && !values[keyOf(gap.nodeId, gap.port.id)]
  )
  const canSubmit = missingRequired.length === 0

  const submit = (): void => {
    if (!canSubmit) return
    const inputs: WorkflowInput[] = []
    for (const gap of request.gaps) {
      const value = values[keyOf(gap.nodeId, gap.port.id)]
      if (value) inputs.push({ nodeId: gap.nodeId, portId: gap.port.id, value })
    }
    request.finish(inputs)
  }

  return (
    <dialog
      className="workflow-input-dialog workflow-inputs-dialog"
      ref={dialog}
      aria-labelledby="workflow-inputs-title"
      onCancel={(event) => {
        event.preventDefault()
        request.finish(null)
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <form
        className="confirm-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div id="workflow-inputs-title" className="confirm-title">
          补充运行输入
        </div>
        <p className="workflow-inputs-hint">
          填写以下必备输入后开始运行；标注「可选」的项可留空跳过。
        </p>
        <div className="workflow-inputs-groups">
          {groups.map((group) => (
            <section key={group.nodeId} className="workflow-inputs-group">
              <header className="workflow-inputs-group-title">{group.title}</header>
              {group.gaps.map((gap) => {
                const key = keyOf(gap.nodeId, gap.port.id)
                return (
                  <label key={key} className="workflow-inputs-row">
                    <span className="workflow-inputs-label">
                      {gap.port.name}
                      <em className={gap.port.required ? 'is-required' : 'is-optional'}>
                        {gap.port.required ? '必填' : '可选'}
                      </em>
                    </span>
                    <PortInputField
                      projectId={request.projectId}
                      port={gap.port}
                      value={values[key] ?? null}
                      onChange={(value) => setValues((prev) => ({ ...prev, [key]: value }))}
                    />
                  </label>
                )
              })}
            </section>
          ))}
        </div>
        {!canSubmit && (
          <div role="alert" className="workflow-input-error">
            还需填写：{missingRequired.map((gap) => `${gap.title} · ${gap.port.name}`).join('、')}
          </div>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn-ghost" onClick={() => request.finish(null)}>
            取消运行
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            开始运行
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function WorkflowInputsDialog(): React.JSX.Element | null {
  const request = usePendingInputs((state) => state.request)
  useEffect(() => () => usePendingInputs.getState().request?.finish(null), [])
  return request
    ? createPortal(<InputsForm key={request.id} request={request} />, document.body)
    : null
}
