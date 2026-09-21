import type { ModelErrorCode } from '@free-creation/model-contracts'

export class ModelRuntimeError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
    public readonly action?: string
  ) {
    super(message)
    this.name = 'ModelRuntimeError'
  }
}
