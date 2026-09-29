// Desktop host for the new model module. It starts from its own tables and never reads or
// converts the legacy gateway providers table. Provider adapters receive secrets only through
// readSecret(); renderer and model catalog callers only receive the redacted Connection shape.
import type {
  AssetRef,
  Capability,
  Connection,
  FeatureBinding,
  JsonValue,
  MediaTask,
  ModelDefinition,
  ModelOperation,
  ModelTarget,
  VoiceResource
} from '@free-creation/model-contracts'
import type {
  ArtifactPort,
  ConfigurationPort,
  SecretPort,
  TaskPort,
  ValidationPort,
  ValidationRecord,
  VoicePort
} from '@free-creation/model-runtime'
import { decryptSecret, encryptSecret } from '../gateway/keycrypto'

interface Statement {
  get(...values: unknown[]): unknown
  all(...values: unknown[]): unknown
  run(...values: unknown[]): unknown
}

export interface ModelHostDatabase {
  prepare(sql: string): Statement
}

export interface ModelCatalogConnectionInput {
  id: string
  name: string
  protocol: Connection['protocol']
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  metadata?: Record<string, unknown>
  enabled?: boolean
}

export interface ModelCatalogModelInput {
  id: string
  connectionId: string
  name: string
  modelId: string
  capabilities: Capability[]
  metadata?: Record<string, unknown>
  enabled?: boolean
}

export interface ModelFeatureBindingInput {
  featureKey: string
  connectionId: string
  modelDefinitionId: string
  operation: ModelOperation
  enabled?: boolean
  overrides?: Record<string, JsonValue>
}

interface ConnectionRow {
  id: string
  name: string
  protocol: Connection['protocol']
  base_url: string
  secret_ref: string | null
  headers_json: string
  metadata_json: string
  enabled: number
  created_at: string
  updated_at: string
}

interface ModelRow {
  id: string
  connection_id: string
  model_id: string
  name: string
  capabilities_json: string
  metadata_json: string
  enabled: number
}

const json = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T } catch { return fallback }
}

/**
 * Implements the storage ports used by ModelRuntime. It deliberately keeps the key outside
 * Connection.auth so the renderer-facing catalog can never accidentally serialize a provider key.
 */
export class SqliteModelHost
  implements ConfigurationPort, SecretPort, ValidationPort, TaskPort, ArtifactPort, VoicePort
{
  private readonly tasks = new Map<string, MediaTask>()
  private readonly assets = new Map<string, AssetRef>()
  private readonly voices = new Map<string, VoiceResource>()

  constructor(private readonly db: ModelHostDatabase) {}

  listConnections(): Connection[] {
    const rows = this.db.prepare('SELECT * FROM model_connections ORDER BY updated_at DESC').all() as ConnectionRow[]
    return rows.map((row) => this.connectionFromRow(row))
  }

  listModels(connectionId?: string): ModelDefinition[] {
    const rows = (connectionId
      ? this.db.prepare('SELECT * FROM model_definitions WHERE connection_id = ? ORDER BY name').all(connectionId)
      : this.db.prepare('SELECT * FROM model_definitions ORDER BY name').all()) as ModelRow[]
    return rows.map((row) => this.modelFromRow(row))
  }

  listBindings(): FeatureBinding[] {
    const rows = this.db.prepare('SELECT * FROM model_feature_bindings WHERE enabled = 1 ORDER BY feature_key').all() as Array<{ feature_key: string; connection_id: string; model_definition_id: string; operation: ModelOperation; enabled: number; overrides_json: string; updated_at: string }>
    return rows.flatMap((row) => {
      const model = this.db.prepare('SELECT model_id FROM model_definitions WHERE id = ?').get(row.model_definition_id) as { model_id: string } | undefined
      return model ? [{ featureKey: row.feature_key, modelDefinitionId: row.model_definition_id, target: { connectionId: row.connection_id, modelId: model.model_id, operation: row.operation }, enabled: Boolean(row.enabled), overrides: json(row.overrides_json, {}), updatedAt: row.updated_at }] : []
    })
  }

  saveConnection(input: ModelCatalogConnectionInput): Connection {
    const now = new Date().toISOString()
    const existing = this.db.prepare('SELECT secret_ref, created_at, protocol, base_url, headers_json FROM model_connections WHERE id = ?').get(input.id) as { secret_ref: string | null; created_at: string; protocol: string; base_url: string; headers_json: string } | undefined
    const secret = input.apiKey?.trim() ? encryptSecret(input.apiKey.trim()) : (existing?.secret_ref ?? null)
    const nextUrl = input.baseUrl.replace(/\/+$/, '')
    const nextHeaders = JSON.stringify(input.headers ?? {})
    const connectionChanged = Boolean(existing && (
      existing.protocol !== input.protocol || existing.base_url !== nextUrl ||
      existing.headers_json !== nextHeaders || Boolean(input.apiKey?.trim())
    ))
    this.db.prepare(`INSERT INTO model_connections (id, name, protocol, base_url, secret_ref, headers_json, metadata_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, protocol=excluded.protocol, base_url=excluded.base_url,
        secret_ref=excluded.secret_ref, headers_json=excluded.headers_json, metadata_json=excluded.metadata_json,
        enabled=excluded.enabled, updated_at=excluded.updated_at`).run(
      input.id, input.name.trim(), input.protocol, nextUrl, secret,
      nextHeaders, JSON.stringify(input.metadata ?? {}), input.enabled === false ? 0 : 1,
      existing?.created_at ?? now, now
    )
    if (connectionChanged) {
      this.db.prepare('DELETE FROM model_validations WHERE connection_id = ?').run(input.id)
      this.db.prepare('DELETE FROM model_feature_bindings WHERE connection_id = ?').run(input.id)
    }
    return this.connectionFromRow(this.db.prepare('SELECT * FROM model_connections WHERE id = ?').get(input.id) as ConnectionRow)
  }

  saveModel(input: ModelCatalogModelInput): ModelDefinition {
    if (!input.capabilities.length) throw new Error('模型至少需要声明一项调用能力')
    const connection = this.db.prepare('SELECT id FROM model_connections WHERE id = ?').get(input.connectionId)
    if (!connection) throw new Error('模型连接不存在')
    const now = new Date().toISOString()
    // A model is one configured target that may implement several operations. The UI adds
    // capabilities incrementally, so locate by the stable connection+upstream-model key first.
    const existing = this.db.prepare('SELECT id, connection_id, model_id, created_at, capabilities_json FROM model_definitions WHERE id = ? OR (connection_id = ? AND model_id = ?)').get(input.id, input.connectionId, input.modelId.trim()) as { id: string; connection_id: string; model_id: string; created_at: string; capabilities_json: string } | undefined
    const previousCapabilities = existing ? json<Capability[]>(existing.capabilities_json, []) : []
    // Editing an existing definition replaces its declared capabilities. Adding an already
    // configured upstream model merges operations, with the incoming declaration taking precedence.
    const mergedCapabilities = existing?.id === input.id
      ? input.capabilities
      : [...previousCapabilities.filter((old) => !input.capabilities.some((next) => next.operation === old.operation)), ...input.capabilities]
    const definitionId = existing?.id ?? input.id
    const changedOperations = new Set<ModelOperation>()
    if (existing) {
      for (const old of previousCapabilities) {
        const next = mergedCapabilities.find((item) => item.operation === old.operation)
        if (!next || JSON.stringify(next) !== JSON.stringify(old) || existing.connection_id !== input.connectionId || existing.model_id !== input.modelId.trim()) changedOperations.add(old.operation)
      }
      for (const next of mergedCapabilities) {
        if (!previousCapabilities.some((old) => old.operation === next.operation)) changedOperations.add(next.operation)
      }
    }
    this.db.prepare(`INSERT INTO model_definitions (id, connection_id, model_id, name, capabilities_json, metadata_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET connection_id=excluded.connection_id, model_id=excluded.model_id, name=excluded.name,
        capabilities_json=excluded.capabilities_json, metadata_json=excluded.metadata_json, enabled=excluded.enabled, updated_at=excluded.updated_at`).run(
      definitionId, input.connectionId, input.modelId.trim(), input.name.trim(), JSON.stringify(mergedCapabilities),
      JSON.stringify(input.metadata ?? {}), input.enabled === false ? 0 : 1, existing?.created_at ?? now, now
    )
    for (const operation of changedOperations) {
      this.db.prepare('DELETE FROM model_validations WHERE model_definition_id = ? AND operation = ?').run(definitionId, operation)
      this.db.prepare('DELETE FROM model_feature_bindings WHERE model_definition_id = ? AND operation = ?').run(definitionId, operation)
    }
    return this.modelFromRow(this.db.prepare('SELECT * FROM model_definitions WHERE id = ?').get(definitionId) as ModelRow)
  }

  /** Removes a configured model and every local record that can make it executable. */
  deleteModel(modelDefinitionId: string): boolean {
    const existing = this.db.prepare('SELECT id FROM model_definitions WHERE id = ?').get(modelDefinitionId)
    if (!existing) return false
    this.db.prepare('DELETE FROM model_feature_bindings WHERE model_definition_id = ?').run(modelDefinitionId)
    this.db.prepare('DELETE FROM model_validations WHERE model_definition_id = ?').run(modelDefinitionId)
    this.db.prepare('DELETE FROM model_definitions WHERE id = ?').run(modelDefinitionId)
    return true
  }

  /** Used by the catalog's batch action. Each deletion also clears stale bindings/validation. */
  deleteModels(modelDefinitionIds: string[]): number {
    return [...new Set(modelDefinitionIds)].reduce(
      (count, modelDefinitionId) => count + (this.deleteModel(modelDefinitionId) ? 1 : 0),
      0
    )
  }

  /** A connection cannot leave models behind: remove its model records before the connection. */
  deleteConnection(connectionId: string): boolean {
    const existing = this.db.prepare('SELECT id FROM model_connections WHERE id = ?').get(connectionId)
    if (!existing) return false
    this.listModels(connectionId).forEach((model) => this.deleteModel(model.id))
    this.db.prepare('DELETE FROM model_connections WHERE id = ?').run(connectionId)
    return true
  }

  saveBinding(input: ModelFeatureBindingInput): FeatureBinding {
    const model = this.db.prepare('SELECT model_id, connection_id FROM model_definitions WHERE id = ?').get(input.modelDefinitionId) as { model_id: string; connection_id: string } | undefined
    if (!model || model.connection_id !== input.connectionId) throw new Error('功能引用的模型不存在或不属于该连接')
    const validation = this.db.prepare(`SELECT status FROM model_validations
      WHERE connection_id = ? AND model_definition_id = ? AND operation = ?`).get(
      input.connectionId, input.modelDefinitionId, input.operation
    ) as { status: string } | undefined
    if (validation?.status !== 'verified') throw new Error('该模型能力尚未通过验证，不能被功能引用')
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO model_feature_bindings (feature_key, connection_id, model_definition_id, operation, enabled, overrides_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feature_key) DO UPDATE SET connection_id=excluded.connection_id, model_definition_id=excluded.model_definition_id,
        operation=excluded.operation, enabled=excluded.enabled, overrides_json=excluded.overrides_json, updated_at=excluded.updated_at`).run(
      input.featureKey.trim(), input.connectionId, input.modelDefinitionId, input.operation, input.enabled === false ? 0 : 1,
      JSON.stringify(input.overrides ?? {}), now
    )
    return { featureKey: input.featureKey.trim(), modelDefinitionId: input.modelDefinitionId, target: { connectionId: input.connectionId, modelId: model.model_id, operation: input.operation }, enabled: input.enabled !== false, overrides: input.overrides ?? {}, updatedAt: now }
  }

  async getConnection(id: string): Promise<Connection | null> {
    const row = this.db.prepare('SELECT * FROM model_connections WHERE id = ?').get(id) as ConnectionRow | undefined
    if (!row) return null
    return this.connectionFromRow(row)
  }

  private connectionFromRow(row: ConnectionRow): Connection {
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      baseUrl: row.base_url,
      // The actual key is intentionally resolved only by readSecret.
      auth: { type: 'none' },
      headers: json(row.headers_json, {}),
      enabled: Boolean(row.enabled),
      metadata: json(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  async getModel(id: string): Promise<ModelDefinition | null> {
    const row = this.db.prepare('SELECT * FROM model_definitions WHERE id = ?').get(id) as ModelRow | undefined
    if (!row) return null
    return this.modelFromRow(row)
  }

  private modelFromRow(row: ModelRow): ModelDefinition {
    const validationRows = this.db.prepare('SELECT operation, status, checked_at, verified_at, message FROM model_validations WHERE model_definition_id = ? AND connection_id = ?').all(row.id, row.connection_id) as Array<{ operation: ModelOperation; status: 'unverified' | 'validating' | 'verified' | 'failed' | 'unsupported'; checked_at: string | null; verified_at: string | null; message: string | null }>
    const validation: ModelDefinition['validation'] = {}
    for (const item of validationRows) {
      validation[item.operation] = {
        status: item.status,
        ...(item.checked_at ? { checkedAt: item.checked_at } : {}),
        ...(item.verified_at ? { verifiedAt: item.verified_at } : {}),
        ...(item.message ? { message: item.message } : {})
      }
    }
    return {
      id: row.id,
      connectionId: row.connection_id,
      modelId: row.model_id,
      name: row.name,
      capabilities: json<Capability[]>(row.capabilities_json, []),
      validation,
      metadata: json(row.metadata_json, {}),
      enabled: Boolean(row.enabled)
    }
  }

  async getBinding(featureKey: string): Promise<FeatureBinding | null> {
    const row = this.db.prepare('SELECT * FROM model_feature_bindings WHERE feature_key = ?').get(featureKey) as
      | { feature_key: string; connection_id: string; model_definition_id: string; operation: ModelOperation; enabled: number; overrides_json: string; updated_at: string }
      | undefined
    if (!row) return null
    const model = await this.getModel(row.model_definition_id)
    if (!model) return null
    return {
      featureKey: row.feature_key,
      modelDefinitionId: row.model_definition_id,
      target: { connectionId: row.connection_id, modelId: model.modelId, operation: row.operation },
      enabled: Boolean(row.enabled), overrides: json(row.overrides_json, {}), updatedAt: row.updated_at
    }
  }

  async readSecret(connectionId: string): Promise<string | null> {
    const row = this.db.prepare('SELECT secret_ref FROM model_connections WHERE id = ?').get(connectionId) as { secret_ref: string | null } | undefined
    return row?.secret_ref ? decryptSecret(row.secret_ref) || null : null
  }

  async getValidation(connectionId: string, modelDefinitionId: string, operation: ModelOperation): Promise<ValidationRecord | null> {
    const row = this.db.prepare('SELECT * FROM model_validations WHERE connection_id = ? AND model_definition_id = ? AND operation = ?').get(connectionId, modelDefinitionId, operation) as
      | { status: ValidationRecord['status']; message: string | null; action: string | null; checked_at: string; verified_at: string | null }
      | undefined
    return row ? { connectionId, modelDefinitionId, operation, status: row.status, message: row.message ?? undefined, action: row.action ?? undefined, checkedAt: row.checked_at, verifiedAt: row.verified_at ?? undefined } : null
  }

  async saveValidation(record: ValidationRecord): Promise<void> {
    this.db.prepare(`INSERT INTO model_validations (connection_id, model_definition_id, operation, status, message, action, checked_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, model_definition_id, operation) DO UPDATE SET
        status = excluded.status, message = excluded.message, action = excluded.action,
        checked_at = excluded.checked_at, verified_at = excluded.verified_at`).run(
      record.connectionId, record.modelDefinitionId, record.operation, record.status,
      record.message ?? null, record.action ?? null, record.checkedAt, record.verifiedAt ?? null
    )
  }

  async loadTask(id: string): Promise<MediaTask | null> { return this.tasks.get(id) ?? null }
  async saveTask(task: MediaTask): Promise<void> { this.tasks.set(task.id, task) }
  async loadAsset(id: string): Promise<AssetRef | null> { return this.assets.get(id) ?? null }
  async saveAsset(asset: AssetRef): Promise<void> { this.assets.set(asset.id, asset) }
  async loadVoice(id: string): Promise<VoiceResource | null> { return this.voices.get(id) ?? null }
  async saveVoice(voice: VoiceResource): Promise<void> { this.voices.set(voice.id, voice) }
}

/** Connection target ids are product-owned model-definition ids; operation stays explicit. */
export function modelTargetOf(connectionId: string, modelId: string, operation: ModelOperation): ModelTarget {
  return { connectionId, modelId, operation }
}
