import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { getDataDir } from '../store/db'
import { FlowAssetError } from '../../shared/agent-flow/assets'

export interface FlowMediaRef<K extends 'image' | 'video' | 'audio' = 'image' | 'video' | 'audio'> {
  kind: K
  mediaId: string
  mediaPath: string
  mime: string
  contentSha256?: string
}
export type FlowImageRef = FlowMediaRef<'image'>

/** Freeze and recheck bytes as well as metadata. Synchronous asset transactions are bounded to 20 MiB. */
export function fixedFlowImage(
  db: Database.Database,
  projectId: string,
  value: FlowImageRef
): FlowImageRef & { contentSha256: string } {
  return fixedFlowMedia(db, projectId, value)
}

/** Conservative fixed input budget; generated video outputs retain their existing size support. */

// Fixed media is content-addressed and immutable by contract, but every read used
// to re-hash up to 20 MiB from disk; agent flows re-read the same assets many
// times per command (prepare/check/commit and each model decision round). The
// stat triple (file id, size, mtime) invalidates every replace: materialization
// always writes a new file, and an in-place rewrite updates mtime. DB row,
// containment and size validation still re-run on every call — only the byte
// hash of identical bytes is reused.
const contentHashCache = new Map<string, string>()
const CONTENT_HASH_CACHE_MAX = 256

function cachedContentSha256(
  path: string,
  stat: { ino: number; size: number; mtimeMs: number }
): string {
  const key = `${path}|${stat.ino}|${stat.size}|${stat.mtimeMs}`
  const hit = contentHashCache.get(key)
  if (hit !== undefined) return hit
  const bytes = readFileSync(path)
  if (bytes.length !== stat.size) throw new Error()
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (contentHashCache.size >= CONTENT_HASH_CACHE_MAX) {
    const oldest = contentHashCache.keys().next().value
    if (oldest !== undefined) contentHashCache.delete(oldest)
  }
  contentHashCache.set(key, digest)
  return digest
}

export function fixedFlowMedia<K extends 'image' | 'video' | 'audio'>(
  db: Database.Database,
  projectId: string,
  value: FlowMediaRef<K>
): FlowMediaRef<K> & { contentSha256: string } {
  try {
    const media = db
      .prepare('SELECT kind,path,mime,size_bytes FROM media WHERE id=?')
      .get(value.mediaId) as
      { kind: string; path: string; mime: string; size_bytes: number } | undefined
    const root = resolve(getDataDir(), 'projects', projectId, 'media')
    const path = resolve(getDataDir(), value.mediaPath)
    const child = relative(root, path)
    if (
      !media ||
      media.kind !== value.kind ||
      media.path !== value.mediaPath ||
      media.mime !== value.mime ||
      !value.mime.startsWith(`${value.kind}/`) ||
      !child ||
      child.startsWith('..') ||
      isAbsolute(child) ||
      media.size_bytes <= 0 ||
      media.size_bytes > 20 * 1024 * 1024
    )
      throw new Error()
    const realRoot = resolve(realpathSync(getDataDir()), 'projects', projectId, 'media')
    const realChild = relative(realRoot, realpathSync(path))
    if (!realChild || realChild.startsWith('..') || isAbsolute(realChild)) throw new Error()
    const stat = statSync(path)
    if (!stat.isFile() || stat.size !== media.size_bytes) throw new Error()
    const contentSha256 = cachedContentSha256(path, stat)
    if (value.contentSha256 && value.contentSha256 !== contentSha256) throw new Error()
    return {
      kind: value.kind,
      mediaId: value.mediaId,
      mediaPath: value.mediaPath,
      mime: value.mime,
      contentSha256
    }
  } catch {
    throw new FlowAssetError(
      value.kind === 'image'
        ? 'ASSET_IMAGE_CHANGED'
        : value.kind === 'audio'
          ? 'ASSET_AUDIO_CHANGED'
          : 'ASSET_VIDEO_CHANGED',
      `${value.kind}-integrity`
    )
  }
}
