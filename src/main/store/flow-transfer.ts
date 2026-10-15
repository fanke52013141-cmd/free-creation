import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { ProjectFile } from '../../shared/types'
import { remapMediaReferences, type MediaReferenceMap } from '../../shared/media-reference-remap'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'

const portableMediaSchema = z
  .object({
    kind: z.enum(['image', 'video', 'audio']),
    mediaId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.:-]+$/),
    mediaPath: z.string().min(1),
    mime: z.string().min(1).max(128),
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    name: z.string().optional()
  })
  .strict()

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
const rowSchema = z
  .object({
    version_id: id,
    asset_id: id,
    project_id: id,
    node_id: id,
    port_id: id,
    ordinal: z.number().int().positive(),
    graph_version: z.number().int().nonnegative(),
    created_at: z.number().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    value_json: z.string().max(1048576)
  })
  .strict()
type Row = z.infer<typeof rowSchema>
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const credentials = new Set([
  'apikey',
  'apitoken',
  'secret',
  'secretkey',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'password',
  'bearertoken'
])
const graphReferenceKeys = new Set([
  'id',
  'projectId',
  'nodeId',
  'nodeIds',
  'allowedNodeIds',
  'gatedNodeIds',
  'sourceNodeId',
  'targetNodeId',
  'responsibleNodeId',
  'agentNodeId',
  'stateNodeId',
  'shapeId',
  'boundShapeId',
  'fromId',
  'toId',
  'parentId',
  'groupId',
  'assetId',
  'versionId'
])
function remapFlowIdentities<T>(
  value: T,
  ids: ReadonlyMap<string, string>,
  relations: ReadonlyMap<string, string>
): T {
  const visit = (item: unknown, key = ''): unknown => {
    if (typeof item === 'string') {
      if (key === 'relationId') return relations.get(item) ?? item
      if (graphReferenceKeys.has(key) && ids.has(item)) return ids.get(item)
      if (item.trimStart().startsWith('{') || item.trimStart().startsWith('[')) {
        let parsed: unknown
        try {
          parsed = JSON.parse(item)
        } catch {
          return item
        }
        const mapped = visit(parsed)
        return JSON.stringify(mapped) === JSON.stringify(parsed) ? item : JSON.stringify(mapped)
      }
      return item
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, key))
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(
      Object.entries(item).map(([field, child]) => [field, visit(child, field)])
    )
  }
  return visit(value) as T
}

/** Missing media stays missing under a fresh identity; it must never resolve into the source project. */
export function completeTransferMediaMap(
  file: ProjectFile,
  known: MediaReferenceMap,
  projectId: string,
  additional?: unknown
): MediaReferenceMap {
  const ids = new Map(known.ids),
    paths = new Map(known.paths)
  const ensure = (old: string): string => {
    if (!ids.has(old)) ids.set(old, nanoid(14))
    return ids.get(old)!
  }
  const prefix = `projects/${file.meta.id}/media/`
  const visit = (value: unknown, key = '', depth = 0): void => {
    if (depth > 128) throw new Error('FLOW_TRANSFER_DEPTH_INVALID')
    if (typeof value === 'string') {
      if (value.startsWith(prefix)) {
        const name = value.slice(prefix.length),
          match = /^([a-zA-Z0-9_-]+)(\.[a-zA-Z0-9]+)?$/.exec(name)
        if (!match) throw new Error('FLOW_TRANSFER_MEDIA_INVALID')
        if (!paths.has(value))
          paths.set(value, `projects/${projectId}/media/${ensure(match[1])}${match[2] ?? ''}`)
      }
      const normalized = key.replace(/[-_]/g, '').toLowerCase()
      if ((normalized.endsWith('mediaid') || normalized.endsWith('mediaids')) && value)
        ensure(value)
      if (value.trimStart().startsWith('{') || value.trimStart().startsWith('[')) {
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        } catch {
          return
        }
        visit(parsed, '', depth + 1)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, key, depth + 1)
      return
    }
    if (value && typeof value === 'object')
      for (const [field, child] of Object.entries(value)) visit(child, field, depth + 1)
  }
  visit(file)
  visit(additional)
  return { ids, paths }
}

/** Remove known credential fields, including serialized configuration; never copy model catalogs. */
export function stripTransferCredentials<T>(value: T): T {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 128) throw new Error('FLOW_TRANSFER_DEPTH_INVALID')
    if (
      typeof item === 'string' &&
      (item.trimStart().startsWith('{') || item.trimStart().startsWith('['))
    ) {
      try {
        const parsed = JSON.parse(item)
        const clean = visit(parsed, depth + 1)
        return JSON.stringify(clean) === JSON.stringify(parsed) ? item : JSON.stringify(clean)
      } catch (error) {
        if (error instanceof SyntaxError) return item
        throw error
      }
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1))
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !credentials.has(key.replace(/[-_]/g, '').toLowerCase()))
        .map(([key, child]) => [key, visit(child, depth + 1)])
    )
  }
  return visit(value, 0) as T
}

export function exportFlowVersions(db: Database.Database, projectId: string): Row[] {
  const rows = db
    .prepare(
      'SELECT * FROM flow_asset_versions WHERE project_id=? ORDER BY node_id,port_id,ordinal'
    )
    .all(projectId)
  return parseFlowVersions(rows, projectId).map((row) => {
    const value_json = JSON.stringify(stripTransferCredentials(JSON.parse(row.value_json)))
    return { ...row, value_json, digest: digest(value_json) }
  })
}
export function parseFlowVersions(value: unknown, projectId: string): Row[] {
  const rows = z.array(rowSchema).max(10000).parse(value)
  const versions = new Set<string>(),
    sources = new Set<string>()
  for (const row of rows) {
    const key = JSON.stringify([row.node_id, row.port_id, row.ordinal])
    if (
      row.project_id !== projectId ||
      digest(row.value_json) !== row.digest ||
      versions.has(row.version_id) ||
      sources.has(key)
    )
      throw new Error('FLOW_TRANSFER_ASSET_INVALID')
    const parsed = JSON.parse(row.value_json)
    if (parsed?.kind === 'image' || parsed?.kind === 'video' || parsed?.kind === 'audio') {
      const media = portableMediaSchema.parse(parsed)
      const prefix = `projects/${projectId}/media/`
      const filename = media.mediaPath.slice(prefix.length)
      if (
        !media.mediaPath.startsWith(prefix) ||
        !filename ||
        /[\\/]/.test(filename) ||
        filename.includes('..') ||
        !filename.startsWith(media.mediaId + '.') ||
        !media.mime.startsWith(media.kind + '/') ||
        (media.kind !== 'video' && !media.contentSha256)
      )
        throw new Error('FLOW_TRANSFER_MEDIA_INVALID')
    } else if (
      !parsed ||
      !['text', 'markdown', 'json'].includes(parsed.kind) ||
      (parsed.kind === 'json' ? !Object.hasOwn(parsed, 'data') : typeof parsed.text !== 'string')
    )
      throw new Error('FLOW_TRANSFER_VALUE_INVALID')
    versions.add(row.version_id)
    sources.add(key)
  }
  return rows
}

/** Verify the bundle's actual bytes, not only the JSON digest. No media content enters diagnostics. */
export function validateFlowMedia(
  rows: Row[],
  resolve: (
    value: z.infer<typeof portableMediaSchema>
  ) => { bytes: Buffer; kind: string; mime: string } | null
): void {
  for (const row of rows) {
    const raw = JSON.parse(row.value_json)
    if (raw.kind !== 'image' && raw.kind !== 'video' && raw.kind !== 'audio') continue
    const value = portableMediaSchema.parse(raw)
    const media = resolve(value)
    if (
      !media ||
      !media.bytes.length ||
      (value.kind === 'audio' && media.bytes.length > 20 * 1024 * 1024) ||
      media.kind !== value.kind ||
      media.mime !== value.mime ||
      (value.contentSha256 &&
        createHash('sha256').update(media.bytes).digest('hex') !== value.contentSha256)
    )
      throw new Error('FLOW_TRANSFER_MEDIA_INVALID')
  }
}

/** New identities and immutable assets; execution permissions/approval records are never imported. */
export function prepareFlowImport(
  file: ProjectFile,
  rows: Row[],
  projectId: string,
  media: MediaReferenceMap = { ids: new Map(), paths: new Map() }
): { file: ProjectFile; rows: Row[] } {
  const ids = new Map<string, string>([[file.meta.id, projectId]])
  const relations = new Map<string, string>()
  const assign = (old: string, prefix = ''): void => {
    if (!ids.has(old)) ids.set(old, prefix + nanoid())
  }
  for (const node of file.nodes)
    if (typeof node.id === 'string') assign(node.id, node.id.startsWith('shape:') ? 'shape:' : '')
  for (const edge of file.edges)
    if (typeof edge.id === 'string') assign(edge.id, edge.id.startsWith('shape:') ? 'shape:' : '')
  for (const group of file.groups)
    if (typeof group.id === 'string')
      assign(group.id, group.id.startsWith('shape:') ? 'shape:' : '')
  const snapshot = file.tldrawSnapshot as {
    store?: Record<
      string,
      {
        typeName?: string
        type?: string
        props?: Record<string, unknown>
        meta?: Record<string, unknown>
      }
    >
  }
  for (const [key, record] of Object.entries(snapshot?.store ?? {}))
    if (['shape', 'binding'].includes(record.typeName ?? '') || record.type === 'node-card')
      assign(key, key.startsWith('shape:') ? 'shape:' : 'binding:')
  for (const row of rows) {
    assign(row.asset_id, 'asset-')
    assign(row.version_id, 'version-')
    assign(row.node_id, row.node_id.startsWith('shape:') ? 'shape:' : '')
  }
  // Relations have stable local identity independently of their endpoint nodes.
  for (const node of file.nodes) {
    try {
      for (const relation of JSON.parse(String(node.params?.config ?? '{}')).relations ?? [])
        if (typeof relation.relationId === 'string' && !relations.has(relation.relationId))
          relations.set(relation.relationId, 'relation-' + nanoid())
    } catch {
      /* Non-Flow configuration is retained. */
    }
  }
  const clean = stripTransferCredentials(file)
  const byVersion = new Map(rows.map((row) => [row.version_id, row]))
  const checkRefs = (value: unknown): void => {
    if (
      typeof value === 'string' &&
      (value.trimStart().startsWith('{') || value.trimStart().startsWith('['))
    ) {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        return
      }
      checkRefs(parsed)
      return
    }
    if (!value || typeof value !== 'object') return
    const ref = value as Record<string, unknown>
    if (
      ['assetId', 'versionId', 'sourceNodeId', 'sourcePortId'].every(
        (key) => typeof ref[key] === 'string'
      ) &&
      ((): boolean => {
        const row = byVersion.get(String(ref.versionId))
        return (
          !row ||
          row.asset_id !== ref.assetId ||
          row.node_id !== ref.sourceNodeId ||
          row.port_id !== ref.sourcePortId
        )
      })()
    )
      throw new Error('FLOW_TRANSFER_REFERENCE_MISSING')
    for (const child of Object.values(value)) checkRefs(child)
  }
  checkRefs(clean)
  for (const row of rows) checkRefs(stripTransferCredentials(JSON.parse(row.value_json)))
  for (const record of Object.values(snapshot?.store ?? {})) {
    if (record.type !== 'node-card' || typeof record.meta?.flowAssetRef !== 'string') continue
    const ref = JSON.parse(record.meta.flowAssetRef)
    const row = byVersion.get(ref.versionId)
    if (!row) throw new Error('FLOW_TRANSFER_REFERENCE_MISSING')
    const pinned =
      typeof record.meta.pinnedOutput === 'string' ? JSON.parse(record.meta.pinnedOutput) : null
    const expected = remapMediaReferences(JSON.parse(row.value_json), media)
    if (
      pinned?.version !== 1 ||
      Object.keys(pinned.outputs ?? {}).length !== 1 ||
      canonicalFlowJson(Object.values(pinned.outputs)[0]) !== canonicalFlowJson(expected)
    )
      throw new Error('FLOW_TRANSFER_PINNED_INVALID')
  }
  const remapped = remapFlowIdentities(clean, ids, relations)
  for (const node of remapped.nodes) node.exec = { status: 'idle' }
  const store = (remapped.tldrawSnapshot as typeof snapshot)?.store
  if (store) {
    const rewritten: typeof store = {}
    for (const [key, record] of Object.entries(store)) {
      if (record.type === 'node-card') {
        record.meta = { ...record.meta }
        for (const field of ['agentTask', 'nodeRun', 'nodeRunHistory']) delete record.meta[field]
        if (record.props?.nodeType === 'ai-review') delete record.meta.nodeResult
        if (record.props) record.props.exec = 'idle'
      }
      rewritten[ids.get(key) ?? key] = record
    }
    ;(remapped.tldrawSnapshot as typeof snapshot).store = rewritten
  }
  const imported = rows.map((row) => {
    if (!ids.has(row.node_id)) throw new Error('FLOW_TRANSFER_SOURCE_MISSING')
    const value_json = JSON.stringify(
      remapFlowIdentities(
        remapMediaReferences(stripTransferCredentials(JSON.parse(row.value_json)), media),
        ids,
        relations
      )
    )
    return {
      ...row,
      project_id: projectId,
      asset_id: ids.get(row.asset_id)!,
      version_id: ids.get(row.version_id)!,
      node_id: ids.get(row.node_id)!,
      graph_version: 0,
      value_json,
      digest: digest(value_json)
    }
  })
  // A portable fixed reference must have its own version in this bundle, never a foreign DB lookup.
  for (const node of file.nodes) {
    const raw = snapshot?.store?.[node.id]?.meta?.flowAssetRef
    if (typeof raw === 'string') {
      const ref = JSON.parse(raw)
      if (
        !rows.some(
          (row) =>
            row.version_id === ref.versionId &&
            row.asset_id === ref.assetId &&
            row.node_id === ref.sourceNodeId &&
            row.port_id === ref.sourcePortId
        )
      )
        throw new Error('FLOW_TRANSFER_REFERENCE_MISSING')
    }
  }
  return { file: remapped, rows: imported }
}

export function insertFlowVersions(db: Database.Database, rows: Row[]): void {
  const insert = db.prepare(
    'INSERT INTO flow_asset_versions(version_id,asset_id,project_id,node_id,port_id,ordinal,graph_version,created_at,digest,value_json) VALUES (?,?,?,?,?,?,?,?,?,?)'
  )
  for (const row of rows)
    insert.run(
      row.version_id,
      row.asset_id,
      row.project_id,
      row.node_id,
      row.port_id,
      row.ordinal,
      row.graph_version,
      row.created_at,
      row.digest,
      row.value_json
    )
}
