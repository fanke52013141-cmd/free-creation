import { validateCategoryContent } from '../../shared/library/blueprint'
import { revisionCategory, pinCategory, importRevisionCategory, exportCategoryVersions, importCategoryDefinition } from './library-categories.repo'
import { createHash } from 'crypto'
import AdmZip from 'adm-zip'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { nanoid } from 'nanoid'
import type {
  CreateLibraryCollectionInput,
  CreateLibraryFolderInput,
  RenameLibraryFolderInput,
  CreateLibraryResourceInput,
  CaptureProjectMediaInput,
  CaptureProjectNodesInput,
  LibraryBoard,
  LibraryBoardItem,
  LibraryCollection,
  LibraryFolder,
  LibraryComponentInput,
  LibraryPreset,
  LibraryResourceComponent,
  LibraryResourceDetail,
  LibraryResourceSummary,
  LibrarySearchInput,
  PublishLibraryRevisionInput,
  SaveLibraryBoardInput,
  SetLibraryCollectionsInput
} from '../../shared/library/types'
import { getDataDir, getDb } from './db'
import { getMediaAbsPath } from './media.repo'

const MAX_COMPONENT_BYTES = 128 * 1024 * 1024
const MAX_TEXT_CHARS = 2_000_000
const MAX_LIBRARY_PACKAGE_BYTES = 512 * 1024 * 1024
const VALID_PRESETS = new Set<LibraryPreset>(['image', 'prompt', 'character', 'scene', 'style', 'custom'])
const VALID_VALUE_TYPES = new Set(['text', 'markdown', 'image', 'audio', 'video', 'file', 'json', 'recipe'])

interface ResourceRow {
  id: string
  form_preset: LibraryPreset
  title: string
  description: string
  latest_revision_id: string
  archived_at: number | null
  created_at: number
  updated_at: number
  revision_number: number
  component_count: number
  cover_path: string | null
}

interface ComponentRow {
  id: string
  role: string
  value_type: LibraryResourceComponent['valueType']
  text_content: string | null
  metadata_json: string
  sort_index: number
  blob_path: string | null
  blob_sha256: string | null
  blob_mime: string | null
  file_name: string | null
  size_bytes: number | null
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function cleanText(value: unknown, max = 10_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function hashFile(filePath: string): string {
  const hash = createHash('sha256')
  const descriptor = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

function cleanTags(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().replace(/\s+/g, ' ').slice(0, 48))
    .filter(Boolean))].slice(0, 40)
}

function resourceCollections(resourceId: string): string[] {
  return (getDb().prepare(
    'SELECT collection_id FROM library_collection_items WHERE resource_id = ? ORDER BY added_at ASC'
  ).all(resourceId) as Array<{ collection_id: string }>).map((row) => row.collection_id)
}

function resourceTags(resourceId: string): string[] {
  return (getDb().prepare(
    'SELECT tag FROM library_tags WHERE resource_id = ? ORDER BY tag COLLATE NOCASE ASC'
  ).all(resourceId) as Array<{ tag: string }>).map((row) => row.tag)
}

function resourceFolderIds(resourceId: string): string[] {
  return (getDb().prepare(
    'SELECT folder_id FROM library_resource_folders WHERE resource_id = ? ORDER BY added_at ASC'
  ).all(resourceId) as Array<{ folder_id: string }>).map((row) => row.folder_id)
}

function folderPath(folderId: string): string[] {
  const path: string[] = []
  const visited = new Set<string>()
  let currentId: string | null = folderId
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const current = getDb().prepare('SELECT name, parent_id FROM library_folders WHERE id = ?').get(currentId) as
      | { name: string; parent_id: string | null }
      | undefined
    if (!current) break
    path.unshift(current.name)
    currentId = current.parent_id
  }
  return path
}

function resourceFolderPaths(resourceId: string): string[][] {
  return resourceFolderIds(resourceId).map(folderPath).filter((path) => path.length > 0)
}

function allFolderPaths(): string[][] {
  return (getDb().prepare('SELECT id FROM library_folders ORDER BY created_at ASC').all() as Array<{ id: string }>)
    .map((row) => folderPath(row.id)).filter((path) => path.length > 0)
}

function resourceSummary(row: ResourceRow): LibraryResourceSummary {
  const category = revisionCategory(row.latest_revision_id)
  const cover = category?.coverSlotId ? readComponents(row.latest_revision_id).find((component) =>
    component.metadata.librarySlotId === category.coverSlotId && component.valueType === 'image')?.blobPath : row.cover_path
  return {
    id: row.id,
    formPreset: row.form_preset,
    title: row.title,
    description: row.description,
    category,
    latestRevisionId: row.latest_revision_id,
    revisionNumber: row.revision_number,
    componentCount: row.component_count,
    ...(cover ? { coverPath: cover } : {}),
    tags: resourceTags(row.id),
    collectionIds: resourceCollections(row.id),
    folderIds: resourceFolderIds(row.id),
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {})
  }
}

function summarySql(): string {
  return `
    SELECT r.id, r.form_preset, r.title, r.description, r.latest_revision_id,
      r.archived_at, r.created_at, r.updated_at, rev.revision_number,
      COUNT(c.id) AS component_count,
      (SELECT b.path FROM library_components cover
        JOIN library_blobs b ON b.id = cover.blob_id
        WHERE cover.revision_id = rev.id AND cover.value_type = 'image'
        ORDER BY cover.sort_index LIMIT 1) AS cover_path
    FROM library_resources r
    JOIN library_revisions rev ON rev.id = r.latest_revision_id
    LEFT JOIN library_components c ON c.revision_id = rev.id
  `
}

function insertTags(resourceId: string, values: unknown): void {
  const database = getDb()
  const insert = database.prepare('INSERT OR IGNORE INTO library_tags (resource_id, tag) VALUES (?, ?)')
  for (const tag of cleanTags(values)) insert.run(resourceId, tag)
}

function setCollectionsInternal(resourceId: string, collectionIds: string[]): void {
  const database = getDb()
  const ids = [...new Set(collectionIds)]
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    const found = database.prepare(
      `SELECT id FROM library_collections WHERE id IN (${placeholders})`
    ).all(...ids) as Array<{ id: string }>
    if (found.length !== ids.length) throw new Error('包含不存在的收藏集')
  }
  database.prepare('DELETE FROM library_collection_items WHERE resource_id = ?').run(resourceId)
  const add = database.prepare(
    'INSERT INTO library_collection_items (collection_id, resource_id, added_at) VALUES (?, ?, ?)'
  )
  const now = Date.now()
  for (const id of ids) add.run(id, resourceId, now)
}

function storeBlob(data: Uint8Array, mimeValue: unknown, fileNameValue: unknown): { id: string; path: string } {
  const bytes = Buffer.from(data)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMPONENT_BYTES) {
    throw new Error('单个资源文件为空或超过 128 MB 限制')
  }
  const mime = cleanText(mimeValue, 160) || 'application/octet-stream'
  const safeName = basename(cleanText(fileNameValue, 220).replace(/[\\/]/g, '_')) || 'resource.bin'
  const hash = createHash('sha256').update(bytes).digest('hex')
  const existing = getDb().prepare('SELECT id, path FROM library_blobs WHERE sha256 = ?').get(hash) as
    | { id: string; path: string }
    | undefined
  if (existing && existsSync(join(getDataDir(), existing.path))) return existing

  const extension = extname(safeName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12)
  const relativePath = `library/blobs/${hash.slice(0, 2)}/${hash}${extension}`
  const absolutePath = join(getDataDir(), relativePath)
  mkdirSync(join(getDataDir(), 'library', 'blobs', hash.slice(0, 2)), { recursive: true })
  if (!existsSync(absolutePath)) {
    const temporary = `${absolutePath}.${nanoid(6)}.tmp`
    writeFileSync(temporary, bytes, { flag: 'wx' })
    try {
      renameSync(temporary, absolutePath)
    } catch (error) {
      if (existsSync(temporary)) {
        // Another import with identical bytes may have committed the same content hash.
        const current = getDb().prepare('SELECT id, path FROM library_blobs WHERE sha256 = ?').get(hash) as
          | { id: string; path: string }
          | undefined
        if (!current) throw error
      }
    }
  }
  const id = nanoid(12)
  const now = Date.now()
  getDb().prepare(
    `INSERT OR IGNORE INTO library_blobs (id, sha256, path, mime, file_name, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, hash, relativePath, mime, safeName, bytes.byteLength, now)
  const row = getDb().prepare('SELECT id, path FROM library_blobs WHERE sha256 = ?').get(hash) as
    { id: string; path: string }
  return row
}

function validateComponents(components: LibraryComponentInput[]): LibraryComponentInput[] {
  if (!Array.isArray(components) || components.length === 0 || components.length > 100) {
    throw new Error('资源至少需要一个组件，且最多支持 100 个组件')
  }
  return components.map((component) => {
    if (!component || !VALID_VALUE_TYPES.has(component.valueType)) throw new Error('资源组件类型无效')
    const role = cleanText(component.role, 80)
    if (!role) throw new Error('资源组件用途不能为空')
    if (component.metadata !== undefined && (!component.metadata || typeof component.metadata !== 'object' || Array.isArray(component.metadata))) {
      throw new Error(`「${role}」的组件元数据无效`)
    }
    if (JSON.stringify(component.metadata ?? {}).length > 64_000) throw new Error(`「${role}」的组件元数据超过 64 KB`)
    const textType = ['text', 'markdown', 'json', 'recipe'].includes(component.valueType)
    if (textType && (!component.reuseComponentId && typeof component.text !== 'string')) {
      throw new Error(`「${role}」需要填写文本内容`)
    }
    if (textType && typeof component.text === 'string' && component.text.length > MAX_TEXT_CHARS) {
      throw new Error(`「${role}」内容超过 2,000,000 字符限制`)
    }
    if (!textType && !component.reuseComponentId && !(component.data instanceof Uint8Array)) {
      throw new Error(`「${role}」需要选择文件`)
    }
    return { ...component, role }
  })
}

function validatePresetContents(preset: LibraryPreset, components: LibraryComponentInput[]): void {
  const valid = validateComponents(components)
  if (preset === 'image' && !valid.some((component) => component.valueType === 'image')) {
    throw new Error('图片资源至少需要一张图片')
  }
  if (preset === 'prompt' && !valid.some((component) =>
    ['text', 'markdown', 'recipe'].includes(component.valueType) &&
    (component.role.toLocaleLowerCase().includes('prompt') || component.role.includes('提示词')) &&
    (typeof component.text === 'string' ? component.text.trim().length > 0 : Boolean(component.reuseComponentId))
  )) {
    throw new Error('提示词资源需要填写提示词正文')
  }
  for (const recipe of valid.filter((component) => component.valueType === 'recipe')) {
    if (!recipe.text?.trim()) throw new Error(`「${recipe.role}」的配方提示词不能为空`)
    const metadata = recipe.metadata ?? {}
    const variables = Array.isArray(metadata.variables)
      ? metadata.variables.filter((value): value is string => typeof value === 'string')
      : []
    if (variables.some((name) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name))) {
      throw new Error(`「${recipe.role}」包含无效变量名`)
    }
    const placeholders = [...recipe.text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g)]
    const missing = [...new Set(placeholders.map((match) => match[1]))].filter((name) => !variables.includes(name))
    if (missing.length) throw new Error(`「${recipe.role}」缺少变量定义：${missing.join('、')}`)
    const parameters = metadata.modelParameters
    if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))) {
      throw new Error(`「${recipe.role}」模型参数必须是对象`)
    }
    const referenceRoles = Array.isArray(metadata.referenceRoles)
      ? metadata.referenceRoles.filter((value): value is string => typeof value === 'string')
      : []
    const availableRoles = new Set(valid.filter((component) => component !== recipe).map((component) => component.role))
    const missingRoles = referenceRoles.filter((role) => !availableRoles.has(role))
    if (missingRoles.length) throw new Error(`「${recipe.role}」引用了不存在的资源组件：${missingRoles.join('、')}`)
  }
}

function prepareComponentBlob(
  component: LibraryComponentInput,
  baseRevisionId?: string
): { blobId: string | null; text: string | null } {
  if (component.reuseComponentId) {
    if (!baseRevisionId) throw new Error('新资源不能引用其他资源的组件')
    const prior = getDb().prepare(
      `SELECT c.blob_id, c.text_content, c.value_type, rev.resource_id
       FROM library_components c JOIN library_revisions rev ON rev.id = c.revision_id
       WHERE c.id = ?`
    ).get(component.reuseComponentId) as
      | { blob_id: string | null; text_content: string | null; resource_id: string; value_type: string }
      | undefined
    const base = getDb().prepare('SELECT resource_id FROM library_revisions WHERE id = ?').get(baseRevisionId) as
      | { resource_id: string }
      | undefined
    if (!prior || !base || prior.resource_id !== base.resource_id) throw new Error('要复用的资源组件不属于当前资源')
    if (prior.value_type !== component.valueType) throw new Error('资源组件版本类型不可变')
    return {
      blobId: prior.blob_id,
      text: component.text === undefined ? prior.text_content : component.text
    }
  }
  if (component.data) {
    return {
      blobId: storeBlob(component.data, component.mime, component.fileName).id,
      text: null
    }
  }
  return { blobId: null, text: component.text ?? '' }
}

function insertComponents(
  revisionId: string,
  components: LibraryComponentInput[],
  baseRevisionId?: string
): void {
  const insert = getDb().prepare(
    `INSERT INTO library_components
      (id, revision_id, role, value_type, text_content, blob_id, metadata_json, sort_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const now = Date.now()
  validateComponents(components).forEach((component, index) => {
    const prepared = prepareComponentBlob(component, baseRevisionId)
    insert.run(
      nanoid(12),
      revisionId,
      component.role,
      component.valueType,
      prepared.text,
      prepared.blobId,
      JSON.stringify(component.metadata ?? {}),
      index,
      now
    )
  })
}

function getResourceRow(id: string): ResourceRow | null {
  return (getDb().prepare(
    `${summarySql()} WHERE r.id = ? GROUP BY r.id, rev.id`
  ).get(id) as ResourceRow | undefined) ?? null
}

export function searchResources(input: LibrarySearchInput = {}): {
  items: LibraryResourceSummary[]
  nextCursor: string | null
} {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 40)))
  const offset = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0)
  const conditions: string[] = []
  const params: unknown[] = []
  if (!input.includeArchived) conditions.push('r.archived_at IS NULL')
  if (input.formPreset && input.formPreset !== 'all') {
    conditions.push('r.form_preset = ?')
    params.push(input.formPreset)
  }
  if (input.categoryId) {
    if (input.categoryId === 'legacy') conditions.push('NOT EXISTS (SELECT 1 FROM library_revision_blueprints bp WHERE bp.revision_id = rev.id)')
    else {
      conditions.push('EXISTS (SELECT 1 FROM library_revision_blueprints bp WHERE bp.revision_id = rev.id AND bp.category_id = ?)')
      params.push(input.categoryId)
    }
  }
  if (input.collectionId) {
    conditions.push('EXISTS (SELECT 1 FROM library_collection_items ci WHERE ci.resource_id = r.id AND ci.collection_id = ?)')
    params.push(input.collectionId)
  }
  if (input.folderId === 'root') {
    conditions.push('NOT EXISTS (SELECT 1 FROM library_resource_folders rf WHERE rf.resource_id = r.id)')
  } else if (input.folderId) {
    conditions.push('EXISTS (SELECT 1 FROM library_resource_folders rf WHERE rf.resource_id = r.id AND rf.folder_id = ?)')
    params.push(input.folderId)
  }
  const query = cleanText(input.query, 300)
  if (query) {
    conditions.push(`(
      r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR
      EXISTS (SELECT 1 FROM library_tags t WHERE t.resource_id = r.id AND t.tag LIKE ? ESCAPE '\\') OR
      EXISTS (SELECT 1 FROM library_components sc JOIN library_revisions sr ON sr.id = sc.revision_id
        WHERE sr.id = r.latest_revision_id AND sc.text_content LIKE ? ESCAPE '\\')
    )`)
    const escaped = query.replace(/[\\%_]/g, '\\$&')
    for (let i = 0; i < 4; i += 1) params.push(`%${escaped}%`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = getDb().prepare(
    `${summarySql()} ${where} GROUP BY r.id, rev.id ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit + 1, offset) as ResourceRow[]
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(resourceSummary),
    nextCursor: hasMore ? String(offset + limit) : null
  }
}

function readComponents(revisionId: string): LibraryResourceComponent[] {
  const rows = getDb().prepare(
    `SELECT c.id, c.role, c.value_type, c.text_content, c.metadata_json, c.sort_index,
       b.path AS blob_path, b.sha256 AS blob_sha256, b.mime AS blob_mime, b.file_name, b.size_bytes
     FROM library_components c LEFT JOIN library_blobs b ON b.id = c.blob_id
     WHERE c.revision_id = ? ORDER BY c.sort_index ASC`
  ).all(revisionId) as ComponentRow[]
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    valueType: row.value_type,
    ...(row.text_content !== null ? { text: row.text_content } : {}),
    ...(row.blob_path ? { blobPath: row.blob_path } : {}),
    ...(row.blob_sha256 ? { contentHash: row.blob_sha256 } : {}),
    ...(row.blob_mime ? { mime: row.blob_mime } : {}),
    ...(row.file_name ? { fileName: row.file_name } : {}),
    ...(row.size_bytes !== null ? { sizeBytes: row.size_bytes } : {}),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    order: row.sort_index
  }))
}

export function getResourceDetail(id: string, revisionId?: string): LibraryResourceDetail | null {
  const row = getResourceRow(id)
  if (!row) return null
  const revision = revisionId
    ? getDb().prepare('SELECT * FROM library_revisions WHERE id = ? AND resource_id = ?').get(revisionId, id) as
        | { id: string; revision_number: number; title: string; description: string; change_note: string | null; created_at: number }
        | undefined
    : undefined
  if (revisionId && !revision) return null
  const revisions = getDb().prepare(
    `SELECT rev.id, rev.revision_number, rev.title, rev.description, rev.change_note, rev.created_at,
       COUNT(c.id) AS component_count
     FROM library_revisions rev LEFT JOIN library_components c ON c.revision_id = rev.id
     WHERE rev.resource_id = ? GROUP BY rev.id ORDER BY rev.revision_number DESC`
  ).all(id) as Array<{
    id: string; revision_number: number; title: string; description: string;
    change_note: string | null; created_at: number; component_count: number
  }>
  const current = revision ?? getDb().prepare(
    `SELECT id, revision_number, title, description, change_note, created_at
     FROM library_revisions WHERE id = ?`
  ).get(row.latest_revision_id) as
    | { id: string; revision_number: number; title: string; description: string; change_note: string | null; created_at: number }
    | undefined
  if (!current) return null
  return {
    ...resourceSummary(row),
    category: revisionCategory(current.id),
    selectedRevisionId: current.id,
    selectedRevisionNumber: current.revision_number,
    selectedTitle: current.title,
    selectedDescription: current.description,
    ...(current.change_note ? { selectedChangeNote: current.change_note } : {}),
    revisions: revisions.map((item) => ({
      id: item.id,
      revisionNumber: item.revision_number,
      title: item.title,
      description: item.description,
      ...(item.change_note ? { changeNote: item.change_note } : {}),
      createdAt: item.created_at,
      componentCount: item.component_count
    })),
    components: readComponents(current.id)
  }
}

function persistResource(
  input: CreateLibraryResourceInput,
  resourceId: string,
  revisionId: string,
  now: number
): void {
  if (!VALID_PRESETS.has(input.formPreset)) throw new Error('资源类型无效')
  const title = cleanText(input.title, 180)
  if (!title) throw new Error('资源名称不能为空')
  validatePresetContents(input.formPreset, input.components)
  const description = cleanText(input.description, 20_000)
  const collectionIds = Array.isArray(input.collectionIds) ? input.collectionIds : []
  const database = getDb()
  database.transaction(() => {
    database.prepare(
      `INSERT INTO library_resources
        (id, form_preset, title, description, latest_revision_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(resourceId, input.formPreset, title, description, revisionId, now, now)
    database.prepare(
      `INSERT INTO library_revisions
        (id, resource_id, revision_number, base_revision_id, title, description, change_note, created_at)
       VALUES (?, ?, 1, NULL, ?, ?, ?, ?)`
    ).run(revisionId, resourceId, title, description, cleanText(input.changeNote, 1000) || '初始版本', now)
    pinCategory(revisionId, input.category, input.components)
    insertComponents(revisionId, input.components)
    insertTags(resourceId, input.tags)
    setCollectionsInternal(resourceId, collectionIds)
    if (input.folderId) setResourceFolderInternal(resourceId, input.folderId)
  })()
}

export function createResource(input: CreateLibraryResourceInput): LibraryResourceDetail {
  if (!input || !VALID_PRESETS.has(input.formPreset)) throw new Error('资源类型无效')
  const resourceId = nanoid(12)
  const revisionId = nanoid(12)
  const now = Date.now()
  persistResource(input, resourceId, revisionId, now)
  const result = getResourceDetail(resourceId)
  if (!result) throw new Error('资源保存成功但无法读取，请重新打开资源库')
  return result
}

/** Copy a project-owned media file into the global local library without exposing its path. */
export function captureProjectMedia(input: CaptureProjectMediaInput): LibraryResourceDetail {
  if (!input?.projectId || !input.mediaId) throw new Error('项目素材参数不完整')
  const prefix = `projects/${input.projectId}/media/`
  const row = getDb().prepare(
    `SELECT m.id, m.kind, m.mime, m.path, m.size_bytes, m.name
     FROM media m JOIN projects p ON p.id = ? AND p.deleted = 0
     WHERE m.id = ? AND m.path LIKE ?`
  ).get(input.projectId, input.mediaId, `${prefix}%`) as
    | { id: string; kind: string; mime: string; path: string; size_bytes: number; name: string | null }
    | undefined
  if (!row || !row.path.replace(/\\/g, '/').startsWith(prefix)) {
    throw new Error('素材不存在或不属于当前项目')
  }
  const mediaName = row.path.replace(/\\/g, '/').slice(prefix.length)
  if (!mediaName || mediaName.includes('/') || mediaName.includes('..')) throw new Error('项目素材路径无效')
  if (row.size_bytes <= 0 || row.size_bytes > MAX_COMPONENT_BYTES) {
    throw new Error('资源库单个文件最多支持 128 MB')
  }
  const absolutePath = getMediaAbsPath(row.path)
  if (!absolutePath || !existsSync(absolutePath)) throw new Error('项目素材文件缺失')
  const bytes = readFileSync(absolutePath)
  if (bytes.byteLength !== row.size_bytes) throw new Error('项目素材大小校验失败')
  const valueType: LibraryComponentInput['valueType'] =
    row.kind === 'image' || row.kind === 'audio' || row.kind === 'video' ? row.kind : 'file'
  const title = cleanText(input.title, 180) || row.name || basename(absolutePath, extname(absolutePath))
  return createResource({
    title,
    formPreset: valueType === 'image' ? 'image' : 'custom',
    description: cleanText(input.description, 20_000),
    tags: input.tags,
    components: [{
      role: valueType === 'image' ? 'reference-image' : valueType === 'video' ? 'video-reference' : valueType === 'audio' ? 'voice-reference' : 'reference-file',
      valueType,
      data: new Uint8Array(bytes),
      mime: row.mime,
      fileName: basename(absolutePath),
      metadata: { sourceProjectId: input.projectId, sourceMediaId: row.id }
    }]
  })
}

/** Explicitly snapshot a selected group of canvas nodes into one independent, versioned library asset. */
export function captureProjectNodes(input: CaptureProjectNodesInput): LibraryResourceDetail {
  if (!input?.projectId || !Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > 100) {
    throw new Error('请至少选择一个节点，最多可保存 100 个节点')
  }
  if (!getDb().prepare('SELECT id FROM projects WHERE id = ? AND deleted = 0').get(input.projectId)) {
    throw new Error('当前项目不存在或已删除')
  }
  const title = cleanText(input.title, 180)
  if (!title) throw new Error('请填写资源名称')
  const seen = new Set<string>()
  let totalMediaBytes = 0
  const components: LibraryComponentInput[] = input.nodes.map((node, index) => {
    if (!node || typeof node.nodeId !== 'string' || !node.nodeId || seen.has(node.nodeId)) {
      throw new Error('所选节点包含无效或重复的节点标识')
    }
    seen.add(node.nodeId)
    const role = cleanText(node.title, 80) || `内容-${String(index + 1).padStart(2, '0')}`
    const metadata = {
      sourceProjectId: input.projectId,
      sourceNodeId: node.nodeId,
      sourceNodeType: node.nodeType,
      ...(input.category && node.slotId ? { librarySlotId: node.slotId } : {})
    }
    if (node.nodeType === 'text') {
      const text = typeof node.text === 'string' ? node.text : ''
      if (text.length > MAX_TEXT_CHARS) throw new Error(`节点「${role}」文本超过 2,000,000 字符限制`)
      if (!text.trim()) throw new Error(`节点「${role}」没有可保存的文本内容`)
      return { role, valueType: 'text', text, metadata }
    }
    if ((node.nodeType !== 'image' && node.nodeType !== 'audio' && node.nodeType !== 'video' && node.nodeType !== 'video-asset') || !node.mediaId) {
      throw new Error(`节点「${role}」暂不支持保存为资源`)
    }
    const expectedKind: 'image' | 'audio' | 'video' = node.nodeType === 'video-asset' ? 'video' : node.nodeType
    const prefix = `projects/${input.projectId}/media/`
    const row = getDb().prepare(
      `SELECT m.id, m.kind, m.mime, m.path, m.size_bytes, m.name FROM media m
       WHERE m.id = ? AND m.path LIKE ?`
    ).get(node.mediaId, `${prefix}%`) as
      | { id: string; kind: string; mime: string; path: string; size_bytes: number; name: string | null }
      | undefined
    if (!row || row.kind !== expectedKind || !row.path.replace(/\\/g, '/').startsWith(prefix)) {
      throw new Error(`节点「${role}」的媒体文件不存在或类型不匹配`)
    }
    const relativeName = row.path.replace(/\\/g, '/').slice(prefix.length)
    if (!relativeName || relativeName.includes('/') || relativeName.includes('..')) throw new Error('项目素材路径无效')
    if (row.size_bytes <= 0 || row.size_bytes > MAX_COMPONENT_BYTES) throw new Error(`节点「${role}」的文件超过 128 MB 限制`)
    totalMediaBytes += row.size_bytes
    if (totalMediaBytes > MAX_LIBRARY_PACKAGE_BYTES) throw new Error('所选节点的文件总量超过 512 MB 限制')
    const absolutePath = getMediaAbsPath(row.path)
    if (!absolutePath || !existsSync(absolutePath)) throw new Error(`节点「${role}」的媒体文件缺失`)
    const bytes = readFileSync(absolutePath)
    if (bytes.byteLength !== row.size_bytes) throw new Error(`节点「${role}」的文件大小校验失败`)
    const filename = basename(absolutePath)
    const mime = row.mime || cleanText(node.mediaMime, 160) || 'application/octet-stream'
    return {
      role,
      valueType: expectedKind,
      data: new Uint8Array(bytes),
      mime,
      fileName: filename,
      metadata: { ...metadata, sourceMediaId: row.id }
    }
  })
  const preset: LibraryPreset = components.every((component) => component.valueType === 'image') ? 'image' : 'custom'
  if (input.resourceId) {
    const resource = getResourceDetail(input.resourceId)
    if (!resource) throw new Error('要更新的资源不存在')
    if (input.baseRevisionId !== resource.latestRevisionId) throw new Error('资源已有新版本，请重新选择后再保存')
    return publishRevision({
      resourceId: resource.id,
      baseRevisionId: resource.latestRevisionId,
      sourceRevisionId: resource.latestRevisionId,
      title,
      formPreset: preset,
      category: input.category,
      tags: resource.tags,
      collectionIds: resource.collectionIds,
      components,
      changeNote: cleanText(input.changeNote, 1000) || '从画布保存新版本'
    })
  }
  return createResource({ title, formPreset: preset, category: input.category, folderId: input.folderId, components })
}

export function publishRevision(input: PublishLibraryRevisionInput): LibraryResourceDetail {
  const resource = getDb().prepare(
    'SELECT latest_revision_id FROM library_resources WHERE id = ? AND archived_at IS NULL'
  ).get(input.resourceId) as { latest_revision_id: string } | undefined
  if (!resource) throw new Error('资源不存在或已归档')
  if (resource.latest_revision_id !== input.baseRevisionId) {
    throw new Error('资源已有新版本，请刷新后再保存，避免覆盖其他修改')
  }
  const sourceRevisionId = input.sourceRevisionId ?? input.baseRevisionId
  const sourceRevision = getDb().prepare(
    'SELECT id FROM library_revisions WHERE id = ? AND resource_id = ?'
  ).get(sourceRevisionId, input.resourceId)
  if (!sourceRevision) throw new Error('派生来源版本不属于当前资源')
  if (!VALID_PRESETS.has(input.formPreset)) throw new Error('资源类型无效')
  const title = cleanText(input.title, 180)
  if (!title) throw new Error('资源名称不能为空')
  validatePresetContents(input.formPreset, input.components)
  const latest = getDb().prepare(
    'SELECT MAX(revision_number) AS version FROM library_revisions WHERE resource_id = ?'
  ).get(input.resourceId) as { version: number | null }
  const revisionNumber = (latest.version ?? 0) + 1
  const revisionId = nanoid(12)
  const now = Date.now()
  const database = getDb()
  database.transaction(() => {
    database.prepare(
      `INSERT INTO library_revisions
        (id, resource_id, revision_number, base_revision_id, title, description, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      revisionId,
      input.resourceId,
      revisionNumber,
      sourceRevisionId,
      title,
      cleanText(input.description, 20_000),
      cleanText(input.changeNote, 1000) || `更新到 v${revisionNumber}`,
      now
    )
    pinCategory(revisionId, input.category, input.components)
    insertComponents(revisionId, input.components, input.baseRevisionId)
    database.prepare(
      `UPDATE library_resources SET form_preset = ?, title = ?, description = ?,
        latest_revision_id = ?, updated_at = ? WHERE id = ? AND latest_revision_id = ?`
    ).run(input.formPreset, title, cleanText(input.description, 20_000), revisionId, now, input.resourceId, input.baseRevisionId)
    database.prepare('DELETE FROM library_tags WHERE resource_id = ?').run(input.resourceId)
    insertTags(input.resourceId, input.tags)
    setCollectionsInternal(input.resourceId, input.collectionIds ?? [])
  })()
  const result = getResourceDetail(input.resourceId)
  if (!result) throw new Error('新版本已保存但无法读取')
  return result
}

export function archiveResource(id: string, archived: boolean): boolean {
  const result = getDb().prepare(
    'UPDATE library_resources SET archived_at = ?, updated_at = ? WHERE id = ?'
  ).run(archived ? Date.now() : null, Date.now(), id)
  return result.changes > 0
}

export function listCollections(): LibraryCollection[] {
  return (getDb().prepare(
    `SELECT c.id, c.name, c.description, c.created_at, c.updated_at, COUNT(i.resource_id) AS resource_count
     FROM library_collections c LEFT JOIN library_collection_items i ON i.collection_id = c.id
     GROUP BY c.id ORDER BY c.name COLLATE NOCASE ASC`
  ).all() as Array<{
    id: string; name: string; description: string; created_at: number; updated_at: number; resource_count: number
  }>).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    resourceCount: row.resource_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

function setResourceFolderInternal(resourceId: string, folderId: string | null): void {
  const database = getDb()
  if (folderId) {
    if (!database.prepare('SELECT id FROM library_folders WHERE id = ?').get(folderId)) throw new Error('目标文件夹不存在')
  }
  database.prepare('DELETE FROM library_resource_folders WHERE resource_id = ?').run(resourceId)
  if (folderId) database.prepare(
    'INSERT INTO library_resource_folders (folder_id, resource_id, added_at) VALUES (?, ?, ?)'
  ).run(folderId, resourceId, Date.now())
}

export function listFolders(): LibraryFolder[] {
  return (getDb().prepare(
    `SELECT f.id, f.name, f.parent_id, f.created_at, f.updated_at,
       COUNT(DISTINCT rf.resource_id) AS resource_count
     FROM library_folders f LEFT JOIN library_resource_folders rf ON rf.folder_id = f.id
     GROUP BY f.id ORDER BY f.parent_id, f.name COLLATE NOCASE ASC`
  ).all() as Array<{ id: string; name: string; parent_id: string | null; created_at: number; updated_at: number; resource_count: number }>).map((row) => ({
    id: row.id, name: row.name, parentId: row.parent_id, resourceCount: row.resource_count,
    createdAt: row.created_at, updatedAt: row.updated_at
  }))
}

export function createFolder(input: CreateLibraryFolderInput): LibraryFolder {
  const name = cleanText(input?.name, 100)
  if (!name) throw new Error('文件夹名称不能为空')
  const parentId = input.parentId || null
  if (parentId && !getDb().prepare('SELECT id FROM library_folders WHERE id = ?').get(parentId)) throw new Error('上级文件夹不存在')
  const collision = getDb().prepare(
    'SELECT id FROM library_folders WHERE name = ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)'
  ).get(name, parentId, parentId)
  if (collision) throw new Error('同一文件夹下不能有重名文件夹')
  const id = nanoid(12)
  const now = Date.now()
  getDb().prepare('INSERT INTO library_folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, parentId, now, now)
  return { id, name, parentId, resourceCount: 0, createdAt: now, updatedAt: now }
}

export function renameFolder(input: RenameLibraryFolderInput): LibraryFolder {
  const folderId = cleanText(input?.folderId, 100)
  const name = cleanText(input?.name, 100)
  if (!folderId) throw new Error('文件夹 ID 不完整')
  if (!name) throw new Error('文件夹名称不能为空')
  const database = getDb()
  const folder = database.prepare(
    'SELECT parent_id, created_at FROM library_folders WHERE id = ?'
  ).get(folderId) as { parent_id: string | null; created_at: number } | undefined
  if (!folder) throw new Error('文件夹不存在')
  const collision = database.prepare(
    'SELECT id FROM library_folders WHERE name = ? AND id <> ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)'
  ).get(name, folderId, folder.parent_id, folder.parent_id)
  if (collision) throw new Error('同一文件夹下不能有重名文件夹')
  const updatedAt = Date.now()
  database.prepare('UPDATE library_folders SET name = ?, updated_at = ? WHERE id = ?')
    .run(name, updatedAt, folderId)
  const count = database.prepare(
    'SELECT COUNT(DISTINCT resource_id) AS count FROM library_resource_folders WHERE folder_id = ?'
  ).get(folderId) as { count: number }
  return {
    id: folderId,
    name,
    parentId: folder.parent_id,
    resourceCount: count.count,
    createdAt: folder.created_at,
    updatedAt
  }
}

export function deleteFolder(folderId: string): boolean {
  const folder = getDb().prepare('SELECT parent_id FROM library_folders WHERE id = ?').get(folderId) as { parent_id: string | null } | undefined
  if (!folder) return false
  const database = getDb()
  database.transaction(() => {
    const moveToParent = database.prepare(
      'INSERT OR IGNORE INTO library_resource_folders (folder_id, resource_id, added_at) SELECT ?, resource_id, added_at FROM library_resource_folders WHERE folder_id = ?'
    )
    if (folder.parent_id) moveToParent.run(folder.parent_id, folderId)
    database.prepare('DELETE FROM library_resource_folders WHERE folder_id = ?').run(folderId)
    database.prepare('UPDATE library_folders SET parent_id = ?, updated_at = ? WHERE parent_id = ?').run(folder.parent_id, Date.now(), folderId)
    database.prepare('DELETE FROM library_folders WHERE id = ?').run(folderId)
  })()
  return true
}

export function setResourceFolder(input: { resourceId: string; folderId?: string | null }): boolean {
  if (!getDb().prepare('SELECT id FROM library_resources WHERE id = ?').get(input.resourceId)) return false
  getDb().transaction(() => setResourceFolderInternal(input.resourceId, input.folderId ?? null))()
  return true
}

export function createCollection(input: CreateLibraryCollectionInput): LibraryCollection {
  const name = cleanText(input?.name, 100)
  if (!name) throw new Error('收藏集名称不能为空')
  const id = nanoid(12)
  const now = Date.now()
  try {
    getDb().prepare(
      'INSERT INTO library_collections (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, cleanText(input.description, 2000), now, now)
  } catch {
    throw new Error('收藏集名称已存在')
  }
  return { id, name, description: cleanText(input.description, 2000), resourceCount: 0, createdAt: now, updatedAt: now }
}

export function setResourceCollections(input: SetLibraryCollectionsInput): boolean {
  const exists = getDb().prepare('SELECT id FROM library_resources WHERE id = ?').get(input.resourceId)
  if (!exists) return false
  getDb().transaction(() => setCollectionsInternal(input.resourceId, input.collectionIds))()
  return true
}

export function createBoard(input: { title: string; description?: string }): LibraryBoard {
  const title = cleanText(input?.title, 120)
  if (!title) throw new Error('展板名称不能为空')
  const id = nanoid(12)
  const now = Date.now()
  const description = cleanText(input.description, 2000)
  getDb().prepare(
    'INSERT INTO library_boards (id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title, description, now, now)
  return { id, title, description, createdAt: now, updatedAt: now }
}

export function listBoards(): LibraryBoard[] {
  return (getDb().prepare(
    'SELECT id, title, description, created_at, updated_at FROM library_boards ORDER BY updated_at DESC'
  ).all() as Array<{ id: string; title: string; description: string; created_at: number; updated_at: number }>).map((row) => ({
    id: row.id, title: row.title, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at
  }))
}

export function getBoardItems(boardId: string): LibraryBoardItem[] {
  return (getDb().prepare(
    `SELECT id, resource_id, revision_id, x, y, width, height, note, sort_index
     FROM library_board_items WHERE board_id = ? ORDER BY sort_index ASC`
  ).all(boardId) as Array<{
    id: string; resource_id: string; revision_id: string; x: number; y: number;
    width: number; height: number; note: string; sort_index: number
  }>).map((row) => ({
    id: row.id, resourceId: row.resource_id, revisionId: row.revision_id,
    x: row.x, y: row.y, width: row.width, height: row.height, note: row.note, order: row.sort_index
  }))
}

export function saveBoard(input: SaveLibraryBoardInput): boolean {
  if (!Array.isArray(input.items) || input.items.length > 1000) throw new Error('展板条目数量无效')
  const exists = getDb().prepare('SELECT id FROM library_boards WHERE id = ?').get(input.boardId)
  if (!exists) return false
  const database = getDb()
  database.transaction(() => {
    database.prepare('DELETE FROM library_board_items WHERE board_id = ?').run(input.boardId)
    const insert = database.prepare(
      `INSERT INTO library_board_items
        (id, board_id, resource_id, revision_id, x, y, width, height, note, sort_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    input.items.forEach((item, index) => {
      const revision = database.prepare(
        'SELECT id FROM library_revisions WHERE id = ? AND resource_id = ?'
      ).get(item.revisionId, item.resourceId)
      if (!revision) throw new Error('展板引用的资源版本不存在')
      insert.run(
        item.id || nanoid(12), input.boardId, item.resourceId, item.revisionId,
        Number.isFinite(item.x) ? item.x : 0,
        Number.isFinite(item.y) ? item.y : 0,
        Math.max(120, Math.min(1200, Number.isFinite(item.width) ? item.width : 260)),
        Math.max(100, Math.min(1200, Number.isFinite(item.height) ? item.height : 280)),
        cleanText(item.note, 2000), index
      )
    })
    database.prepare('UPDATE library_boards SET updated_at = ? WHERE id = ?').run(Date.now(), input.boardId)
  })()
  return true
}


export function exportLibrarySnapshot(resourceIds?: string[]): {
  resources: LibraryResourceDetail[]
  blobs: Array<{ path: string; data: Uint8Array }>
} {
  const ids = resourceIds?.length
    ? resourceIds
    : (getDb().prepare('SELECT id FROM library_resources WHERE archived_at IS NULL').all() as Array<{ id: string }>).map((row) => row.id)
  const resources: LibraryResourceDetail[] = []
  const blobPaths = new Set<string>()
  for (const id of ids) {
    const detail = getResourceDetail(id)
    if (!detail) continue
    resources.push(detail)
    for (const component of detail.components) if (component.blobPath) blobPaths.add(component.blobPath)
  }
  const blobs = Array.from(blobPaths).map((path) => ({
    path,
    data: new Uint8Array(readFileSync(join(getDataDir(), path)))
  }))
  return { resources, blobs }
}

const LIBRARY_PACKAGE_FORMAT = 'canvas-studio-resource-library'
const LIBRARY_PACKAGE_VERSION = 2

export function exportResourcePackage(destination: string, requestedIds?: string[]): string {
  const database = getDb()
  const hasResourceFilter = Boolean(requestedIds?.length)
  const resourceIds = requestedIds?.length
    ? [...new Set(requestedIds)]
    : (database.prepare('SELECT id FROM library_resources WHERE archived_at IS NULL ORDER BY updated_at DESC').all() as Array<{ id: string }>).map((row) => row.id)
  const zip = new AdmZip()
  const blobEntries = new Map<string, Buffer>()
  let totalBlobBytes = 0
  const resources: Array<Record<string, unknown>> = []
  const exportedCategoryIds = new Set<string>()
  for (const resourceId of resourceIds) {
    const resource = database.prepare(
      'SELECT id, form_preset, title, description, latest_revision_id, archived_at FROM library_resources WHERE id = ?'
    ).get(resourceId) as
      | { id: string; form_preset: LibraryPreset; title: string; description: string; latest_revision_id: string; archived_at: number | null }
      | undefined
    if (!resource) continue
    const tags = resourceTags(resourceId)
    const collectionRows = database.prepare(
      `SELECT c.name, c.description FROM library_collection_items i
       JOIN library_collections c ON c.id = i.collection_id WHERE i.resource_id = ?`
    ).all(resourceId) as Array<{ name: string; description: string }>
    const folders = resourceFolderPaths(resourceId)
    const revisions = database.prepare(
      `SELECT id, revision_number, base_revision_id, title, description, change_note, created_at
       FROM library_revisions WHERE resource_id = ? ORDER BY revision_number ASC`
    ).all(resourceId) as Array<{
      id: string; revision_number: number; base_revision_id: string | null; title: string;
      description: string; change_note: string | null; created_at: number
    }>
    const packagedRevisions = revisions.map((revision) => {
      const category = revisionCategory(revision.id)
      if (category) exportedCategoryIds.add(category.id)
      const components = database.prepare(
        `SELECT c.id, c.role, c.value_type, c.text_content, c.metadata_json, c.sort_index,
          b.sha256, b.path AS blob_path, b.mime AS blob_mime, b.file_name, b.size_bytes
         FROM library_components c LEFT JOIN library_blobs b ON b.id = c.blob_id
         WHERE c.revision_id = ? ORDER BY c.sort_index ASC`
      ).all(revision.id) as Array<{
        id: string; role: string; value_type: string; text_content: string | null;
        metadata_json: string; sort_index: number; sha256: string | null; blob_path: string | null;
        blob_mime: string | null; file_name: string | null; size_bytes: number | null
      }>
      return {
        id: revision.id,
        category,
        revisionNumber: revision.revision_number,
        baseRevisionId: revision.base_revision_id,
        title: revision.title,
        description: revision.description,
        changeNote: revision.change_note,
        createdAt: revision.created_at,
        components: components.map((component) => {
          const blobKey = component.sha256 ? `blobs/${component.sha256}` : undefined
          if (blobKey && component.blob_path) {
            const absolute = join(getDataDir(), component.blob_path)
            if (!existsSync(absolute)) throw new Error(`资源文件缺失：${component.file_name ?? component.id}`)
            const bytes = readFileSync(absolute)
            if (bytes.byteLength !== component.size_bytes) throw new Error(`资源文件校验失败：${component.file_name ?? component.id}`)
            if (!blobEntries.has(blobKey)) {
              totalBlobBytes += bytes.byteLength
              if (totalBlobBytes > MAX_LIBRARY_PACKAGE_BYTES) throw new Error('资源包文件总量超过 512 MB 限制')
              blobEntries.set(blobKey, bytes)
            }
          }
          return {
            id: component.id,
            role: component.role,
            valueType: component.value_type,
            text: component.text_content,
            metadata: parseJson<Record<string, unknown>>(component.metadata_json, {}),
            order: component.sort_index,
            blobKey,
            mime: component.blob_mime,
            fileName: component.file_name,
            sizeBytes: component.size_bytes
          }
        })
      }
    })
    resources.push({
      id: resource.id,
      formPreset: resource.form_preset,
      title: resource.title,
      description: resource.description,
      latestRevisionId: resource.latest_revision_id,
      archived: Boolean(resource.archived_at),
      tags,
      collections: collectionRows,
      folders,
      revisions: packagedRevisions
    })
  }
  const exportedResourceIds = new Set(resources.map((resource) => String(resource.id)))
  const boards = (database.prepare(
    'SELECT id, title, description FROM library_boards ORDER BY updated_at DESC'
  ).all() as Array<{ id: string; title: string; description: string }>).flatMap((board) => {
    const items = (database.prepare(
      `SELECT resource_id AS resourceId, revision_id AS revisionId, x, y, width, height, note, sort_index AS orderIndex
       FROM library_board_items WHERE board_id = ? ORDER BY sort_index ASC`
    ).all(board.id) as Array<{
      resourceId: string; revisionId: string; x: number; y: number; width: number;
      height: number; note: string; orderIndex: number
    }>).filter((item) => exportedResourceIds.has(item.resourceId)).map((item) => ({
      resourceId: item.resourceId,
      revisionId: item.revisionId,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      note: item.note,
      order: item.orderIndex
    }))
    return hasResourceFilter && items.length === 0 ? [] : [{ title: board.title, description: board.description, items }]
  })
  const manifest = {
    format: LIBRARY_PACKAGE_FORMAT,
    version: LIBRARY_PACKAGE_VERSION,
    exportedAt: Date.now(),
    resources,
    folders: hasResourceFilter
      ? [...new Map(resources.flatMap((resource) => (resource.folders as string[][]).map((path) => [JSON.stringify(path), path] as const))).values()]
      : allFolderPaths(),
    categories: exportCategoryVersions().filter((category) => !hasResourceFilter || exportedCategoryIds.has(category.id)),
    boards
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  if (manifestBytes.byteLength > 50 * 1024 * 1024) throw new Error('资源包清单超过 50 MB 限制')
  if (totalBlobBytes + manifestBytes.byteLength > MAX_LIBRARY_PACKAGE_BYTES) throw new Error('资源包总量超过 512 MB 限制')
  zip.addFile('manifest.json', manifestBytes)
  for (const [path, data] of blobEntries) zip.addFile(path, data)
  zip.writeZip(destination)
  return destination
}

interface PackageComponent {
  id: string
  role: string
  valueType: LibraryComponentInput['valueType']
  text: string | null
  metadata: Record<string, unknown>
  order: number
  blobKey?: string
  mime?: string | null
  fileName?: string | null
  sizeBytes?: number | null
}

interface PackageRevision {
  category?: unknown
  id: string
  revisionNumber: number
  baseRevisionId?: string | null
  title: string
  description: string
  changeNote?: string | null
  createdAt: number
  components: PackageComponent[]
}

interface PackageResource {
  id: string
  formPreset: LibraryPreset
  title: string
  description: string
  latestRevisionId: string
  archived: boolean
  tags: string[]
  collections: Array<{ name: string; description: string }>
  folders?: string[][]
  revisions: PackageRevision[]
}

interface PackageBoard {
  title: string
  description: string
  items: Array<{
    resourceId: string
    revisionId: string
    x: number
    y: number
    width: number
    height: number
    note: string
    order: number
  }>
}

function isPackageResource(value: unknown): value is PackageResource {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<PackageResource>
  return typeof raw.id === 'string' && VALID_PRESETS.has(raw.formPreset as LibraryPreset) &&
    typeof raw.title === 'string' && typeof raw.latestRevisionId === 'string' &&
    Array.isArray(raw.revisions) && Array.isArray(raw.tags) && Array.isArray(raw.collections) &&
    (raw.folders === undefined || (Array.isArray(raw.folders) && raw.folders.length <= 1000 && raw.folders.every((path) =>
      Array.isArray(path) && path.length > 0 && path.length <= 256 && path.every((name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 100))))
}

function isPackageBoard(value: unknown): value is PackageBoard {
  if (!value || typeof value !== 'object') return false
  const board = value as Partial<PackageBoard>
  return typeof board.title === 'string' && typeof board.description === 'string' &&
    Array.isArray(board.items) && board.items.length <= 1000 && board.items.every((item) =>
      Boolean(item) && typeof item.resourceId === 'string' && typeof item.revisionId === 'string' &&
      Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.width) &&
      Number.isFinite(item.height) && typeof item.note === 'string' && Number.isFinite(item.order)
    )
}

export function importResourcePackage(filePath: string): number {
  if (!existsSync(filePath)) throw new Error('资源包不存在')
  const packageSize = statSync(filePath)
  if (!packageSize.isFile() || packageSize.size <= 0 || packageSize.size > MAX_LIBRARY_PACKAGE_BYTES) {
    throw new Error('资源包为空或超过 512 MB 限制')
  }
  const categoryIdMap = new Map<string, string>()
  const packageHash = hashFile(filePath)
  const duplicate = getDb().prepare('SELECT resource_count FROM library_imports WHERE package_sha256 = ?').get(packageHash) as
    | { resource_count: number }
    | undefined
  if (duplicate) throw new Error(`这个资源包已导入过（${duplicate.resource_count} 份资源）`)
  const zip = new AdmZip(filePath)
  const entries = zip.getEntries()
  if (entries.length > 50_000) throw new Error('资源包条目过多，已拒绝导入')
  const uncompressed = entries.reduce((sum, entry) => sum + (entry.header.size ?? 0), 0)
  if (uncompressed > MAX_LIBRARY_PACKAGE_BYTES) throw new Error('资源包解压后超过 512 MB 限制')
  const manifestEntry = zip.getEntry('manifest.json')
  if (!manifestEntry || manifestEntry.header.size > 50 * 1024 * 1024) throw new Error('资源包缺少有效清单')
  let manifest: unknown
  try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as unknown } catch {
    throw new Error('资源包清单不是有效 JSON')
  }
  if (!manifest || typeof manifest !== 'object') throw new Error('资源包清单无效')
  const raw = manifest as { format?: unknown; version?: unknown; resources?: unknown; folders?: unknown; boards?: unknown; categories?: unknown }
  if (raw.format !== LIBRARY_PACKAGE_FORMAT || (raw.version !== 1 && raw.version !== LIBRARY_PACKAGE_VERSION) || !Array.isArray(raw.resources)) {
    throw new Error('资源包格式或版本不受支持')
  }
  if (raw.resources.length > 10_000 || !raw.resources.every(isPackageResource)) throw new Error('资源包包含无效资源')
  if (raw.folders !== undefined && (!Array.isArray(raw.folders) || raw.folders.length > 10_000 || raw.folders.some((path) =>
    !Array.isArray(path) || path.length === 0 || path.length > 256 || path.some((name) => typeof name !== 'string' || !name.trim() || name.length > 100)))) {
    throw new Error('资源包文件夹结构无效')
  }
  const packagedResources = raw.resources as PackageResource[]
  if (new Set(packagedResources.map((resource) => resource.id)).size !== packagedResources.length) {
    throw new Error('资源包包含重复资源 ID')
  }
  const packagedRevisionIds = packagedResources.flatMap((resource) => resource.revisions.map((revision) => revision.id))
  if (new Set(packagedRevisionIds).size !== packagedRevisionIds.length) throw new Error('资源包包含重复版本 ID')
  const packagedRevisionOwners = new Map(
    packagedResources.flatMap((resource) => resource.revisions.map((revision) => [revision.id, resource.id] as const))
  )
  if (raw.categories !== undefined && (!Array.isArray(raw.categories) || raw.categories.length > 10000)) throw new Error('资源包分类列表无效')
  if (raw.boards !== undefined && (!Array.isArray(raw.boards) || raw.boards.length > 1000 || !raw.boards.every(isPackageBoard))) {
    throw new Error('资源包展板数据无效')
  }
  const zipEntries = new Map<string, (typeof entries)[number]>()
  for (const entry of entries) zipEntries.set(entry.entryName, entry)
  const database = getDb()
  const collectionCache = new Map<string, string>()
  const folderCache = new Map<string, string>()
  const resourceCount = raw.resources.length
  const newResourceIds: string[] = []
  const resourceIdMap = new Map<string, string>()
  const revisionIdMap = new Map<string, string>()
  const blobCache = new Map<string, string>()

  const ensureFolderPath = (rawPath: string[]): string | null => {
    const path = rawPath.map((segment) => cleanText(segment, 100)).filter(Boolean)
    if (path.length === 0 || path.length !== rawPath.length || path.length > 256) return null
    let parentId: string | null = null
    const now = Date.now()
    for (const name of path) {
      const key = JSON.stringify([parentId, name])
      let folderId = folderCache.get(key)
      if (!folderId) {
        const existing = database.prepare(
          'SELECT id FROM library_folders WHERE name = ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)'
        ).get(name, parentId, parentId) as { id: string } | undefined
        folderId = existing?.id ?? nanoid(12)
        if (!existing) database.prepare(
          'INSERT INTO library_folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).run(folderId, name, parentId, now, now)
        folderCache.set(key, folderId)
      }
      parentId = folderId
    }
    return parentId
  }

  database.transaction(() => {
    for (const category of (raw.categories ?? []) as unknown[]) importCategoryDefinition(category, categoryIdMap)
    for (const path of (raw.folders ?? []) as string[][]) ensureFolderPath(path)
    for (const source of packagedResources) {
      const revisions = [...source.revisions].sort((a, b) => a.revisionNumber - b.revisionNumber)
      if (revisions.length === 0 || revisions.some((revision) => !Array.isArray(revision.components) || revision.components.length > 100)) {
        throw new Error(`资源「${source.title}」没有有效版本`)
      }
      if (!revisions.some((revision) => revision.id === source.latestRevisionId)) throw new Error(`资源「${source.title}」的最新版本引用无效`)
      for (const revision of revisions) {
        validatePresetContents(revision.id === source.latestRevisionId ? source.formPreset : 'custom', revision.components.map((component) => ({
          role: component.role,
          valueType: component.valueType,
          ...(typeof component.text === 'string' ? { text: component.text } : {}),
          ...(component.blobKey ? { data: new Uint8Array([1]) } : {}),
          metadata: component.metadata && typeof component.metadata === 'object' && !Array.isArray(component.metadata)
            ? component.metadata
            : {}
        })))
      }
      const idMap = new Map(revisions.map((revision) => [revision.id, nanoid(12)]))
      const resourceId = nanoid(12)
      resourceIdMap.set(source.id, resourceId)
      for (const [oldRevisionId, newRevisionId] of idMap) revisionIdMap.set(oldRevisionId, newRevisionId)
      const now = Date.now()
      newResourceIds.push(resourceId)
      for (const collection of source.collections) {
        const name = cleanText(collection?.name, 100)
        if (!name) continue
        let collectionId = collectionCache.get(name)
        if (!collectionId) {
          const existing = database.prepare('SELECT id FROM library_collections WHERE name = ?').get(name) as { id: string } | undefined
          collectionId = existing?.id ?? nanoid(12)
          if (!existing) database.prepare(
            'INSERT INTO library_collections (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
          ).run(collectionId, name, cleanText(collection.description, 2000), now, now)
          collectionCache.set(name, collectionId)
        }
      }
      const latestRevisionId = idMap.get(source.latestRevisionId)!
      database.prepare(
        `INSERT INTO library_resources
          (id, form_preset, title, description, latest_revision_id, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(resourceId, source.formPreset, cleanText(source.title, 180) || '导入资源', cleanText(source.description, 20_000), latestRevisionId, source.archived ? now : null, now, now)
      for (const revision of revisions) {
        const revisionId = idMap.get(revision.id)!
        database.prepare(
          `INSERT INTO library_revisions
            (id, resource_id, revision_number, base_revision_id, title, description, change_note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          revisionId, resourceId, Math.max(1, Math.floor(revision.revisionNumber)),
          revision.baseRevisionId ? idMap.get(revision.baseRevisionId) ?? null : null,
          cleanText(revision.title, 180) || cleanText(source.title, 180) || '导入资源',
          cleanText(revision.description, 20_000), cleanText(revision.changeNote, 1000) || null,
          Number.isFinite(revision.createdAt) ? revision.createdAt : now
        )
        importRevisionCategory(revisionId, revision.category, categoryIdMap)
        for (const component of revision.components) {
          if (!component || typeof component.role !== 'string' || !VALID_VALUE_TYPES.has(component.valueType)) throw new Error('资源包中的组件无效')
          const textType = ['text', 'markdown', 'json', 'recipe'].includes(component.valueType)
          if (!cleanText(component.role, 80) || !component.metadata || typeof component.metadata !== 'object' || Array.isArray(component.metadata)) {
            throw new Error('资源包中的组件内容无效')
          }
          if (textType && (typeof component.text !== 'string' || component.blobKey)) {
            throw new Error(`「${component.role}」的文本内容无效`)
          }
          if (!textType && (!component.blobKey || component.text !== null)) {
            throw new Error(`「${component.role}」的文件内容无效`)
          }
          let blobId: string | null = null
          if (component.blobKey) {
            if (!/^blobs\/[a-f0-9]{64}$/.test(component.blobKey)) throw new Error('资源包文件引用非法')
            const entry = zipEntries.get(component.blobKey)
            if (!entry || entry.header.size > MAX_COMPONENT_BYTES) throw new Error(`资源包缺少文件：${component.fileName ?? component.role}`)
            if (!blobCache.has(component.blobKey)) {
              const bytes = entry.getData()
              if (component.sizeBytes !== null && component.sizeBytes !== undefined && bytes.byteLength !== component.sizeBytes) {
                throw new Error(`资源包文件大小校验失败：${component.fileName ?? component.role}`)
              }
              const actualHash = createHash('sha256').update(bytes).digest('hex')
              if (actualHash !== component.blobKey.slice('blobs/'.length)) {
                throw new Error(`资源包文件哈希校验失败：${component.fileName ?? component.role}`)
              }
              const blob = storeBlob(new Uint8Array(bytes), component.mime, component.fileName)
              blobCache.set(component.blobKey, blob.id)
            }
            blobId = blobCache.get(component.blobKey) ?? null
          }
          database.prepare(
            `INSERT INTO library_components
              (id, revision_id, role, value_type, text_content, blob_id, metadata_json, sort_index, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            nanoid(12), revisionId, cleanText(component.role, 80), component.valueType,
            typeof component.text === 'string' ? component.text.slice(0, MAX_TEXT_CHARS) : null,
            blobId, JSON.stringify(component.metadata ?? {}), Math.max(0, Math.floor(component.order ?? 0)), now
          )
        }
      }
      for (const revision of revisions) {
        const id = idMap.get(revision.id)!
        const category = revisionCategory(id)
        if (category) validateCategoryContent(category, readComponents(id))
      }
      insertTags(resourceId, source.tags)
      const collectionIds = source.collections.flatMap((collection) => {
        const name = cleanText(collection?.name, 100)
        const id = collectionCache.get(name)
        return id ? [id] : []
      })
      setCollectionsInternal(resourceId, collectionIds)
      const importedFolderPaths = source.folders?.length
        ? source.folders
        : source.collections.map((collection) => [collection.name])
      for (const path of importedFolderPaths) {
        const folderId = ensureFolderPath(path)
        if (folderId) database.prepare(
          'INSERT OR IGNORE INTO library_resource_folders (folder_id, resource_id, added_at) VALUES (?, ?, ?)'
        ).run(folderId, resourceId, now)
      }
    }
    for (const board of (raw.boards ?? []) as PackageBoard[]) {
      const boardId = nanoid(12)
      const now = Date.now()
      database.prepare(
        'INSERT INTO library_boards (id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(boardId, cleanText(board.title, 180) || '导入展板', cleanText(board.description, 2000), now, now)
      const insertBoardItem = database.prepare(
        `INSERT INTO library_board_items
          (id, board_id, resource_id, revision_id, x, y, width, height, note, sort_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      board.items.forEach((item, index) => {
        const resourceId = resourceIdMap.get(item.resourceId)
        const revisionId = revisionIdMap.get(item.revisionId)
        if (!resourceId || !revisionId || packagedRevisionOwners.get(item.revisionId) !== item.resourceId) {
          throw new Error('资源包展板引用了未导出的资源版本')
        }
        insertBoardItem.run(
          nanoid(12), boardId, resourceId, revisionId,
          Number.isFinite(item.x) ? item.x : 0,
          Number.isFinite(item.y) ? item.y : 0,
          Math.max(120, Math.min(1200, item.width)),
          Math.max(100, Math.min(1200, item.height)),
          cleanText(item.note, 2000), Number.isFinite(item.order) ? Math.max(0, Math.floor(item.order)) : index
        )
      })
    }
    database.prepare(
      'INSERT INTO library_imports (package_sha256, imported_at, resource_count) VALUES (?, ?, ?)'
    ).run(packageHash, Date.now(), resourceCount)
  })()
  return newResourceIds.length
}
