import type {
  AssetRef,
  Connection,
  FeatureBinding,
  MediaTask,
  ModelDefinition,
  ModelOperation,
  TaskEvent,
  VoiceResource
} from '@free-creation/model-contracts'
import type {
  ArtifactPort,
  ConfigurationPort,
  EventPort,
  SecretPort,
  TaskPort,
  ValidationPort,
  ValidationRecord,
  VoicePort
} from './ports.js'

const copy = <T>(value: T): T => structuredClone(value)
const validationKey = (connectionId: string, modelId: string, operation: ModelOperation) =>
  `${connectionId}\u0000${modelId}\u0000${operation}`

/** Test/demo host. Production hosts supply encrypted secrets and persistent stores. */
export class InMemoryModelHost
  implements ConfigurationPort, SecretPort, ValidationPort, TaskPort, ArtifactPort, VoicePort, EventPort
{
  readonly events: TaskEvent[] = []
  private readonly connections = new Map<string, Connection>()
  private readonly models = new Map<string, ModelDefinition>()
  private readonly bindings = new Map<string, FeatureBinding>()
  private readonly secrets = new Map<string, string>()
  private readonly validations = new Map<string, ValidationRecord>()
  private readonly tasks = new Map<string, MediaTask>()
  private readonly assets = new Map<string, AssetRef>()
  private readonly voices = new Map<string, VoiceResource>()

  setConnection(value: Connection, secret?: string): void {
    this.connections.set(value.id, copy(value))
    if (secret) this.secrets.set(value.id, secret)
  }
  setModel(value: ModelDefinition): void { this.models.set(value.id, copy(value)) }
  setBinding(value: FeatureBinding): void { this.bindings.set(value.featureKey, copy(value)) }
  async getConnection(id: string): Promise<Connection | null> { return this.connections.get(id) ? copy(this.connections.get(id)!) : null }
  async getModel(id: string): Promise<ModelDefinition | null> { return this.models.get(id) ? copy(this.models.get(id)!) : null }
  async getBinding(key: string): Promise<FeatureBinding | null> { return this.bindings.get(key) ? copy(this.bindings.get(key)!) : null }
  async readSecret(id: string): Promise<string | null> { return this.secrets.get(id) ?? null }
  async saveValidation(record: ValidationRecord): Promise<void> { this.validations.set(validationKey(record.connectionId, record.modelDefinitionId, record.operation), copy(record)) }
  async getValidation(connectionId: string, modelDefinitionId: string, operation: ModelOperation): Promise<ValidationRecord | null> {
    const value = this.validations.get(validationKey(connectionId, modelDefinitionId, operation))
    return value ? copy(value) : null
  }
  async saveTask(task: MediaTask): Promise<void> { this.tasks.set(task.id, copy(task)) }
  async loadTask(id: string): Promise<MediaTask | null> { return this.tasks.get(id) ? copy(this.tasks.get(id)!) : null }
  async saveAsset(asset: AssetRef): Promise<void> { this.assets.set(asset.id, copy(asset)) }
  async loadAsset(id: string): Promise<AssetRef | null> { return this.assets.get(id) ? copy(this.assets.get(id)!) : null }
  async saveVoice(voice: VoiceResource): Promise<void> { this.voices.set(voice.id, copy(voice)) }
  async loadVoice(id: string): Promise<VoiceResource | null> { return this.voices.get(id) ? copy(this.voices.get(id)!) : null }
  async emit(event: TaskEvent): Promise<void> { this.events.push(copy(event)) }
}
