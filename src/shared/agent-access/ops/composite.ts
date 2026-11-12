import { z } from 'zod'
import { compositeManifestSchema } from '../../composite/manifest'

const capabilityId = z.string().min(1).max(80)
const semver = z.string().regex(/^\d+\.0(\.0)?$/)
const manifest = compositeManifestSchema

/** headless 执行的公开输入值（与 WorkflowInput 值同口径；媒体按 mediaId 全局解析）。 */
const executeInputValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(100000) }).strict(),
  z.object({ kind: z.literal('markdown'), text: z.string().min(1).max(100000) }).strict(),
  z.object({ kind: z.literal('json'), data: z.unknown() }).strict(),
  z.object({ kind: z.literal('media'), mediaId: z.string().min(1).max(180) }).strict()
])
const executeInputs = z
  .array(z.object({ portId: z.string().min(1).max(100), value: executeInputValue }).strict())
  .max(64)

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
    description:
      '创建/更新组合草稿；允许未接完的图并返回问题；expectedRevision 用于乐观并发，冲突返回 DRAFT_REVISION_CONFLICT 且保留草稿',
    input: z
      .object({ manifest, expectedRevision: z.number().int().nonnegative().optional() })
      .strict()
  },
  'composite.validate': {
    effect: 'read',
    description:
      '按 GUI 同一规则校验组合 manifest：端口、映射、类型、基数、必填来源、DAG、依赖与预算',
    input: z.object({ manifest }).strict()
  },
  'composite.publish': {
    effect: 'write',
    description:
      '发布不可变组合版本：同版本同摘要幂等；同版本异摘要返回 VERSION_IMMUTABLE；新版本必须递增，可带 expectedRevision 校验草稿未被他人改动',
    input: z
      .object({
        manifest,
        expectedRevision: z.number().int().nonnegative().optional()
      })
      .strict()
  },
  'composite.upgrade.preview': {
    effect: 'read',
    description:
      '按项目内已绑定实例的实际连线预检升级：比较端口 ID/类型/Schema/必填/基数，返回阻断项及受影响节点与边',
    input: z
      .object({
        projectId: z.string().min(1).max(120),
        nodeId: z.string().min(1).max(180),
        nextManifest: manifest
      })
      .strict()
  },
  'composite.upgrade.apply': {
    effect: 'write',
    description:
      '把画布上的节点流实例升级到指定已发布版本：先运行同一升级预检，阻断则拒绝且原实例不变；通过后以固定版本引用原子更新实例并保留兼容连线',
    input: z
      .object({
        projectId: z.string().min(1).max(120),
        nodeId: z.string().min(1).max(180),
        nextManifest: manifest,
        expectedGraphVersion: z.number().int().nonnegative()
      })
      .strict()
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
    input: z
      .object({
        projectId: z.string().min(1).max(120),
        limit: z.number().int().min(1).max(100).optional()
      })
      .strict()
  },
  'composite.execute': {
    effect: 'execute',
    description:
      'headless 执行已发布节点流：不依赖项目/画布，按公开输入端口喂值，异步运行返回 runId；终态与输出经 composite.run.get 读取。媒体输入按 mediaId 全局解析',
    input: z
      .object({
        capabilityId,
        version: semver.optional(),
        inputs: executeInputs.optional()
      })
      .strict()
  },
  'composite.execute.wait': {
    effect: 'read',
    description: '阻塞等待 headless 运行到达终态：返回状态/公开输出/失败原因；超时返回当前状态',
    input: z
      .object({
        runId: z.string().min(1).max(120),
        timeoutMs: z.number().int().min(100).max(300000).optional()
      })
      .strict()
  },
  'composite.archive': {
    effect: 'write',
    description: '归档/恢复组合能力；归档后默认搜索不可见，已引用版本仍可读取',
    input: z.object({ capabilityId, archived: z.boolean().optional() }).strict()
  },
  'composite.references': {
    effect: 'read',
    description:
      '删除前引用检查：列出各项目画布上绑定该能力的实例（含固定版本）与其他节点流发布版本的嵌套依赖；归档不阻断引用',
    input: z.object({ capabilityId }).strict()
  },
  'composite.delete': {
    effect: 'write',
    description:
      '物理删除节点流（发布版本+草稿+能力行）。先做同一引用检查，存在画布实例或嵌套引用时返回 CAPABILITY_IN_USE 且不改动数据',
    input: z.object({ capabilityId }).strict()
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
    .object({
      capabilityId,
      manifest,
      revision: z.number().int().nonnegative(),
      updatedAt: z.number()
    })
    .strict()
    .nullable(),
  'composite.draft.save': z
    .object({ capabilityId, revision: z.number().int().positive(), updatedAt: z.number() })
    .strict(),
  'composite.validate': z
    .object({ ok: z.boolean(), issues: z.array(validationIssue).max(200) })
    .strict(),
  'composite.upgrade.preview': z
    .object({
      previousVersion: semver,
      nextVersion: semver,
      ok: z.boolean(),
      runtimeVersion: z.number().int().positive().optional(),
      issues: z.array(validationIssue).max(200).optional(),
      impact: z
        .object({
          fromVersion: z.string().max(40),
          toVersion: z.string().max(40),
          addedInputs: z.array(z.string().max(100)).max(64),
          removedInputs: z.array(z.string().max(100)).max(64),
          addedOutputs: z.array(z.string().max(100)).max(64),
          removedOutputs: z.array(z.string().max(100)).max(64),
          typeChanged: z
            .array(
              z
                .object({
                  portId: z.string().max(100),
                  from: z.string().max(40),
                  to: z.string().max(40)
                })
                .strict()
            )
            .max(64),
          requiredChanged: z
            .array(
              z.object({ portId: z.string().max(100), from: z.boolean(), to: z.boolean() }).strict()
            )
            .max(64),
          schemaChanged: z
            .array(
              z
                .object({
                  portId: z.string().max(100),
                  from: z.string().max(120).nullable(),
                  to: z.string().max(120).nullable()
                })
                .strict()
            )
            .max(64),
          cardinalityChanged: z
            .array(
              z
                .object({
                  portId: z.string().max(100),
                  from: z.enum(['one', 'many']),
                  to: z.enum(['one', 'many'])
                })
                .strict()
            )
            .max(64),
          addedRequiredInputs: z.array(z.string().max(100)).max(64),
          breaking: z
            .array(
              z
                .object({
                  portId: z.string().max(100),
                  reason: z.string().max(300),
                  nodeId: z.string().max(180).optional(),
                  edgeId: z.string().max(180).optional()
                })
                .strict()
            )
            .max(64)
        })
        .strict()
        .nullable()
    })
    .strict(),
  'composite.publish': z
    .object({
      capabilityId,
      version: semver,
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      created: z.boolean()
    })
    .strict(),
  'composite.upgrade.apply': z
    .object({
      projectId: z.string().min(1).max(120),
      nodeId: z.string().min(1).max(180),
      previousVersion: semver,
      version: semver,
      graphVersion: z.number().int().nonnegative()
    })
    .strict(),
  'composite.version.list': z.array(z.unknown()),
  'composite.run.get': z
    .object({ run: z.unknown(), steps: z.array(z.unknown()) })
    .strict()
    .nullable(),
  'composite.run.list': z.array(z.unknown()),
  'composite.execute': z
    .object({
      runId: z.string().min(1).max(120),
      capabilityId,
      version: semver,
      status: z.literal('running')
    })
    .strict(),
  'composite.execute.wait': z
    .object({
      runId: z.string().min(1).max(120),
      status: z.enum(['running', 'completed', 'failed', 'cancelled']),
      outputs: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().optional(),
      failure: z
        .object({
          code: z.string(),
          phase: z.string(),
          nodeId: z.string().optional(),
          portId: z.string().optional()
        })
        .strict()
        .optional()
    })
    .strict(),
  'composite.archive': z.object({ capabilityId, archived: z.boolean() }).strict(),
  'composite.references': z
    .object({
      capabilityId,
      projectInstances: z
        .array(
          z
            .object({
              projectId: z.string().max(120),
              projectName: z.string().max(200),
              nodeId: z.string().max(180),
              version: z.string().max(40)
            })
            .strict()
        )
        .max(2000),
      nestedVersions: z
        .array(
          z
            .object({
              capabilityId,
              version: semver,
              refVersion: z.string().max(40)
            })
            .strict()
        )
        .max(2000)
    })
    .strict(),
  'composite.delete': z.object({ capabilityId, deleted: z.boolean() }).strict()
} as const

export const COMPOSITE_OPERATION_IDS = Object.keys(COMPOSITE_OPERATIONS) as Array<
  keyof typeof COMPOSITE_OPERATIONS
>
