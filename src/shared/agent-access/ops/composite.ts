import { z } from 'zod'
import { compositeManifestSchema } from '../../composite/manifest'

const capabilityId = z.string().min(1).max(80)
const semver = z.string().regex(/^\d+\.0(\.0)?$/)
const manifest = compositeManifestSchema

const summary = z
  .object({
    id: capabilityId,
    name: z.string().max(120),
    description: z.string().max(600),
    tags: z.array(z.string().max(40)).max(20),
    latestVersion: semver.nullable(),
    archived: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .strict()

const validationIssue = z
  .object({
    code: z.string().max(60),
    path: z.string().max(200),
    message: z.string().max(500)
  })
  .strict()

export const COMPOSITE_OPERATIONS = {
  'composite.search': {
    effect: 'read',
    description: '按名称/ID/标签搜索已发布的组合能力；返回摘要与固定版本，不含内部图',
    input: z
      .object({
        query: z.string().max(200).optional(),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional()
      })
      .strict()
  },
  'composite.get': {
    effect: 'read',
    description: '读取指定组合固定版本的 manifest（公开输入输出、依赖、执行策略）；不传版本取最新',
    input: z.object({ capabilityId, version: semver.optional() }).strict()
  },
  'composite.draft.get': {
    effect: 'read',
    description: '读取组合草稿（含 revision）；不存在时返回 null',
    input: z.object({ capabilityId }).strict()
  },
  'composite.draft.save': {
    effect: 'write',
    description: '创建/更新组合草稿；expectedRevision 用于乐观并发，冲突返回草稿修订错误',
    input: z.object({ manifest, expectedRevision: z.number().int().nonnegative().optional() }).strict()
  },
  'composite.validate': {
    effect: 'read',
    description: '按 GUI 同一规则校验组合 manifest：端口、映射、类型、基数、必填来源、DAG、依赖与预算',
    input: z.object({ manifest }).strict()
  },
  'composite.publish': {
    effect: 'write',
    description: '发布不可变组合版本；同版本同摘要幂等，同版本异摘要拒绝覆盖',
    input: z.object({ manifest }).strict()
  },
  'composite.version.list': {
    effect: 'read',
    description: '列出某个组合能力的全部已发布版本（名称/摘要/发布时间），供切换与历史查看',
    input: z.object({ capabilityId: z.string().min(1).max(120) }).strict()
  },
  'composite.run.get': {
    effect: 'read',
    description: '读取一次组合运行的状态与内部步骤（固定版本、产物归属、失败原因）',
    input: z.object({ runId: z.string().min(1).max(120) }).strict()
  },
  'composite.run.list': {
    effect: 'read',
    description: '列出项目最近的组合运行（状态/能力/版本/时间）',
    input: z.object({ projectId: z.string().min(1).max(120), limit: z.number().int().min(1).max(100).optional() }).strict()
  },
  'composite.archive': {
    effect: 'write',
    description: '归档/恢复组合能力；归档后默认搜索不可见，已引用版本仍可读取',
    input: z.object({ capabilityId, archived: z.boolean().optional() }).strict()
  }
} as const

export const COMPOSITE_OUTPUTS = {
  'composite.search': z
    .object({
      total: z.number().int().nonnegative(),
      items: z.array(summary).max(200)
    })
    .strict(),
  'composite.get': z
    .object({
      capabilityId,
      version: semver,
      manifest,
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      publishedAt: z.number()
    })
    .strict(),
  'composite.draft.get': z
    .object({ capabilityId, manifest, revision: z.number().int().nonnegative(), updatedAt: z.number() })
    .strict()
    .nullable(),
  'composite.draft.save': z
    .object({ capabilityId, revision: z.number().int().positive(), updatedAt: z.number() })
    .strict(),
  'composite.validate': z
    .object({ ok: z.boolean(), issues: z.array(validationIssue).max(200) })
    .strict(),
  'composite.publish': z
    .object({
      capabilityId,
      version: semver,
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      created: z.boolean()
    })
    .strict(),
  'composite.version.list': z.array(z.unknown()),
  'composite.run.get': z.object({ run: z.unknown(), steps: z.array(z.unknown()) }).strict().nullable(),
  'composite.run.list': z.array(z.unknown()),
  'composite.archive': z.object({ capabilityId, archived: z.boolean() }).strict()
} as const

export const COMPOSITE_OPERATION_IDS = Object.keys(COMPOSITE_OPERATIONS) as Array<
  keyof typeof COMPOSITE_OPERATIONS
>
