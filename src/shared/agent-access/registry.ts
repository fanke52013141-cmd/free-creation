import { z } from 'zod'
import { ACTIVE_NODE_TYPE_IDS } from '../types'

export const ACCESS_API_VERSION = 1
export const ACCESS_MAX_BYTES = 1024 * 1024
export const ACCESS_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const empty = z.object({}).strict()
const project = z.object({ projectId: identifier }).strict()
const revision = project.extend({ expectedGraphVersion: z.number().int().nonnegative() }).strict()

export const ACCESS_OPERATIONS = {
  'app.status': { effect: 'read', description: '读取本地应用版本与实例身份', input: empty },
  'capability.list': {
    effect: 'read',
    description: '读取当前已开放操作及其输入契约',
    input: empty
  },
  'node.type.list': {
    effect: 'read',
    description: '读取节点接入状态；本包不开放节点操作',
    input: empty
  },
  'project.list': {
    effect: 'read',
    description: '分页读取项目摘要',
    input: z
      .object({
        offset: z.number().int().min(0).max(100000).default(0),
        limit: z.number().int().min(1).max(100).default(50)
      })
      .strict()
  },
  'project.get': {
    effect: 'read',
    description: '读取已保存项目摘要与内容数量，不返回原始快照',
    input: project
  },
  'project.create': {
    effect: 'write',
    description: '幂等新建空项目',
    input: z.object({ name: z.string().trim().min(1).max(200) }).strict()
  },
  'project.open': {
    effect: 'write',
    description: '保存当前画布后在桌面打开项目；等待画布就绪',
    input: project
  },
  'project.update': {
    effect: 'write',
    description: '按版本修改项目名称；活动画布先保存并同步版本',
    input: revision.extend({ name: z.string().trim().min(1).max(200) }).strict()
  },
  'project.rename': {
    effect: 'write',
    description: '按已保存版本修改项目名称；活动画布经保存握手同步',
    input: revision.extend({ name: z.string().trim().min(1).max(200) }).strict()
  },
  'project.save': {
    effect: 'write',
    description: '保存当前权威内容；活动画布等待最新编辑落盘，不接收客户端快照',
    input: revision
  },
  'project.clone': {
    effect: 'write',
    description: '固定源版本复制项目（媒体ID/引用重映射）；活动源画布先保存，克隆不继承运行任务',
    input: revision.extend({ name: z.string().trim().min(1).max(120) }).strict()
  },
  'project.delete.precheck': {
    effect: 'read',
    description: '读取删除影响摘要与占用阻塞项，无阻塞时签发短期确认令牌',
    input: project
  },
  'project.delete': {
    effect: 'delete',
    description: '凭预检令牌硬删除项目；拒绝活动画布、运行/未知占用，令牌过期或事实漂移需重新预检',
    input: z
      .object({
        projectId: identifier,
        impactToken: z.string().min(1).max(1024).optional()
      })
      .strict()
  },
  'project.export': {
    effect: 'export',
    description: '活动画布先保存最新编辑，再导出完整项目到受控目录，不覆盖文件',
    input: revision
      .extend({ fileName: z.string().regex(/^[a-zA-Z0-9_-]{1,100}\.canvasbundle$/) })
      .strict()
  }
} as const
export type AccessOperationId = keyof typeof ACCESS_OPERATIONS

export const AccessRequestSchema = z
  .object({
    apiVersion: z.literal(ACCESS_API_VERSION),
    operationVersion: z.literal(1),
    operationId: z.string().min(1).max(80),
    requestId: identifier,
    expectedDataStoreId: z.string().uuid(),
    idempotencyKey: z
      .string()
      .regex(/^\d{13}:[a-f0-9-]{36}$/)
      .optional(),
    input: z.unknown()
  })
  .strict()
export type AccessRequest = z.infer<typeof AccessRequestSchema>
export interface AccessResponse {
  apiVersion: 1
  requestId: string
  operationId: string
  traceId: string
  status: 'completed' | 'failed' | 'unknown'
  idempotencyKey?: string
  data?: unknown
  error?: { code: string; phase: string; retryable: boolean }
}

export const AccessResponseSchema = z
  .object({
    apiVersion: z.literal(1),
    requestId: z.string(),
    operationId: z.string(),
    traceId: z.string(),
    status: z.enum(['completed', 'failed', 'unknown']),
    idempotencyKey: z.string().optional(),
    data: z.json().optional(),
    error: z
      .object({ code: z.string(), phase: z.string(), retryable: z.boolean() })
      .strict()
      .optional()
  })
  .strict()

const metadata = z
  .object({
    id: identifier,
    name: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    graphVersion: z.number().int().nonnegative(),
    coverMediaId: z.string().optional()
  })
  .strict()
const savedMetadata = z.object({ meta: metadata, saved: z.literal(true) }).strict()
export const ACCESS_OUTPUTS = {
  'app.status': z
    .object({
      instanceId: z.string().uuid(),
      dataStoreId: z.string().uuid(),
      appVersion: z.string(),
      apiVersion: z.literal(1),
      nextIdempotencyKey: z.string()
    })
    .strict(),
  'capability.list': z
    .object({ operations: z.array(z.json()), limitations: z.array(z.string()) })
    .strict(),
  'node.type.list': z
    .object({
      nodes: z.array(
        z
          .object({
            typeId: z.enum(ACTIVE_NODE_TYPE_IDS),
            actions: z.literal('planned'),
            reason: z.literal('NODE_ACCESS_NOT_IMPLEMENTED')
          })
          .strict()
      )
    })
    .strict(),
  'project.list': z
    .object({ projects: z.array(metadata), total: z.number().int().nonnegative() })
    .strict(),
  'project.get': z
    .object({
      meta: metadata,
      nodeCount: z.number().int().nonnegative(),
      edgeCount: z.number().int().nonnegative(),
      groupCount: z.number().int().nonnegative(),
      saved: z.literal(true)
    })
    .strict(),
  'project.create': savedMetadata,
  'project.open': z.object({ meta: metadata, opened: z.literal(true) }).strict(),
  'project.update': savedMetadata,
  'project.rename': savedMetadata,
  'project.save': z
    .object({ graphVersion: z.number().int().nonnegative(), saved: z.literal(true) })
    .strict(),
  'project.clone': savedMetadata,
  'project.delete.precheck': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      impact: z
        .object({
          nodeCount: z.number().int().nonnegative(),
          edgeCount: z.number().int().nonnegative(),
          groupCount: z.number().int().nonnegative(),
          mediaCount: z.number().int().nonnegative(),
          mediaBytes: z.number().int().nonnegative(),
          libraryUsageCount: z.number().int().nonnegative()
        })
        .strict(),
      blockers: z.array(z.enum(['ACTIVE_PROJECT', 'RECOVERY_COPY', 'TASK_OCCUPANCY'])),
      impactToken: z.string().min(1).max(1024).optional(),
      expiresAt: z.number().int().positive().optional()
    })
    .strict(),
  'project.delete': z
    .object({
      deleted: z.literal(true),
      projectId: identifier,
      graphVersion: z.number().int().nonnegative()
    })
    .strict(),
  'project.export': z
    .object({
      path: z.string(),
      sourceGraphVersion: z.number().int().nonnegative(),
      byteSize: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      missingMediaCount: z.literal(0)
    })
    .strict()
} satisfies Record<AccessOperationId, z.ZodType>

export function operationResponseSchema(id: AccessOperationId): z.ZodObject {
  return AccessResponseSchema.extend({
    operationId: z.literal(id),
    data: ACCESS_OUTPUTS[id].optional()
  }).strict()
}

export function toolInputSchema(operationId: AccessOperationId): z.ZodObject {
  const spec = ACCESS_OPERATIONS[operationId]
  return z
    .object({
      input: spec.input,
      requestId: identifier.optional(),
      idempotencyKey:
        spec.effect === 'read' ? z.string().optional() : z.string().regex(/^\d{13}:[a-f0-9-]{36}$/)
    })
    .strict()
}

// Explicit declarations: adding an Active type without deciding its access boundary fails the gate.
export const NODE_ACCESS_DECLARATIONS = [
  'text',
  'image',
  'image-crop',
  'image-split',
  'image-gen',
  'image-edit',
  'website',
  'video',
  'video-asset',
  'video-frame',
  'video-clip',
  'video-depth',
  'video-clay',
  'audio',
  'sound-adjust',
  'file',
  'speech',
  'tts',
  'voice-design',
  'chat',
  'processor',
  'code',
  'json',
  'structured',
  'storyboard',
  'ai-process',
  'iterate',
  'director',
  'agent',
  'state-machine',
  'ai-review'
] as const

export function nodeAccessDirectory(): Array<{
  typeId: string
  actions: 'planned'
  reason: string
}> {
  return NODE_ACCESS_DECLARATIONS.map((typeId) => ({
    typeId,
    actions: 'planned',
    reason: 'NODE_ACCESS_NOT_IMPLEMENTED'
  }))
}
export function operationDirectory(): unknown[] {
  return Object.entries(ACCESS_OPERATIONS).map(([operationId, spec]) => ({
    operationId,
    operationVersion: 1,
    effect: spec.effect,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.input),
    outputSchema: z.toJSONSchema(operationResponseSchema(operationId as AccessOperationId)),
    transports: ['cli', 'mcp-stdio']
  }))
}
export function validateAccessRegistry(
  activeTypes: readonly string[] = ACTIVE_NODE_TYPE_IDS,
  declarations: readonly string[] = NODE_ACCESS_DECLARATIONS
): string[] {
  const active = new Set<string>(activeTypes)
  const declared = new Set<string>(declarations)
  const errors = [...active].filter((id) => !declared.has(id)).map((id) => `UNDECLARED_NODE:${id}`)
  for (const id of declared) if (!active.has(id)) errors.push(`INACTIVE_NODE:${id}`)
  if (declared.size !== declarations.length) errors.push('DUPLICATE_NODE')
  for (const [id, spec] of Object.entries(ACCESS_OPERATIONS)) {
    if (!spec.input || !spec.description || !['read', 'write', 'export', 'delete'].includes(spec.effect))
      errors.push(`INVALID_OPERATION:${id}`)
    if (id.includes('import')) errors.push(`EXCLUDED_OPERATION:${id}`)
  }
  return errors
}
