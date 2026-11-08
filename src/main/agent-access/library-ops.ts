// 资源库外部接入（F7）：全类型资源 CRUD、分类/文件夹/集合、修订、归档、批量删除与物化。
//
// 设计边界（与 AGENT_PARITY_SPEC §3/§5、AGENTS.md 保持一致）：
// 1) 业务实现只有一份：全部直接调用 GUI 使用的 store 服务
//    （library.repo 的 createResource/publishRevision/deleteResource/searchResources、
//    library-categories.repo 的 saveCategory、library-materialization.repo 的
//    materializeResource/discardMaterialization）。本模块不复制持久化规则，也不直写 SQLite；
//    写入前的规则校验复用 repo 导出的同一函数（validatePresetContents）与共享蓝图函数
//    （planResourceNodes/validateCategoryContent），避免出现第二份业务规则。
// 2) 外部独有的只有边界职责：外部输入只带「本机文件路径作为显式导入请求」（仅创建/修订）
//    或 mediaId；不携带已物化路径、不接收二进制报文。物化先由 main 生成项目受控媒体，
//    再走与 graph.patch 完全相同的桌面握手（类型化 node.create 批 + 保存屏障），
//    桌面载荷里的素材事实仍只有 mediaId/相对路径/MIME（main 解析后注入）。
// 3) 失败作为值返回（{ok:false, code, phase}），service 的 switch case 只做
//    code/phase → AccessFailure 映射；准入后的失联使用 DesktopAccessError(unknownOutcome)
//    让 dispatch 返回 unknown，不盲目补偿也不重放。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { DesktopAccessError, type AccessDesktop } from './desktop'
import {
  legacyCategory,
  planResourceNodes,
  validateCategoryContent,
  type LibraryCategory,
  type LibraryNodePlan
} from '../../shared/library/blueprint'
import type {
  LibraryCollection,
  LibraryComponentInput,
  LibraryFolder,
  LibraryPreset,
  LibraryResourceComponent,
  LibraryResourceDetail,
  LibraryResourceSummary,
  LibraryValueType
} from '../../shared/library/types'
import type { GraphPatchOp, MediaResolutionMap } from '../../shared/agent-access/graph-ops'
import {
  metadataWithinLimit,
  type LibraryCategoryDto,
  type LibraryCollectionDto,
  type LibraryDeleteManyDto,
  type LibraryFolderDto,
  type LibraryMaterializeDto,
  type LibraryResourceDetailDto,
  type LibraryResourceSummaryDto
} from '../../shared/agent-access/ops/library'
import * as library from '../store/library.repo'
import {
  getCategory,
  latestCategoryVersion,
  listCategories,
  saveCategory
} from '../store/library-categories.repo'
import {
  discardMaterialization,
  materializeResource,
  recordMaterializedNodes
} from '../store/library-materialization.repo'
import * as projects from '../store/projects.repo'
import { getDataDir } from '../store/db'
import { emitDomainEvent } from '../diagnostics/ipc-domain-events'

/** 单个资源文件上限：与 store/library.repo 的 MAX_COMPONENT_BYTES 一致。 */
const MAX_COMPONENT_BYTES = 128 * 1024 * 1024
/** 物化节点网格：与 GUI 拖入资源时的 390×310 间距一致，便于同一画布上人工续编。 */
const MATERIALIZE_COLUMN_WIDTH = 390
const MATERIALIZE_ROW_HEIGHT = 310
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,80}$/
const MEDIA_ID = /^[a-zA-Z0-9_-]{1,40}$/
const SLOT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const TEXT_VALUE_TYPES: ReadonlySet<string> = new Set(['text', 'markdown', 'json', 'recipe'])

const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
])
const AUDIO_MIME = new Map([
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac']
])
const VIDEO_MIME = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'],
  ['.m4v', 'video/x-m4v']
])
const TEXT_MIME = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json']
])

/** 失败作为值返回：service 的 switch case 只做 code/phase → AccessFailure 映射。 */
export type LibraryOutcome<T> =
  { ok: true; data: T } | { ok: false; code: string; phase: string; detail?: string }

export interface LibraryOperationDeps {
  desktop?: AccessDesktop
  activeProjectId: () => string | null
}

function ok<T>(data: T): LibraryOutcome<T> {
  return { ok: true, data }
}

function fail(code: string, phase: string, detail?: string): LibraryOutcome<never> {
  return { ok: false, code, phase, ...(detail ? { detail: detail.slice(0, 160) } : {}) }
}

/** 输入规则错误：与存储/IO 失败区分，回执码统一 INVALID_INPUT（阶段 library-validate）。 */
class LibraryInputError extends Error {}

function rule(run: () => void): void {
  try {
    run()
  } catch (error) {
    throw new LibraryInputError(sanitize(error))
  }
}

function sanitize(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200) || '操作被拒绝'
}

/** 失败映射：输入规则 → INVALID_INPUT；其它 → 该操作的存储失败码（不带原始异常正文）。 */
function failureOf(error: unknown, code: string, phase: string): LibraryOutcome<never> {
  if (error instanceof LibraryInputError)
    return fail('INVALID_INPUT', 'library-validate', error.message)
  return fail(code, phase, sanitize(error))
}

function safeIdentifier(value: unknown, max = 80): string | undefined {
  return typeof value === 'string' && value.length <= max && IDENTIFIER.test(value)
    ? value
    : undefined
}

function safeMediaId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 40 && MEDIA_ID.test(value) ? value : undefined
}

function safeSlotId(value: unknown): string | undefined {
  return typeof value === 'string' && SLOT_ID.test(value) ? value : undefined
}

function mimeFamily(valueType: LibraryValueType): 'image' | 'audio' | 'video' | undefined {
  if (valueType === 'image') return 'image'
  if (valueType === 'audio') return 'audio'
  if (valueType === 'video') return 'video'
  return undefined
}

/** 读取一个「显式本机导入」请求：绝对路径、普通文件、1 B–128 MB（与 repo 上限一致）。 */
function readImportFile(filePath: string): Uint8Array {
  if (!isAbsolute(filePath) || filePath.length > 500)
    throw new LibraryInputError('导入文件必须使用本机绝对路径')
  let size: number
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) throw new LibraryInputError('导入路径不是普通文件')
    size = stat.size
  } catch (error) {
    if (error instanceof LibraryInputError) throw error
    throw new LibraryInputError('导入文件不存在或不可读')
  }
  if (size < 1) throw new LibraryInputError('导入文件为空')
  if (size > MAX_COMPONENT_BYTES) throw new LibraryInputError('导入文件超过 128 MB 上限')
  let bytes: Buffer
  try {
    bytes = readFileSync(filePath)
  } catch {
    throw new LibraryInputError('导入文件读取失败')
  }
  if (bytes.byteLength !== size) throw new LibraryInputError('导入文件读取不完整')
  return new Uint8Array(bytes)
}

/** 外部组件输入 → repo 的组件输入（媒体内容只在这一步从本机文件读入）。 */
function buildComponents(raw: unknown): LibraryComponentInput[] {
  if (!Array.isArray(raw)) throw new LibraryInputError('components 必须是数组')
  return raw.map((value, index) => {
    const component = value as Record<string, unknown>
    const role = typeof component.role === 'string' ? component.role.trim().slice(0, 80) : ''
    if (!role) throw new LibraryInputError(`第 ${index + 1} 个组件缺少 role`)
    const valueType = component.valueType as LibraryValueType
    const metadata =
      component.metadata === undefined ? undefined : (component.metadata as Record<string, unknown>)
    if (metadata && !metadataWithinLimit(metadata))
      throw new LibraryInputError(`「${role}」的组件元数据超过 64 KB`)
    const reuseComponentId =
      typeof component.reuseComponentId === 'string' ? component.reuseComponentId : undefined
    const base: LibraryComponentInput = {
      role,
      valueType,
      ...(reuseComponentId ? { reuseComponentId } : {}),
      ...(metadata ? { metadata } : {})
    }
    if (TEXT_VALUE_TYPES.has(valueType)) {
      const text = component.text as string
      if (valueType === 'json') rule(() => JSON.parse(text))
      return { ...base, text }
    }
    const filePath = component.filePath as string
    const extension = extname(filePath).toLowerCase()
    const family = mimeFamily(valueType)
    const declaredMime = typeof component.mime === 'string' ? component.mime : undefined
    let mime: string
    if (family) {
      const table = family === 'image' ? IMAGE_MIME : family === 'audio' ? AUDIO_MIME : VIDEO_MIME
      const resolved = table.get(extension)
      if (!resolved) throw new LibraryInputError(`「${role}」的文件扩展名不支持 ${valueType} 组件`)
      if (declaredMime && !declaredMime.startsWith(`${family}/`))
        throw new LibraryInputError(`「${role}」的 MIME 与 ${valueType} 组件不匹配`)
      mime = resolved
    } else {
      mime = declaredMime ?? TEXT_MIME.get(extension) ?? 'application/octet-stream'
    }
    return {
      ...base,
      data: readImportFile(filePath),
      mime,
      fileName: basename(filePath).slice(0, 220),
      metadata: { ...(metadata ?? {}) }
    }
  })
}

/** 分类归属：用共享蓝图函数校验内容与槽位映射（与 GUI 表单同一规则）。 */
function assertCategory(
  category: { id: string; version: number },
  components: LibraryComponentInput[]
): void {
  rule(() => {
    const resolved = getCategory(category.id, category.version)
    validateCategoryContent(
      resolved,
      components.map((component) => ({ ...component, metadata: component.metadata ?? {} }))
    )
  })
}

function findDetail(resourceId: string, revisionId?: string): LibraryResourceDetail | null {
  try {
    return library.getResourceDetail(resourceId, revisionId)
  } catch (error) {
    throw new LibraryInputError(sanitize(error))
  }
}

function summaryDto(detail: LibraryResourceSummary): LibraryResourceSummaryDto {
  return {
    resourceId: detail.id,
    title: detail.title.slice(0, 200),
    formPreset: detail.formPreset,
    description: detail.description.slice(0, 20_000),
    tags: detail.tags.slice(0, 40).map((tag) => tag.slice(0, 48)),
    collectionIds: detail.collectionIds.slice(0, 100),
    folderIds: detail.folderIds.slice(0, 100),
    ...(detail.category
      ? {
          category: {
            id: detail.category.id.slice(0, 100),
            version: detail.category.version,
            name: detail.category.name.slice(0, 100)
          }
        }
      : {}),
    latestRevisionId: detail.latestRevisionId,
    revisionNumber: detail.revisionNumber,
    componentCount: detail.componentCount,
    archived: detail.archivedAt !== undefined,
    updatedAt: detail.updatedAt
  }
}

function componentDto(component: LibraryResourceComponent, includeText: boolean): unknown {
  const metadata = component.metadata ?? {}
  const sourceProjectId = safeIdentifier(metadata.sourceProjectId)
  const sourceMediaId = safeMediaId(metadata.sourceMediaId)
  const sourceNodeType =
    typeof metadata.sourceNodeType === 'string' ? metadata.sourceNodeType.slice(0, 60) : undefined
  const librarySlotId = safeSlotId(metadata.librarySlotId)
  return {
    componentId: component.id,
    role: component.role.slice(0, 80),
    valueType: component.valueType,
    order: Math.max(0, component.order),
    hasBlob: Boolean(component.blobPath),
    ...(component.contentHash ? { contentHash: component.contentHash } : {}),
    ...(component.mime ? { mime: component.mime.slice(0, 160) } : {}),
    ...(component.fileName ? { fileName: component.fileName.slice(0, 220) } : {}),
    ...(component.sizeBytes !== undefined ? { sizeBytes: component.sizeBytes } : {}),
    ...(component.text !== undefined
      ? includeText
        ? { text: component.text.slice(0, 20_000), textLength: component.text.length }
        : { textLength: component.text.length }
      : {}),
    references: {
      ...(sourceProjectId ? { sourceProjectId } : {}),
      ...(sourceMediaId ? { sourceMediaId } : {}),
      ...(sourceNodeType ? { sourceNodeType } : {}),
      ...(librarySlotId ? { librarySlotId } : {}),
      hasArtifactRecipe: metadata.artifactRecipe !== undefined && metadata.artifactRecipe !== null
    }
  }
}

function detailDto(detail: LibraryResourceDetail, includeText: boolean): LibraryResourceDetailDto {
  return {
    ...summaryDto(detail),
    selectedRevisionId: detail.selectedRevisionId,
    selectedRevisionNumber: detail.selectedRevisionNumber,
    revisions: detail.revisions.slice(0, 200).map((revision) => ({
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      title: revision.title.slice(0, 200),
      ...(revision.changeNote ? { changeNote: revision.changeNote.slice(0, 1000) } : {}),
      createdAt: revision.createdAt,
      componentCount: revision.componentCount
    })),
    components: detail.components
      .slice(0, 100)
      .map((component) =>
        componentDto(component, includeText)
      ) as LibraryResourceDetailDto['components'],
    usages: library.listResourceUsages(detail.id).map((usage) => ({
      projectId: usage.projectId,
      revisionId: usage.revisionId,
      createdAt: usage.createdAt,
      lastUsedAt: usage.lastUsedAt,
      materializedNodeCount: usage.materializedNodeCount
    }))
  }
}

function folderDto(folder: LibraryFolder): LibraryFolderDto {
  return {
    folderId: folder.id,
    name: folder.name.slice(0, 100),
    parentId: folder.parentId,
    resourceCount: folder.resourceCount,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt
  }
}

function collectionDto(collection: LibraryCollection): LibraryCollectionDto {
  return {
    collectionId: collection.id,
    name: collection.name.slice(0, 100),
    description: collection.description.slice(0, 2000),
    resourceCount: collection.resourceCount,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt
  }
}

function categoryDto(category: LibraryCategory): LibraryCategoryDto {
  return {
    categoryId: category.id.slice(0, 100),
    version: category.version,
    name: category.name.slice(0, 100),
    description: category.description.slice(0, 2000),
    presentation: category.presentation,
    slots: category.blueprint.slots.slice(0, 32).map((slot) => ({
      slotId: slot.id.slice(0, 64),
      label: slot.label.slice(0, 80),
      nodeType: slot.nodeType,
      contractVersion: slot.contractVersion,
      required: slot.required,
      multiple: slot.multiple,
      titleTemplate: slot.titleTemplate.slice(0, 180)
    }))
  }
}

function listResources(input: Record<string, unknown>): LibraryOutcome<unknown> {
  try {
    const result = library.searchResources({
      ...(typeof input.query === 'string' ? { query: input.query } : {}),
      ...(typeof input.formPreset === 'string'
        ? { formPreset: input.formPreset as LibraryPreset | 'all' }
        : {}),
      ...(typeof input.categoryId === 'string' ? { categoryId: input.categoryId } : {}),
      ...(typeof input.collectionId === 'string' ? { collectionId: input.collectionId } : {}),
      ...(typeof input.folderId === 'string' ? { folderId: input.folderId } : {}),
      includeArchived: input.includeArchived === true,
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      limit: input.limit as number
    })
    return ok({
      items: result.items.slice(0, 100).map((item) => ({
        ...summaryDto(item),
        description: item.description.slice(0, 300)
      })),
      nextCursor: result.nextCursor
    })
  } catch (error) {
    return failureOf(error, 'READ_FAILED', 'library-read')
  }
}

function getResource(input: Record<string, unknown>): LibraryOutcome<unknown> {
  try {
    const detail = findDetail(input.resourceId as string, input.revisionId as string | undefined)
    if (!detail) return fail('NOT_FOUND', 'read', '资源或指定修订不存在')
    return ok(detailDto(detail, input.includeText === true))
  } catch (error) {
    return failureOf(error, 'READ_FAILED', 'library-read')
  }
}

function previewFiles(input: Record<string, unknown>): LibraryOutcome<unknown> {
  try {
    const resourceId = input.resourceId as string
    const revisionId = input.revisionId as string
    const componentIds = input.componentIds as string[]
    if (new Set(componentIds).size !== componentIds.length)
      throw new LibraryInputError('componentIds 不能重复')
    const detail = findDetail(resourceId, revisionId)
    if (!detail) return fail('NOT_FOUND', 'read', '资源或指定修订不存在')
    const selected = componentIds.map((id) =>
      detail!.components.find((component) => component.id === id)
    )
    if (selected.some((component) => !component))
      throw new LibraryInputError('所选组件不属于该资源版本')
    const missing = selected
      .filter(
        (component) => component?.blobPath && !existsSync(join(getDataDir(), component.blobPath))
      )
      .map((component) => component!.id)
    return ok({ resourceId, revisionId, missingComponentIds: missing })
  } catch (error) {
    return failureOf(error, 'PREVIEW_FAILED', 'library-preview')
  }
}

function createResource(input: Record<string, unknown>): LibraryOutcome<unknown> {
  try {
    const formPreset = input.formPreset as LibraryPreset
    const components = buildComponents(input.components)
    rule(() => library.validatePresetContents(formPreset, components))
    const category = input.category as { id: string; version: number } | undefined
    if (category) assertCategory(category, components)
    const detail = library.createResource({
      title: input.title as string,
      formPreset,
      components,
      ...(input.description !== undefined ? { description: input.description as string } : {}),
      ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
      ...(category ? { category } : {}),
      ...(Array.isArray(input.collectionIds)
        ? { collectionIds: input.collectionIds as string[] }
        : {}),
      ...(typeof input.folderId === 'string' ? { folderId: input.folderId } : {}),
      ...(typeof input.changeNote === 'string' ? { changeNote: input.changeNote } : {})
    })
    return ok(detailDto(detail, false))
  } catch (error) {
    return failureOf(error, 'CREATE_FAILED', 'library-create')
  }
}

/** 修订发布：未给出的元数据沿用基础版本，避免“省略即清空”的隐性数据丢失。 */
function publishRevision(input: Record<string, unknown>): LibraryOutcome<unknown> {
  try {
    const resourceId = input.resourceId as string
    const baseRevisionId = input.baseRevisionId as string
    const current = findDetail(resourceId)
    if (!current) return fail('NOT_FOUND', 'read', '资源不存在')
    if (current.archivedAt !== undefined)
      return fail('RESOURCE_ARCHIVED', 'precheck', '归档资源不能发布修订')
    if (current.latestRevisionId !== baseRevisionId)
      return fail('REVISION_CONFLICT', 'library-version', '资源已有新版本')
    const base = findDetail(resourceId, baseRevisionId)
    if (!base) return fail('NOT_FOUND', 'read', '基础修订不存在')
    const formPreset = (input.formPreset as LibraryPreset | undefined) ?? base.formPreset
    const categoryInput = input.category as { id: string; version: number } | undefined
    const category =
      categoryInput ??
      (base.category ? { id: base.category.id, version: base.category.version } : undefined)
    const components = Array.isArray(input.components)
      ? buildComponents(input.components)
      : base.components.slice(0, 100).map((component) => ({
          role: component.role,
          valueType: component.valueType,
          reuseComponentId: component.id,
          metadata: component.metadata ?? {}
        }))
    rule(() => library.validatePresetContents(formPreset, components))
    if (category) assertCategory(category, components)
    const published = library.publishRevision({
      resourceId,
      baseRevisionId,
      ...(typeof input.sourceRevisionId === 'string'
        ? { sourceRevisionId: input.sourceRevisionId }
        : {}),
      title: (input.title as string | undefined) ?? base.selectedTitle,
      formPreset,
      description: (input.description as string | undefined) ?? base.selectedDescription,
      components,
      tags: (input.tags as string[] | undefined) ?? base.tags,
      collectionIds: (input.collectionIds as string[] | undefined) ?? base.collectionIds,
      ...(category ? { category } : {}),
      ...(typeof input.changeNote === 'string' ? { changeNote: input.changeNote } : {})
    })
    return ok(detailDto(published, false))
  } catch (error) {
    return failureOf(error, 'REVISION_FAILED', 'library-revision')
  }
}

function deleteResource(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const resourceId = input.resourceId as string
  try {
    if (!library.deleteResource(resourceId))
      return fail('NOT_FOUND', 'delete-admission', '资源不存在')
    return ok({ resourceId, deleted: true })
  } catch (error) {
    return failureOf(error, 'DELETE_FAILED', 'library-delete')
  }
}

/** 批量删除：逐项回执，单项不存在不静默跳过，也不影响其它项。 */
function deleteResources(input: Record<string, unknown>): LibraryOutcome<LibraryDeleteManyDto> {
  const resourceIds = [...new Set(input.resourceIds as string[])]
  const items: LibraryDeleteManyDto['items'] = []
  let deleted = 0
  for (const resourceId of resourceIds) {
    try {
      const removed = library.deleteResource(resourceId)
      items.push({ resourceId, deleted: removed, ...(removed ? {} : { code: 'NOT_FOUND' }) })
      if (removed) deleted += 1
    } catch {
      items.push({ resourceId, deleted: false, code: 'DELETE_FAILED' })
    }
  }
  return ok({ items, deleted, failed: items.length - deleted })
}

function archiveResource(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const resourceId = input.resourceId as string
  try {
    if (!findDetail(resourceId)) return fail('NOT_FOUND', 'read', '资源不存在')
    if (!library.archiveResource(resourceId, input.archived === true))
      return fail('NOT_FOUND', 'archive', '资源不存在')
    const detail = findDetail(resourceId)
    return detail ? ok(summaryDto(detail)) : fail('STORAGE_INCONSISTENT', 'archive')
  } catch (error) {
    return failureOf(error, 'ARCHIVE_FAILED', 'library-archive')
  }
}

function setFolder(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const resourceId = input.resourceId as string
  const folderId = typeof input.folderId === 'string' ? input.folderId : null
  try {
    if (!findDetail(resourceId)) return fail('NOT_FOUND', 'read', '资源不存在')
    library.setResourceFolder({ resourceId, folderId })
    const detail = findDetail(resourceId)
    return detail ? ok(summaryDto(detail)) : fail('STORAGE_INCONSISTENT', 'library-update')
  } catch (error) {
    // repo 在该路径上只抛“目标文件夹不存在”这类规则错误。
    return fail('INVALID_INPUT', 'library-validate', sanitize(error))
  }
}

function setCollections(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const resourceId = input.resourceId as string
  const collectionIds = input.collectionIds as string[]
  try {
    if (!findDetail(resourceId)) return fail('NOT_FOUND', 'read', '资源不存在')
    library.setResourceCollections({ resourceId, collectionIds })
    const detail = findDetail(resourceId)
    return detail ? ok(summaryDto(detail)) : fail('STORAGE_INCONSISTENT', 'library-update')
  } catch (error) {
    return fail('INVALID_INPUT', 'library-validate', sanitize(error))
  }
}

function listFolders(): LibraryOutcome<unknown> {
  try {
    const folders = library.listFolders()
    return ok({ total: folders.length, folders: folders.slice(0, 200).map(folderDto) })
  } catch (error) {
    return failureOf(error, 'READ_FAILED', 'library-folder')
  }
}

function createFolder(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const name = input.name as string
  const parentId = typeof input.parentId === 'string' ? input.parentId : null
  try {
    const folders = library.listFolders()
    if (parentId && !folders.some((folder) => folder.id === parentId))
      return fail('INVALID_INPUT', 'library-validate', '上级文件夹不存在')
    if (folders.some((folder) => folder.name === name && (folder.parentId ?? null) === parentId))
      return fail('FOLDER_CONFLICT', 'library-validate', '同一文件夹下不能有重名文件夹')
    return ok(folderDto(library.createFolder({ name, parentId })))
  } catch (error) {
    return failureOf(error, 'CREATE_FAILED', 'library-folder')
  }
}

function renameFolder(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const folderId = input.folderId as string
  const name = input.name as string
  try {
    const folders = library.listFolders()
    const current = folders.find((folder) => folder.id === folderId)
    if (!current) return fail('NOT_FOUND', 'read', '文件夹不存在')
    if (
      folders.some(
        (folder) =>
          folder.id !== folderId &&
          folder.name === name &&
          (folder.parentId ?? null) === (current.parentId ?? null)
      )
    )
      return fail('FOLDER_CONFLICT', 'library-validate', '同一文件夹下不能有重名文件夹')
    return ok(folderDto(library.renameFolder({ folderId, name })))
  } catch (error) {
    return failureOf(error, 'RENAME_FAILED', 'library-folder')
  }
}

function deleteFolder(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const folderId = input.folderId as string
  try {
    if (!library.listFolders().some((folder) => folder.id === folderId))
      return fail('NOT_FOUND', 'delete-admission', '文件夹不存在')
    if (!library.deleteFolder(folderId))
      return fail('NOT_FOUND', 'delete-admission', '文件夹不存在')
    return ok({ folderId, deleted: true })
  } catch (error) {
    return failureOf(error, 'DELETE_FAILED', 'library-folder')
  }
}

function listCollections(): LibraryOutcome<unknown> {
  try {
    const collections = library.listCollections()
    return ok({
      total: collections.length,
      collections: collections.slice(0, 200).map(collectionDto)
    })
  } catch (error) {
    return failureOf(error, 'READ_FAILED', 'library-collection')
  }
}

function createCollection(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const name = input.name as string
  try {
    if (library.listCollections().some((collection) => collection.name === name))
      return fail('COLLECTION_CONFLICT', 'library-validate', '收藏集名称已存在')
    return ok(
      collectionDto(
        library.createCollection({
          name,
          ...(typeof input.description === 'string' ? { description: input.description } : {})
        })
      )
    )
  } catch (error) {
    return failureOf(error, 'CREATE_FAILED', 'library-collection')
  }
}

function listCategoriesOp(): LibraryOutcome<unknown> {
  try {
    const categories = listCategories()
    return ok({ total: categories.length, categories: categories.slice(0, 200).map(categoryDto) })
  } catch (error) {
    return failureOf(error, 'READ_FAILED', 'library-category')
  }
}

function saveCategoryOp(input: Record<string, unknown>): LibraryOutcome<unknown> {
  const category = input.category as LibraryCategory
  const baseVersion = input.baseVersion as number
  try {
    if (category.version !== baseVersion + 1)
      return fail('INVALID_INPUT', 'library-validate', '分类版本必须为基础版本 +1')
    // 种子分类按需懒初始化（GUI 打开分类前也是同一次 list 调用），避免把“未初始化”误判成版本漂移。
    let latest = latestCategoryVersion(category.id)
    if (latest === null) {
      listCategories()
      latest = latestCategoryVersion(category.id)
    }
    if ((latest ?? 0) !== baseVersion)
      return fail('REVISION_CONFLICT', 'library-version', '分类已有新版本，请刷新后重试')
    return ok(categoryDto(saveCategory({ category, baseVersion })))
  } catch (error) {
    return failureOf(error, 'SAVE_FAILED', 'library-category')
  }
}

/**
 * 资源物化到画布：
 *   1) 共享蓝图规划节点（分类槽位、配方变量、JSON 校验与 GUI 同一函数）；
 *   2) 既有 materializeResource 把资源文件复制为项目受控媒体（内部失败自行补偿）；
 *   3) 与 graph.patch 完全相同的桌面握手：main 按 mediaId 注入存储事实，
 *      renderer 权威宿主整批校验、单撤销步应用并保存；
 *   4) 准入前失败 → 补偿删除刚复制的项目媒体（不留孤儿文件）；准入后失联 → unknown，
 *      不回滚（节点可能已存在），核对交给 project.open + graph.get。
 *
 * 已知编排边界：GUI 的插入路径还会写 meta.librarySource 与 tldraw 分组，那是呈现层
 * 语义；外部物化只保证「节点业务字段 + 受控媒体引用」与资源一致，不发明库来源标记。
 */
async function materialize(
  input: Record<string, unknown>,
  deps: LibraryOperationDeps
): Promise<LibraryOutcome<LibraryMaterializeDto>> {
  const projectId = input.projectId as string
  const resourceId = input.resourceId as string
  const revisionId = input.revisionId as string
  const componentIds = input.componentIds as string[]
  const expectedGraphVersion = input.expectedGraphVersion as number
  const desktop = deps.desktop
  if (deps.activeProjectId() !== projectId)
    return fail(
      'ACTIVE_PROJECT_REQUIRED',
      'desktop-ownership',
      'project.open the target canvas first, then retry library.resource.materialize'
    )
  if (!desktop) return fail('RESOURCE_BUSY', 'desktop-ownership', '桌面宿主不可用')
  const project = projects.openProject(projectId)
  if (!project) return fail('NOT_FOUND', 'read', '目标项目不存在')
  if (project.meta.graphVersion !== expectedGraphVersion)
    return fail('REVISION_CONFLICT', 'library-version', 'expectedGraphVersion 不是当前已保存版本')
  let detail: LibraryResourceDetail | null
  let plans: LibraryNodePlan[]
  try {
    detail = findDetail(resourceId, revisionId)
    if (!detail) return fail('NOT_FOUND', 'read', '资源或指定修订不存在')
    if (new Set(componentIds).size !== componentIds.length)
      throw new LibraryInputError('componentIds 不能重复')
    const category = detail.category ?? legacyCategory(detail.formPreset, detail.components)
    plans = planResourceNodes(
      category,
      detail.components,
      detail.selectedTitle,
      componentIds,
      (input.variables as Record<string, Record<string, string>> | undefined) ?? {}
    )
    if (plans.length === 0) throw new LibraryInputError('所选组件没有可创建的节点')
  } catch (error) {
    return failureOf(error, 'INVALID_INPUT', 'library-validate')
  }
  let materialized: Awaited<ReturnType<typeof materializeResource>>
  try {
    materialized = await materializeResource({ projectId, resourceId, revisionId, componentIds })
  } catch (error) {
    return fail('MATERIALIZE_FAILED', 'library-materialize', sanitize(error))
  }
  const assetByComponent = new Map(
    materialized.componentAssets.map((pair) => [pair.componentId, pair.asset])
  )
  const originX = typeof input.x === 'number' ? Math.round(input.x) : 0
  const originY = typeof input.y === 'number' ? Math.round(input.y) : 0
  const columns = Math.min(3, plans.length)
  const mediaResolutions: MediaResolutionMap = {}
  const ops: GraphPatchOp[] = plans.map((plan, index) => {
    const asset = assetByComponent.get(plan.componentId)
    if (asset && !mediaResolutions[asset.id]) {
      mediaResolutions[asset.id] = {
        mediaId: asset.id,
        mediaPath: asset.path,
        mediaMime: asset.mime,
        ...(asset.name ? { name: asset.name.slice(0, 200) } : {})
      }
    }
    return {
      action: 'node.create',
      ref: `r${index}`,
      nodeType: plan.nodeType,
      title: plan.title.slice(0, 200),
      x: originX + (index % columns) * MATERIALIZE_COLUMN_WIDTH,
      y: originY + Math.floor(index / columns) * MATERIALIZE_ROW_HEIGHT,
      ...(plan.text !== undefined ? { text: plan.text } : {}),
      ...(asset ? { media: { mediaId: asset.id } } : {})
    } as GraphPatchOp
  })
  const emitFailed = (phase: string, cleanup: boolean): void => {
    emitDomainEvent('library.materialization_failed', '资源物化失败', {
      status: 'failed',
      resourceId,
      attributes: {
        operation: 'library.resource.materialize',
        phase,
        cleanup: cleanup ? 'completed' : 'incomplete'
      }
    })
  }
  const compensate = async (error: unknown, code: string): Promise<LibraryOutcome<never>> => {
    let cleaned = false
    try {
      cleaned = await discardMaterialization({ projectId, usageId: materialized.usageId })
    } catch {
      cleaned = false
    }
    emitFailed(code, cleaned)
    return fail(code, 'library-materialize', sanitize(error))
  }
  let patchResult: Awaited<ReturnType<AccessDesktop['run']>>
  let committed = false
  try {
    patchResult = await desktop.run(
      {
        action: 'graph-patch',
        projectId,
        ops,
        expectedGraphVersion,
        ...(Object.keys(mediaResolutions).length ? { mediaResolutions } : {})
      },
      (version) => {
        if (deps.activeProjectId() !== projectId) throw new DesktopAccessError('RESOURCE_BUSY')
        const admitted = projects.openProject(projectId)
        if (!admitted || admitted.meta.graphVersion !== version)
          throw new DesktopAccessError('REVISION_CONFLICT')
        committed = true
        return admitted.meta
      }
    )
  } catch (error) {
    if (error instanceof DesktopAccessError) {
      // validated=true（unknownOutcome=false）说明失败发生在任何变更之前，可安全补偿；
      // 否则按 unknown 让 dispatch 返回，绝不能删除可能已被节点引用的媒体。
      if (error.unknownOutcome) throw error
      return compensate(new Error(sanitize(error.detail ?? error.code)), error.code)
    }
    if (committed) throw new DesktopAccessError('OUTCOME_UNKNOWN', true)
    return compensate(error, 'MATERIALIZE_FAILED')
  }
  const savedFile = projects.openProject(projectId)
  const payload = (patchResult.result ?? {}) as {
    created?: Array<{ ref?: string; nodeId?: string }>
  }
  const createdByRef = new Map<string, string>()
  for (const created of payload.created ?? []) {
    if (typeof created.nodeId === 'string' && typeof created.ref === 'string')
      createdByRef.set(created.ref, created.nodeId)
  }
  const nodes: LibraryMaterializeDto['nodes'] = []
  for (const [index, plan] of plans.entries()) {
    const nodeId = createdByRef.get(`r${index}`)
    const node =
      nodeId && savedFile ? savedFile.nodes.find((candidate) => candidate.id === nodeId) : undefined
    const asset = assetByComponent.get(plan.componentId)
    // 准入后核对：回执节点必须真实落盘，素材节点的引用必须是刚复制的受控媒体。
    if (
      !savedFile ||
      !nodeId ||
      !node ||
      savedFile.meta.graphVersion !== patchResult.graphVersion ||
      (asset && (node.content.kind !== 'media' || node.content.mediaId !== asset.id))
    ) {
      emitFailed('verify', false)
      throw new DesktopAccessError('OUTCOME_UNKNOWN', true)
    }
    nodes.push({
      componentId: plan.componentId,
      slotId: plan.slotId,
      nodeId,
      nodeType: node.type.slice(0, 60),
      contractVersion: node.contractVersion,
      ...(asset ? { mediaId: asset.id } : {})
    })
  }
  try {
    recordMaterializedNodes({
      projectId,
      usageId: materialized.usageId,
      nodeIds: nodes.map((node) => node.nodeId)
    })
  } catch {
    // 使用记录回填失败不改变已创建的节点与媒体事实。
  }
  emitDomainEvent('library.materialization_completed', '资源已物化到画布', {
    status: 'success',
    resourceId,
    attributes: {
      operation: 'library.resource.materialize',
      phase: 'materialize',
      nodes: nodes.length,
      assets: materialized.assets.length
    }
  })
  return ok({
    projectId,
    resourceId,
    revisionId,
    usageId: materialized.usageId,
    graphVersion: patchResult.graphVersion,
    saved: true,
    assetCount: materialized.assets.length,
    nodes
  })
}

async function discard(input: Record<string, unknown>): Promise<LibraryOutcome<unknown>> {
  const projectId = input.projectId as string
  const usageId = input.usageId as string
  try {
    const discarded = await discardMaterialization({ projectId, usageId })
    if (!discarded) return fail('NOT_FOUND', 'materialize-discard', '使用记录不存在或已清理')
    return ok({ projectId, usageId, discarded: true })
  } catch (error) {
    return failureOf(error, 'MATERIALIZE_CLEANUP_FAILED', 'materialize-discard')
  }
}

/** 资源库族统一入口：service 的 switch case 只做 outcome → AccessFailure 投影。 */
export async function runLibraryOperation(
  operation: string,
  input: Record<string, unknown>,
  deps: LibraryOperationDeps
): Promise<LibraryOutcome<unknown>> {
  switch (operation) {
    case 'library.resource.list':
      return listResources(input)
    case 'library.resource.get':
      return getResource(input)
    case 'library.resource.preview_files':
      return previewFiles(input)
    case 'library.resource.create':
      return createResource(input)
    case 'library.resource.publish':
      return publishRevision(input)
    case 'library.resource.delete':
      return deleteResource(input)
    case 'library.resource.delete_many':
      return deleteResources(input)
    case 'library.resource.archive':
      return archiveResource(input)
    case 'library.resource.set_folder':
      return setFolder(input)
    case 'library.resource.set_collections':
      return setCollections(input)
    case 'library.folder.list':
      return listFolders()
    case 'library.folder.create':
      return createFolder(input)
    case 'library.folder.rename':
      return renameFolder(input)
    case 'library.folder.delete':
      return deleteFolder(input)
    case 'library.collection.list':
      return listCollections()
    case 'library.collection.create':
      return createCollection(input)
    case 'library.category.list':
      return listCategoriesOp()
    case 'library.category.save':
      return saveCategoryOp(input)
    case 'library.resource.materialize':
      return materialize(input, deps)
    case 'library.materialization.discard':
      return discard(input)
    default:
      // 只允许 service.ts 在本族 case 里路由；未知操作如实拒绝，不做兜底执行。
      return fail('UNSUPPORTED_OPERATION', 'dispatch')
  }
}
