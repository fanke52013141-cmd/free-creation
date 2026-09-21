import type {
  Connection,
  ModelDefinition,
  ModelOperation,
  ModelTarget
} from '@free-creation/model-contracts'

export interface ProviderValidationFinding {
  status: 'verified' | 'failed' | 'unsupported'
  message: string
  action?: string
}

export interface ProviderValidationRequest {
  connection: Connection
  model: ModelDefinition
  target: ModelTarget
  operation: ModelOperation
  secret: string
  signal?: AbortSignal
}

/** A successful result proves the concrete connection + model + operation can be called. */
export interface ProviderAdapter {
  readonly id: string
  supports(operation: ModelOperation, model: ModelDefinition): boolean
  validate(request: ProviderValidationRequest): Promise<ProviderValidationFinding>
}
