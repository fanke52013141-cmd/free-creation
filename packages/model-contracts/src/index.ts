import { z } from 'zod'

/**
 * Stable, host-independent contracts for the model module.
 *
 * Values here deliberately use IDs, URLs and JSON instead of Electron, React,
 * filesystem paths or application database types. Hosts provide storage,
 * credential encryption, transport and asset resolution around these contracts.
 */

export const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>

export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[]

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)])
)

const IdSchema = z.string().trim().min(1)
const TimestampSchema = z.string().trim().min(1)
const HttpUrlSchema = z.string().url()

export const ModelOperationSchema = z.enum([
  'text.generate',
  'text.embed',
  'image.generate',
  'image.edit',
  'video.generate',
  'speech.synthesize',
  'speech.transcribe',
  'voice.clone',
  'voice.design'
])
export type ModelOperation = z.infer<typeof ModelOperationSchema>

export const MediaKindSchema = z.enum(['image', 'video', 'audio', 'document', 'binary'])
export type MediaKind = z.infer<typeof MediaKindSchema>

export const AssetRefSchema = z.object({
  id: IdSchema,
  kind: MediaKindSchema,
  uri: z.string().trim().min(1),
  mimeType: z.string().trim().min(1).optional(),
  filename: z.string().trim().min(1).optional(),
  bytes: z.number().int().nonnegative().optional(),
  checksum: z.string().trim().min(1).optional(),
  metadata: z.record(z.string(), JsonValueSchema).default({})
})
export type AssetRef = z.infer<typeof AssetRefSchema>

/** Authentication is transport-neutral. Never serialize these values into project exports. */
export const ConnectionAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('api-key'), apiKey: z.string().min(1) }),
  z.object({ type: z.literal('bearer-token'), token: z.string().min(1) }),
  z.object({ type: z.literal('basic'), username: z.string().min(1), password: z.string().min(1) }),
  z.object({
    type: z.literal('custom-headers'),
    headers: z.record(z.string().min(1), z.string())
  })
])
export type ConnectionAuth = z.infer<typeof ConnectionAuthSchema>

export const ConnectionProtocolSchema = z.enum([
  'openai',
  'openai-compatible',
  'anthropic',
  'google',
  'minimax',
  'volcengine',
  'openrouter',
  'toapis',
  'custom'
])
export type ConnectionProtocol = z.infer<typeof ConnectionProtocolSchema>

export const ConnectionSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1),
  protocol: ConnectionProtocolSchema,
  baseUrl: HttpUrlSchema,
  auth: ConnectionAuthSchema,
  headers: z.record(z.string().min(1), z.string()).default({}),
  enabled: z.boolean().default(true),
  metadata: z.record(z.string(), JsonValueSchema).default({}),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional()
})
export type Connection = z.infer<typeof ConnectionSchema>

export const ModelTargetSchema = z.object({
  connectionId: IdSchema,
  modelId: z.string().trim().min(1),
  operation: ModelOperationSchema
})
export type ModelTarget = z.infer<typeof ModelTargetSchema>

export const CapabilitySchema = z.object({
  operation: ModelOperationSchema,
  asynchronous: z.boolean().default(false),
  streaming: z.boolean().default(false),
  acceptedAssetKinds: z.array(MediaKindSchema).default([]),
  producedAssetKinds: z.array(MediaKindSchema).default([]),
  controls: z.record(z.string(), JsonValueSchema).default({})
})
export type Capability = z.infer<typeof CapabilitySchema>

/** State of a probe against one concrete connection + model + operation target. */
export const ValidationStatusSchema = z.enum([
  'unverified',
  'validating',
  'verified',
  'failed',
  'unsupported'
])
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>

export const ModelValidationSnapshotSchema = z.object({
  status: ValidationStatusSchema,
  checkedAt: TimestampSchema.optional(),
  verifiedAt: TimestampSchema.optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  message: z.string().trim().min(1).optional(),
  requestId: z.string().trim().min(1).optional()
})
export type ModelValidationSnapshot = z.infer<typeof ModelValidationSnapshotSchema>

export const ModelValidationRequestSchema = z.object({
  target: ModelTargetSchema,
  /** A provider adapter may use this to choose a low-cost documented probe. */
  mode: z.enum(['connection', 'model', 'operation']).default('operation'),
  requestId: z.string().trim().min(1).optional()
})
export type ModelValidationRequest = z.infer<typeof ModelValidationRequestSchema>

export const ModelValidationResultSchema = z.object({
  target: ModelTargetSchema,
  snapshot: ModelValidationSnapshotSchema,
  capabilities: z.array(CapabilitySchema).default([])
})
export type ModelValidationResult = z.infer<typeof ModelValidationResultSchema>

/** A selectable configured model. Every enabled operation must be verified before execution. */
export const ModelDefinitionSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1),
  connectionId: IdSchema,
  modelId: z.string().trim().min(1),
  capabilities: z.array(CapabilitySchema).min(1),
  validation: z.partialRecord(ModelOperationSchema, ModelValidationSnapshotSchema).default({}),
  enabled: z.boolean().default(true),
  metadata: z.record(z.string(), JsonValueSchema).default({})
})
export type ModelDefinition = z.infer<typeof ModelDefinitionSchema>

/** Maps a product feature to one verified model operation without coupling it to a UI or node system. */
export const FeatureBindingSchema = z.object({
  featureKey: z.string().trim().min(1),
  /** Stable local model record; upstream modelId alone is not enough to identify a configured target. */
  modelDefinitionId: IdSchema,
  target: ModelTargetSchema,
  enabled: z.boolean().default(true),
  overrides: z.record(z.string(), JsonValueSchema).default({}),
  updatedAt: TimestampSchema.optional()
})
export type FeatureBinding = z.infer<typeof FeatureBindingSchema>

export const ModelErrorCodeSchema = z.enum([
  'invalid-request',
  'invalid-configuration',
  'not-verified',
  'unsupported-operation',
  'authentication-failed',
  'permission-denied',
  'rate-limited',
  'quota-exceeded',
  'upstream-unavailable',
  'upstream-rejected',
  'task-not-found',
  'task-failed',
  'task-cancelled',
  'timeout',
  'asset-unavailable',
  'internal'
])
export type ModelErrorCode = z.infer<typeof ModelErrorCodeSchema>

export const ModelErrorSchema = z.object({
  code: ModelErrorCodeSchema,
  message: z.string().trim().min(1),
  retryable: z.boolean().default(false),
  providerCode: z.string().trim().min(1).optional(),
  requestId: z.string().trim().min(1).optional(),
  details: z.record(z.string(), JsonValueSchema).default({})
})
export type ModelError = z.infer<typeof ModelErrorSchema>

export const TaskStatusSchema = z.enum([
  'queued',
  'submitted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired'
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const MediaTaskSchema = z.object({
  id: IdSchema,
  target: ModelTargetSchema,
  status: TaskStatusSchema,
  upstreamTaskId: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  input: z.record(z.string(), JsonValueSchema).default({}),
  outputAssets: z.array(AssetRefSchema).default([]),
  error: ModelErrorSchema.optional(),
  progress: z.number().min(0).max(1).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
  expiresAt: TimestampSchema.optional(),
  metadata: z.record(z.string(), JsonValueSchema).default({})
})
export type MediaTask = z.infer<typeof MediaTaskSchema>

export const VoiceResourceSourceSchema = z.enum(['preset', 'clone', 'design'])
export type VoiceResourceSource = z.infer<typeof VoiceResourceSourceSchema>

export const VoiceResourceSchema = z.object({
  id: IdSchema,
  connectionId: IdSchema,
  upstreamVoiceId: z.string().trim().min(1),
  source: VoiceResourceSourceSchema,
  name: z.string().trim().min(1).optional(),
  previewAsset: AssetRefSchema.optional(),
  createdAt: TimestampSchema.optional(),
  metadata: z.record(z.string(), JsonValueSchema).default({})
})
export type VoiceResource = z.infer<typeof VoiceResourceSchema>

const TaskEventBaseSchema = z.object({
  taskId: IdSchema,
  occurredAt: TimestampSchema,
  requestId: z.string().trim().min(1).optional()
})

export const TaskEventSchema = z.discriminatedUnion('type', [
  TaskEventBaseSchema.extend({
    type: z.literal('status'),
    status: TaskStatusSchema,
    previousStatus: TaskStatusSchema.optional()
  }),
  TaskEventBaseSchema.extend({ type: z.literal('progress'), progress: z.number().min(0).max(1) }),
  TaskEventBaseSchema.extend({ type: z.literal('output'), assets: z.array(AssetRefSchema).min(1) }),
  TaskEventBaseSchema.extend({ type: z.literal('error'), error: ModelErrorSchema }),
  TaskEventBaseSchema.extend({ type: z.literal('heartbeat') })
])
export type TaskEvent = z.infer<typeof TaskEventSchema>

export const TaskLifecycleTransitionSchema = z.object({
  from: TaskStatusSchema,
  to: TaskStatusSchema
})
export type TaskLifecycleTransition = z.infer<typeof TaskLifecycleTransitionSchema>

/**
 * Central lifecycle truth used by hosts to prevent invalid local state changes.
 * Provider adapters may skip intermediate states, but terminal tasks never leave a terminal state.
 */
export const TaskLifecycleTransitions: readonly TaskLifecycleTransition[] = [
  { from: 'queued', to: 'submitted' },
  { from: 'queued', to: 'cancelled' },
  { from: 'submitted', to: 'running' },
  { from: 'submitted', to: 'succeeded' },
  { from: 'submitted', to: 'failed' },
  { from: 'submitted', to: 'cancelled' },
  { from: 'running', to: 'succeeded' },
  { from: 'running', to: 'failed' },
  { from: 'running', to: 'cancelled' },
  { from: 'running', to: 'expired' }
]

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TaskLifecycleTransitions.some((transition) => transition.from === from && transition.to === to)
}

/** True only when the exact model operation has a successful, current validation result. */
export function isModelOperationVerified(
  model: Pick<ModelDefinition, 'capabilities' | 'validation'>,
  operation: ModelOperation
): boolean {
  return (
    model.capabilities.some((capability) => capability.operation === operation) &&
    model.validation[operation]?.status === 'verified'
  )
}
