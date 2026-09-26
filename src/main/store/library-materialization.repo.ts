import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { extname, join } from 'path'
import { nanoid } from 'nanoid'
import type { MediaAsset } from '../../shared/types'
import type { LibraryResourceComponent } from '../../shared/library/types'
import { getDataDir, getDb } from './db'
import { deleteMedia, saveBufferAsset } from './media.repo'
import { getResourceDetail } from './library.repo'

export interface MaterializedLibraryResource {
  usageId: string
  componentAssets: Array<{ componentId: string; asset: MediaAsset }>
  assets: MediaAsset[]
  textComponents: LibraryResourceComponent[]
}

export async function materializeResource(input: {
  nodeBindings?: Array<{ componentId: string; nodeId: string }>
  projectId: string
  resourceId: string
  revisionId: string
  componentIds: string[]
}): Promise<MaterializedLibraryResource> {
  if (!Array.isArray(input.componentIds) || input.componentIds.length === 0) {
    throw new Error('至少选择一个资源组件')
  }
  const project = getDb()
    .prepare('SELECT id FROM projects WHERE id = ? AND deleted = 0')
    .get(input.projectId)
  if (!project) throw new Error('目标项目不存在')
  const resource = getDb()
    .prepare('SELECT id FROM library_revisions WHERE id = ? AND resource_id = ?')
    .get(input.revisionId, input.resourceId)
  if (!resource) throw new Error('选择的资源版本不存在')
  const components = (
    getResourceDetail(input.resourceId, input.revisionId)?.components ?? []
  ).filter((component) => input.componentIds.includes(component.id))
  if (components.length !== new Set(input.componentIds).size) throw new Error('部分资源组件不存在')
  const bindings = input.nodeBindings ?? []
  if (
    bindings.length &&
    (bindings.length !== components.length ||
      new Set(bindings.map((binding) => binding.componentId)).size !== components.length ||
      new Set(bindings.map((binding) => binding.nodeId)).size !== bindings.length ||
      bindings.some(
        (binding) =>
          !components.some((component) => component.id === binding.componentId) ||
          typeof binding.nodeId !== 'string' ||
          !binding.nodeId.startsWith('shape:')
      ))
  ) {
    throw new Error('节点来源映射无效')
  }
  const usageId = nanoid(12)
  const componentAssets: Array<{ componentId: string; asset: MediaAsset }> = []
  const assets: MediaAsset[] = []
  const textComponents = components.filter((component) => component.text !== undefined)
  try {
    for (const component of components) {
      if (!component.blobPath) continue
      const absolute = join(getDataDir(), component.blobPath)
      if (!existsSync(absolute))
        throw new Error(`资源文件缺失：${component.fileName ?? component.role}`)
      const buffer = readFileSync(absolute)
      if (
        component.contentHash &&
        createHash('sha256').update(buffer).digest('hex') !== component.contentHash
      )
        throw new Error(`资源文件哈希校验失败：${component.role}`)
      if (buffer.byteLength !== component.sizeBytes)
        throw new Error(`资源文件大小校验失败：${component.fileName ?? component.role}`)
      const ext = extname(component.fileName ?? '') || extensionForMime(component.mime)
      const asset = await saveBufferAsset(
        input.projectId,
        buffer,
        ext,
        component.fileName ?? component.role
      )
      assets.push(asset)
      componentAssets.push({ componentId: component.id, asset })
    }
    const now = Date.now()
    getDb()
      .prepare(
        `INSERT INTO library_usages
        (id, project_id, resource_id, revision_id, component_ids_json,
         project_media_ids_json, materialized_node_ids_json, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        usageId,
        input.projectId,
        input.resourceId,
        input.revisionId,
        JSON.stringify(components.map((component) => component.id)),
        JSON.stringify(assets.map((asset) => asset.id)),
        JSON.stringify(bindings.map((binding) => binding.nodeId)),
        now,
        now
      )
    return { usageId, componentAssets, assets, textComponents }
  } catch (error) {
    // Best-effort compensation: an incomplete materialization must not leave extra project assets.
    for (const asset of assets) await deleteMedia(asset.id).catch(() => false)
    throw error
  }
}

/** Compensation is limited to the fresh materialization identified by project and usage. */
export async function discardMaterialization(input: {
  projectId: string
  usageId: string
}): Promise<boolean> {
  if (!input?.projectId || !input.usageId) throw new Error('缺少资源使用标识')
  const row = getDb()
    .prepare('SELECT project_media_ids_json FROM library_usages WHERE id = ? AND project_id = ?')
    .get(input.usageId, input.projectId) as { project_media_ids_json: string } | undefined
  if (!row) return false
  for (const mediaId of JSON.parse(row.project_media_ids_json) as string[])
    await deleteMedia(mediaId)
  getDb()
    .prepare('DELETE FROM library_usages WHERE id = ? AND project_id = ?')
    .run(input.usageId, input.projectId)
  return true
}

function extensionForMime(mime?: string): string {
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'audio/wav' || mime === 'audio/wave') return '.wav'
  if (mime === 'audio/mpeg') return '.mp3'
  if (mime === 'video/mp4') return '.mp4'
  if (mime === 'video/webm') return '.webm'
  if (mime === 'text/markdown') return '.md'
  if (mime === 'text/plain') return '.txt'
  return '.bin'
}
