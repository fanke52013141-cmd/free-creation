// 媒体仓库：文件落项目媒体目录 + SQLite 索引（见《技术框架与规范》§9）
// 异步复制：大文件导入不阻塞主进程
import { nanoid } from 'nanoid'
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import type { MediaAsset, MediaKind } from '../../shared/types'
import { getDataDir, getDb } from './db'

// 单文件上限 2GB；文本内容内联上限 1MB（超限的文本文件不读内容，仅存文件）
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TEXT_INLINE_BYTES = 1024 * 1024
const TEXT_EXTS = new Set(['.txt', '.md', '.json'])

function detectKind(ext: string, mime: string): MediaKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  switch (ext.toLowerCase()) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.gif':
    case '.bmp':
    case '.svg':
      return 'image'
    case '.mp4':
    case '.webm':
    case '.mov':
    case '.mkv':
    case '.avi':
      return 'video'
    case '.mp3':
    case '.wav':
    case '.ogg':
    case '.m4a':
    case '.flac':
    case '.aac':
      return 'audio'
    default:
      return 'file'
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac'
}

export type ImportOutcome = { ok: true; asset: MediaAsset } | { ok: false; reason: string }

export async function importMedia(projectId: string, srcAbsPath: string): Promise<ImportOutcome> {
  try {
    const st = await stat(srcAbsPath)
    if (!st.isFile()) return { ok: false, reason: '不是有效文件' }
    if (st.size > MAX_MEDIA_BYTES) return { ok: false, reason: '超过 2GB 单文件上限' }

    const ext = extname(srcAbsPath).toLowerCase()
    const id = nanoid(10)
    const relPath = `projects/${projectId}/media/${id}${ext}`
    const destAbs = join(getDataDir(), relPath)
    await mkdir(dirname(destAbs), { recursive: true })
    await copyFile(srcAbsPath, destAbs)

    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    const kind = detectKind(ext, mime)
    const now = Date.now()

    getDb()
      .prepare(
        'INSERT INTO media (id, kind, mime, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, kind, mime, relPath, st.size, now)

    const asset: MediaAsset = {
      id,
      kind,
      mime,
      path: relPath,
      sizeBytes: st.size,
      createdAt: now,
      name: basename(srcAbsPath, ext)
    }
    if (kind === 'file' && TEXT_EXTS.has(ext) && st.size <= MAX_TEXT_INLINE_BYTES) {
      asset.textContent = await readFile(destAbs, 'utf-8')
    }
    return { ok: true, asset }
  } catch (e) {
    console.error('importMedia failed:', srcAbsPath, e)
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export function getMediaAbsPath(relPath: string): string | null {
  // 只允许访问数据目录内的文件，防路径穿越
  const dataDir = getDataDir()
  const abs = join(dataDir, relPath)
  const normalized = normalizePath(abs)
  if (!normalized.startsWith(normalizePath(dataDir) + '/')) return null
  return abs
}

// 生成产物落盘（AI 生图/生视频）：与 importMedia 同一套目录与索引规则
export async function saveBufferAsset(
  projectId: string,
  buf: Buffer,
  ext: string,
  name: string
): Promise<MediaAsset> {
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  const kind = detectKind(ext, mime)
  const id = nanoid(10)
  const relPath = `projects/${projectId}/media/${id}${ext}`
  const destAbs = join(getDataDir(), relPath)
  await mkdir(dirname(destAbs), { recursive: true })
  await writeFile(destAbs, buf)

  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO media (id, kind, mime, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, kind, mime, relPath, buf.length, now)

  return {
    id,
    kind,
    mime,
    path: relPath,
    sizeBytes: buf.length,
    createdAt: now,
    name: name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || id
  }
}

/**
 * 把已落地的本地文件登记为媒体资产（流式下载专用）。
 *
 * 与 saveBufferAsset 的区别：调用方已把内容写到 srcAbs（如视频成片流式下载到
 * 临时文件），这里只做 rename 到目标位置 + SQLite 索引，不再读进内存——避免
 * 几百 MB 成片让主进程内存尖峰。srcAbs 会被移走（rename），调用方不应再使用。
 */
export async function saveFileAsset(
  projectId: string,
  srcAbs: string,
  ext: string,
  name: string
): Promise<MediaAsset> {
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  const kind = detectKind(ext, mime)
  const id = nanoid(10)
  const relPath = `projects/${projectId}/media/${id}${ext}`
  const destAbs = join(getDataDir(), relPath)
  await mkdir(dirname(destAbs), { recursive: true })
  // 先 rename 到目标；跨卷时 rename 会失败，回退到 copy + unlink
  try {
    await rename(srcAbs, destAbs)
  } catch {
    await copyFile(srcAbs, destAbs)
    await unlink(srcAbs).catch(() => {
      /* 清理失败不阻断登记 */
    })
  }
  const sizeBytes = (await stat(destAbs)).size

  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO media (id, kind, mime, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, kind, mime, relPath, sizeBytes, now)

  return {
    id,
    kind,
    mime,
    path: relPath,
    sizeBytes,
    createdAt: now,
    name: name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || id
  }
}
export async function readMediaBuffer(
  mediaId: string
): Promise<{ buf: Buffer; mime: string } | null> {
  const row = getDb().prepare('SELECT mime, path FROM media WHERE id = ?').get(mediaId) as
    { mime: string; path: string } | undefined
  if (!row) return null
  const abs = getMediaAbsPath(row.path)
  if (!abs) return null
  try {
    return { buf: await readFile(abs), mime: row.mime }
  } catch {
    return null
  }
}

// 列出指定项目的所有媒体资产（按创建时间倒序）
export function listMedia(projectId: string): MediaAsset[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, mime, path, size_bytes, created_at FROM media
       WHERE path LIKE ? ORDER BY created_at DESC`
    )
    .all(`projects/${projectId}/media/%`) as {
    id: string
    kind: MediaKind
    mime: string
    path: string
    size_bytes: number
    created_at: number
  }[]

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    path: r.path,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at
  }))
}

// 删除媒体资产（SQLite + 磁盘文件）
export async function deleteMedia(mediaId: string): Promise<boolean> {
  const row = getDb().prepare('SELECT path FROM media WHERE id = ?').get(mediaId) as
    { path: string } | undefined
  if (!row) return false
  const abs = getMediaAbsPath(row.path)
  getDb().prepare('DELETE FROM media WHERE id = ?').run(mediaId)
  if (abs) {
    try {
      await unlink(abs)
    } catch {
      // 文件可能已不存在，忽略
    }
  }
  return true
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/')
}
