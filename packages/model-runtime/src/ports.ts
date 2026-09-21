import type {
  AssetRef,
  Connection,
  FeatureBinding,
  MediaTask,
  ModelDefinition,
  ModelOperation,
  ModelTarget,
  TaskEvent,
  ValidationStatus,
  VoiceResource
} from '@free-creation/model-contracts'

export interface ValidationRecord {
  connectionId: string
  modelDefinitionId: string
  operation: ModelOperation
  status: ValidationStatus
  message?: string
  action?: string
  checkedAt: string
  verifiedAt?: string
}

export interface ConfigurationPort {
  getConnection(connectionId: string): Promise<Connection | null>
  getModel(modelDefinitionId: string): Promise<ModelDefinition | null>
  getBinding(featureKey: string): Promise<FeatureBinding | null>
}

export interface SecretPort {
  readSecret(connectionId: string): Promise<string | null>
}

export interface ValidationPort {
  getValidation(connectionId: string, modelDefinitionId: string, operation: ModelOperation): Promise<ValidationRecord | null>
  saveValidation(record: ValidationRecord): Promise<void>
}

export interface TaskPort {
  loadTask(id: string): Promise<MediaTask | null>
  saveTask(task: MediaTask): Promise<void>
}

export interface ArtifactPort {
  loadAsset(id: string): Promise<AssetRef | null>
  saveAsset(asset: AssetRef): Promise<void>
}

export interface VoicePort {
  loadVoice(id: string): Promise<VoiceResource | null>
  saveVoice(voice: VoiceResource): Promise<void>
}

export interface EventPort {
  emit(event: TaskEvent): Promise<void>
}

export interface RuntimePorts {
  configuration: ConfigurationPort
  secrets: SecretPort
  validations: ValidationPort
  tasks: TaskPort
  artifacts: ArtifactPort
  voices?: VoicePort
  events?: EventPort
}

export interface ResolvedModelTarget {
  connection: Connection
  model: ModelDefinition
  target: ModelTarget
  operation: ModelOperation
  secret: string
}
