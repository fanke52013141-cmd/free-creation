import { z } from 'zod'
import { categorySchema } from '../../library/blueprint'
import { empty, identifier } from './common'

/**
 * 资源库（F7）：各类资源/组件/修订/分类/文件夹/集合/归档/批量/物化。
 *
 * 新增操作的方法：在本文件的 `LIBRARY_OPERATIONS` 里登记
 * { effect, description, input }，并在 `LIBRARY_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 *
 * 本族的分工与边界：
 * - 所有写操作都经 `src/main/store/library*.repo.ts` 的既有服务（createResource /
 *   publishRevision / deleteResource / materializeResource / …），main 只做准入、
 *   外部输入装配与回执投影；没有外部专用执行器，也不直写 SQLite。
 * - 外部输入不携带任何已物化路径：媒体组件用「显式本机导入」filePath（仅创建/修订
 *   时作为导入请求，复用 repo 的 128 MB 与类型校验），目标画布素材用 mediaId。
 * - 资源包导入/导出（library.import / library.export）属包传输族（F7 task-3），
 *   本族不重复登记，避免两份执行器。
 */

const formPreset = z.enum(['image', 'prompt', 'character', 'scene', 'style', 'custom'])
const valueType = z.enum(['text', 'markdown', 'image', 'audio', 'video', 'file', 'json', 'recipe'])
const TEXT_VALUE_TYPES: ReadonlySet<string> = new Set(['text', 'markdown', 'json', 'recipe'])
const LIBRARY_MAX_COMPONENTS = 100
const LIBRARY_MAX_TEXT_CHARS = 2_000_000
const LIBRARY_MAX_METADATA_BYTES = 64_000
const LIBRARY_MAX_BATCH = 50

const roleSchema = z.string().trim().min(1).max(80)
const tagSchema = z.string().trim().min(1).max(48)
const categoryRef = z
  .object({ id: z.string().min(1).max(100), version: z.number().int().positive() })
  .strict()

/**
 * 组件输入：文本类给 text，媒体类给「本机文件路径」（显式导入请求）或复用同资源
 * 既有组件（修订发布时）。两者互斥，避免出现“既有正文又有文件”的歧义记录。
 */
const componentInput = z
  .object({
    role: roleSchema,
    valueType,
    text: z.string().max(LIBRARY_MAX_TEXT_CHARS).optional(),
    filePath: z.string().min(2).max(500).optional(),
    mime: z.string().max(160).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    reuseComponentId: identifier.optional()
  })
  .strict()
  .superRefine((component, ctx) => {
    const textType = TEXT_VALUE_TYPES.has(component.valueType)
    if (textType) {
      if (component.filePath) ctx.addIssue({ code: 'custom', message: '文本类组件不接受 filePath' })
      if (component.text === undefined && !component.reuseComponentId)
        ctx.addIssue({ code: 'custom', message: '文本类组件需要 text 或 reuseComponentId' })
      return
    }
    if (component.text !== undefined)
      ctx.addIssue({ code: 'custom', message: '文件类组件不接受 text' })
    if (!component.filePath && !component.reuseComponentId)
      ctx.addIssue({ code: 'custom', message: '文件类组件需要 filePath 或 reuseComponentId' })
  })

const componentsInput = z.array(componentInput).min(1).max(LIBRARY_MAX_COMPONENTS)

const resourceIdSchema = identifier
const revisionIdSchema = identifier
const folderIdSchema = identifier
const collectionIdSchema = identifier

const listInput = z
  .object({
    query: z.string().max(300).optional(),
    formPreset: formPreset.or(z.literal('all')).optional(),
    categoryId: z.string().min(1).max(100).optional(),
    collectionId: collectionIdSchema.optional(),
    folderId: folderIdSchema.or(z.literal('root')).optional(),
    includeArchived: z.boolean().default(false),
    cursor: z
      .string()
      .regex(/^\d{1,6}$/)
      .optional(),
    limit: z.number().int().min(1).max(100).default(40)
  })
  .strict()

const variablesInput = z.record(
  z.string().max(80),
  z.record(z.string().max(64), z.string().max(20_000))
)

export const LIBRARY_OPERATIONS = {
  'library.resource.list': {
    effect: 'read',
    description: '分页检索资源库摘要（分类/文件夹/集合/类型/归档过滤）；不返回组件正文与媒体路径',
    input: listInput
  },
  'library.resource.get': {
    effect: 'read',
    description:
      '读取单个资源详情：组件摘要（角色/类型/哈希/引用）、全部修订与项目使用记录；正文需显式 includeText',
    input: z
      .object({
        resourceId: resourceIdSchema,
        revisionId: revisionIdSchema.optional(),
        includeText: z.boolean().default(false)
      })
      .strict()
  },
  'library.resource.preview_files': {
    effect: 'read',
    description: '物化前预检所选组件的资源文件是否存在（与 GUI 复用文件预检同一服务），不复制文件',
    input: z
      .object({
        resourceId: resourceIdSchema,
        revisionId: revisionIdSchema,
        componentIds: z.array(identifier).min(1).max(LIBRARY_MAX_COMPONENTS)
      })
      .strict()
  },
  'library.resource.create': {
    effect: 'write',
    description:
      '创建任意类型资源（文本/图片/音频/视频/文件/JSON 组件，可带分类/标签/集合/文件夹）；媒体组件只接受本机已存在文件路径作为导入请求',
    input: z
      .object({
        title: z.string().trim().min(1).max(180),
        formPreset,
        description: z.string().max(20_000).optional(),
        tags: z.array(tagSchema).max(40).optional(),
        category: categoryRef.optional(),
        collectionIds: z.array(collectionIdSchema).max(50).optional(),
        folderId: folderIdSchema.optional(),
        changeNote: z.string().max(1000).optional(),
        components: componentsInput
      })
      .strict()
  },
  'library.resource.publish': {
    effect: 'write',
    description:
      '在指定基础版本上发布新修订（标题/描述/标签/分类/集合同步更新）；components 省略时复用基础版本全部组件',
    input: z
      .object({
        resourceId: resourceIdSchema,
        baseRevisionId: revisionIdSchema,
        sourceRevisionId: revisionIdSchema.optional(),
        title: z.string().trim().min(1).max(180).optional(),
        formPreset: formPreset.optional(),
        description: z.string().max(20_000).optional(),
        tags: z.array(tagSchema).max(40).optional(),
        category: categoryRef.optional(),
        collectionIds: z.array(collectionIdSchema).max(50).optional(),
        changeNote: z.string().max(1000).optional(),
        components: componentsInput.optional()
      })
      .strict()
  },
  'library.resource.delete': {
    effect: 'delete',
    description:
      '彻底删除一个资源（全部修订/组件/标签/集合与文件夹归属/使用记录，随后清理无引用 blob）；与 GUI 删除同一服务',
    input: z.object({ resourceId: resourceIdSchema }).strict()
  },
  'library.resource.delete_many': {
    effect: 'delete',
    description: '批量彻底删除资源，逐项回执（单项不存在返回 NOT_FOUND，不静默跳过，不影响其它项）',
    input: z
      .object({ resourceIds: z.array(resourceIdSchema).min(1).max(LIBRARY_MAX_BATCH) })
      .strict()
  },
  'library.resource.archive': {
    effect: 'write',
    description:
      '归档/取消归档资源（可逆的「隐藏」标记）：归档后默认检索不返回，includeArchived 可查回；不删除内容',
    input: z.object({ resourceId: resourceIdSchema, archived: z.boolean() }).strict()
  },
  'library.resource.set_folder': {
    effect: 'write',
    description: '把资源归入某个资源库文件夹（folderId=null 表示移到资源库根目录）',
    input: z.object({ resourceId: resourceIdSchema, folderId: folderIdSchema.nullable() }).strict()
  },
  'library.resource.set_collections': {
    effect: 'write',
    description: '替换资源的完整收藏集归属（空数组为清空）；收藏集 ID 必须存在',
    input: z
      .object({ resourceId: resourceIdSchema, collectionIds: z.array(collectionIdSchema).max(50) })
      .strict()
  },
  'library.folder.list': {
    effect: 'read',
    description: '读取资源库文件夹目录（含上级与资源数量）',
    input: empty
  },
  'library.folder.create': {
    effect: 'write',
    description: '新建资源库文件夹；同一上级下不允许重名',
    input: z
      .object({ name: z.string().trim().min(1).max(100), parentId: folderIdSchema.optional() })
      .strict()
  },
  'library.folder.rename': {
    effect: 'write',
    description: '重命名资源库文件夹；同一上级下不允许重名',
    input: z.object({ folderId: folderIdSchema, name: z.string().trim().min(1).max(100) }).strict()
  },
  'library.folder.delete': {
    effect: 'delete',
    description: '删除资源库文件夹；子文件夹与资源上移到上级目录，不删除任何资源',
    input: z.object({ folderId: folderIdSchema }).strict()
  },
  'library.collection.list': {
    effect: 'read',
    description: '读取收藏集目录（含资源数量）',
    input: empty
  },
  'library.collection.create': {
    effect: 'write',
    description: '新建收藏集；名称全局唯一',
    input: z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(2000).optional()
      })
      .strict()
  },
  'library.category.list': {
    effect: 'read',
    description: '读取资源分类蓝图目录（含槽位定义，创建资源时用于 metadata.librarySlotId 映射）',
    input: empty
  },
  'library.category.save': {
    effect: 'write',
    description: '按基础版本保存一个新的分类蓝图版本（版本必须为基础版本 +1，防覆盖）',
    input: z.object({ category: categorySchema, baseVersion: z.number().int().min(0) }).strict()
  },
  'library.resource.materialize': {
    effect: 'write',
    description:
      '把指定资源版本的所选组件物化到当前打开画布：复制资源文件为项目受控媒体，再经桌面握手创建节点并正式保存；返回逐组件节点映射',
    input: z
      .object({
        projectId: identifier,
        resourceId: resourceIdSchema,
        revisionId: revisionIdSchema,
        componentIds: z.array(identifier).min(1).max(LIBRARY_MAX_COMPONENTS),
        expectedGraphVersion: z.number().int().nonnegative(),
        x: z.number().finite().min(-100000).max(100000).optional(),
        y: z.number().finite().min(-100000).max(100000).optional(),
        variables: variablesInput.optional()
      })
      .strict()
  },
  'library.materialization.discard': {
    effect: 'write',
    description:
      '补偿性清理一次资源物化复制出的项目媒体（按 usageId 与项目归属核对）；已存在引用或跨项目一律拒绝删除',
    input: z.object({ projectId: identifier, usageId: identifier }).strict()
  }
} as const

const valueTypeOut = valueType
const formPresetOut = formPreset

const componentDto = z
  .object({
    componentId: identifier,
    role: z.string().max(80),
    valueType: valueTypeOut,
    order: z.number().int().nonnegative(),
    hasBlob: z.boolean(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mime: z.string().max(160).optional(),
    fileName: z.string().max(220).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    text: z.string().max(20_000).optional(),
    textLength: z.number().int().nonnegative().optional(),
    references: z
      .object({
        sourceProjectId: identifier.optional(),
        sourceMediaId: z.string().max(40).optional(),
        sourceNodeType: z.string().max(60).optional(),
        librarySlotId: z.string().max(64).optional(),
        hasArtifactRecipe: z.boolean()
      })
      .strict()
  })
  .strict()

const categoryOut = z
  .object({
    id: z.string().max(100),
    version: z.number().int().positive(),
    name: z.string().max(100)
  })
  .strict()

const resourceSummaryDto = z
  .object({
    resourceId: identifier,
    title: z.string().max(200),
    formPreset: formPresetOut,
    description: z.string().max(20_000),
    tags: z.array(z.string().max(48)).max(40),
    collectionIds: z.array(identifier).max(100),
    folderIds: z.array(identifier).max(100),
    category: categoryOut.optional(),
    latestRevisionId: identifier,
    revisionNumber: z.number().int().positive(),
    componentCount: z.number().int().nonnegative(),
    archived: z.boolean(),
    updatedAt: z.number()
  })
  .strict()

const revisionDto = z
  .object({
    revisionId: identifier,
    revisionNumber: z.number().int().positive(),
    title: z.string().max(200),
    changeNote: z.string().max(1000).optional(),
    createdAt: z.number(),
    componentCount: z.number().int().nonnegative()
  })
  .strict()

const usageDto = z
  .object({
    projectId: identifier,
    revisionId: identifier,
    createdAt: z.number(),
    lastUsedAt: z.number(),
    materializedNodeCount: z.number().int().nonnegative()
  })
  .strict()

const resourceDetailDto = resourceSummaryDto
  .extend({
    selectedRevisionId: identifier,
    selectedRevisionNumber: z.number().int().positive(),
    revisions: z.array(revisionDto).max(200),
    components: z.array(componentDto).max(LIBRARY_MAX_COMPONENTS),
    usages: z.array(usageDto).max(50)
  })
  .strict()

const folderDto = z
  .object({
    folderId: identifier,
    name: z.string().max(100),
    parentId: identifier.nullable(),
    resourceCount: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .strict()

const collectionDto = z
  .object({
    collectionId: identifier,
    name: z.string().max(100),
    description: z.string().max(2000),
    resourceCount: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .strict()

const categorySlotDto = z
  .object({
    slotId: z.string().max(64),
    label: z.string().max(80),
    nodeType: z.enum(['text', 'image', 'audio', 'video-asset', 'file', 'json']),
    contractVersion: z.number().int().positive(),
    required: z.boolean(),
    multiple: z.boolean(),
    titleTemplate: z.string().max(180)
  })
  .strict()

const categoryDto = z
  .object({
    categoryId: z.string().max(100),
    version: z.number().int().positive(),
    name: z.string().max(100),
    description: z.string().max(2000),
    presentation: z.enum(['gallery', 'profile', 'list']),
    slots: z.array(categorySlotDto).max(32)
  })
  .strict()

export const LIBRARY_OUTPUTS = {
  'library.resource.list': z
    .object({
      items: z
        .array(
          resourceSummaryDto
            .extend({
              /** 列表只回传截断后的简介，完整描述经 resource.get 读取。 */
              description: z.string().max(300)
            })
            .strict()
        )
        .max(100),
      nextCursor: z.string().nullable()
    })
    .strict(),
  'library.resource.get': resourceDetailDto,
  'library.resource.preview_files': z
    .object({
      resourceId: identifier,
      revisionId: identifier,
      missingComponentIds: z.array(identifier).max(LIBRARY_MAX_COMPONENTS)
    })
    .strict(),
  'library.resource.create': resourceDetailDto,
  'library.resource.publish': resourceDetailDto,
  'library.resource.delete': z
    .object({ resourceId: identifier, deleted: z.literal(true) })
    .strict(),
  'library.resource.delete_many': z
    .object({
      items: z
        .array(
          z
            .object({
              resourceId: identifier,
              deleted: z.boolean(),
              code: z.string().max(64).optional()
            })
            .strict()
        )
        .max(LIBRARY_MAX_BATCH),
      deleted: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative()
    })
    .strict(),
  'library.resource.archive': resourceSummaryDto,
  'library.resource.set_folder': resourceSummaryDto,
  'library.resource.set_collections': resourceSummaryDto,
  'library.folder.list': z
    .object({ total: z.number().int().nonnegative(), folders: z.array(folderDto).max(200) })
    .strict(),
  'library.folder.create': folderDto,
  'library.folder.rename': folderDto,
  'library.folder.delete': z.object({ folderId: identifier, deleted: z.literal(true) }).strict(),
  'library.collection.list': z
    .object({ total: z.number().int().nonnegative(), collections: z.array(collectionDto).max(200) })
    .strict(),
  'library.collection.create': collectionDto,
  'library.category.list': z
    .object({ total: z.number().int().nonnegative(), categories: z.array(categoryDto).max(200) })
    .strict(),
  'library.category.save': categoryDto,
  'library.resource.materialize': z
    .object({
      projectId: identifier,
      resourceId: identifier,
      revisionId: identifier,
      usageId: identifier,
      graphVersion: z.number().int().nonnegative(),
      saved: z.literal(true),
      assetCount: z.number().int().nonnegative(),
      nodes: z
        .array(
          z
            .object({
              componentId: identifier,
              slotId: z.string().max(64),
              nodeId: z.string().max(180),
              nodeType: z.string().max(60),
              contractVersion: z.number().int().nonnegative(),
              mediaId: z.string().max(40).optional()
            })
            .strict()
        )
        .max(LIBRARY_MAX_COMPONENTS)
    })
    .strict(),
  'library.materialization.discard': z
    .object({ projectId: identifier, usageId: identifier, discarded: z.literal(true) })
    .strict()
} as const

export type LibraryResourceDetailDto = z.infer<typeof resourceDetailDto>
export type LibraryResourceSummaryDto = z.infer<typeof resourceSummaryDto>
export type LibraryFolderDto = z.infer<typeof folderDto>
export type LibraryCollectionDto = z.infer<typeof collectionDto>
export type LibraryCategoryDto = z.infer<typeof categoryDto>
export type LibraryMaterializeDto = z.infer<
  (typeof LIBRARY_OUTPUTS)['library.resource.materialize']
>
export type LibraryDeleteManyDto = z.infer<(typeof LIBRARY_OUTPUTS)['library.resource.delete_many']>

/** 组件元数据最多 64 KB，与 repo 的持久化校验同一上限（schema 无法直接表达字节数）。 */
export function metadataWithinLimit(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return true
  return JSON.stringify(metadata).length <= LIBRARY_MAX_METADATA_BYTES
}
