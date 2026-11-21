// 运行前按节点分组补充全部缺失输入。2026-11-21 弹窗统一：原生 <dialog> 并入
// ModalShell；关闭通道（Esc/遮罩/右上 X/取消按钮）统一走 request.finish(null)。
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { WorkflowInput } from '@shared/agent-access/run-ops'
import type { WorkflowInputGap } from '../engine/workflow-inputs'
import { usePendingInputs, type PendingInputs } from '../stores/workflowInput'
import { PortInputField } from './PortInputField'
import { ModalShell } from '../components/ModalShell'
import { modalBtn } from '../components/modal-btn'

type InputValue = WorkflowInput['value']
const keyOf = (nodeId: string, portId: string): string => `${nodeId}:${portId}`

function InputsForm({ request }: { request: PendingInputs }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, InputValue | null>>({})

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
          <button type="submit" form="workflow-inputs-form" className={modalBtn('primary')} disabled={!canSubmit}>
            开始运行
          </button>
        </>
      }
    >
      <form
        id="workflow-inputs-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={swallowKeys}
      >
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
      </form>
    </ModalShell>
  )
}

export function WorkflowInputsDialog(): React.JSX.Element | null {
  const request = usePendingInputs((state) => state.request)
  useEffect(() => () => usePendingInputs.getState().request?.finish(null), [])
  return request
    ? createPortal(<InputsForm key={request.id} request={request} />, document.body)
    : null
}
