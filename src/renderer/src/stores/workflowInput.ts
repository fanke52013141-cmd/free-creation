import { create } from 'zustand'
import type { WorkflowInput } from '@shared/agent-access/run-ops'
import type { RequestWorkflowInput } from '../engine/workflow-inputs'

type InputRequest = Parameters<RequestWorkflowInput>[0]
type InputValue = WorkflowInput['value']
export type Pending = InputRequest & { id: string; finish: (value: InputValue | null) => void }
export const usePendingInput = create<{ request: Pending | null }>(() => ({ request: null }))

export const requestWorkflowInput: RequestWorkflowInput = (request) => new Promise((resolve) => {
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
