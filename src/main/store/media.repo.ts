// 媒体仓库：文件落项目媒体目录 + SQLite 索引（见《技术框架与规范》§9）
// 异步复制：大文件导入不阻塞主进程
import { nanoid } from 'nanoid'
import { copyFile, mkdir, readFile, stat } from 'fs/promises'
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

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/')
}
