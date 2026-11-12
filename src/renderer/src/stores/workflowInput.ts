import { create } from 'zustand'
import type { WorkflowInput } from '@shared/agent-access/run-ops'
import type {
  RequestWorkflowInput,
  RequestWorkflowInputs,
  WorkflowInputOptions
} from '../engine/workflow-inputs'

type InputRequest = Parameters<RequestWorkflowInput>[0]
type InputValue = WorkflowInput['value']
export type Pending = InputRequest & { id: string; finish: (value: InputValue | null) => void }
export const usePendingInput = create<{ request: Pending | null }>(() => ({ request: null }))

export const requestWorkflowInput: RequestWorkflowInput = (request) =>
  new Promise((resolve) => {
    let unsubscribe = (): void => undefined
    const pending: Pending = {
      ...request,
      id: crypto.randomUUID(),
      finish(value) {
        if (usePendingInput.getState().request !== pending) return
        usePendingInput.setState({ request: null })
        unsubscribe()
        resolve(value)
      }
    }
    usePendingInput.getState().request?.finish(null)
    usePendingInput.setState({ request: pending })
    unsubscribe = request.onCancel(() => pending.finish(null))
  })

/** 批量汇总补输入：与单端口槽并存，GUI 优先走此路径。 */
type InputsRequest = Parameters<RequestWorkflowInputs>[0]
export type PendingInputs = InputsRequest & {
  id: string
  finish: (values: readonly WorkflowInput[] | null) => void
}
export const usePendingInputs = create<{ request: PendingInputs | null }>(() => ({ request: null }))

export const requestWorkflowInputs: RequestWorkflowInputs = (request) =>
  new Promise((resolve) => {
    let unsubscribe = (): void => undefined
    const pending: PendingInputs = {
      ...request,
      id: crypto.randomUUID(),
      finish(values) {
        if (usePendingInputs.getState().request !== pending) return
        usePendingInputs.setState({ request: null })
        unsubscribe()
        resolve(values)
      }
    }
    usePendingInputs.getState().request?.finish(null)
    usePendingInputs.setState({ request: pending })
    unsubscribe = request.onCancel(() => pending.finish(null))
  })

/** GUI 运行统一补输入选项：汇总表单优先，单端口兜底。Agent/CLI/组合内部路径不使用。 */
export const guiWorkflowInputOptions: WorkflowInputOptions = {
  requestInput: requestWorkflowInput,
  requestInputs: requestWorkflowInputs
}
