import { emitDomainEvent } from '../diagnostics/ipc-domain-events'
// 媒体仓库：文件落项目媒体目录 + SQLite 索引（见《技术框架与规范》§9）
// 异步复制：大文件导入不阻塞主进程
import { nanoid } from 'nanoid'
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import type { MediaAsset, MediaKind } from '../../shared/types'
import { BINARY_DOC_EXTS, INLINE_TEXT_EXTS, mimeForExtension } from '../../shared/mime'
import { MAX_DOC_BYTES, extractDocumentText } from '../media/document-text'
import { decodeTextFile } from '../media/text-decode'
import { getDataDir, getDb } from './db'

// 单文件上限 2GB；文本内容内联上限 1MB（超限的文本文件不读内容，仅存文件）
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TEXT_INLINE_BYTES = 1024 * 1024

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

    const mime = mimeForExtension(ext)
    const kind = detectKind(ext, mime)
    const now = Date.now()

    getDb()
      .prepare(
        'INSERT INTO media (id, kind, mime, path, size_bytes, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, kind, mime, relPath, st.size, now, basename(srcAbsPath, ext))

    const asset: MediaAsset = {
      id,
      kind,
      mime,
      path: relPath,
      sizeBytes: st.size,
      createdAt: now,
      name: basename(srcAbsPath, ext)
    }
    if (kind === 'file' && st.size <= MAX_TEXT_INLINE_BYTES && INLINE_TEXT_EXTS.includes(ext)) {
      asset.textContent = decodeTextFile(await readFile(destAbs))
    } else if (kind === 'file' && st.size <= MAX_DOC_BYTES && BINARY_DOC_EXTS.includes(ext)) {
      // Office / PDF 在导入时就抽取正文：out-text 与节点预览共用同一份结果，失败则只留原始文件。
      const text = await extractDocumentText(ext, await readFile(destAbs))
      if (text) asset.textContent = text
    }
    return { ok: true, asset }
  } catch (e) {
    emitDomainEvent('media.read_failed', '媒体导入读取失败', {
      status: 'failed',
      attributes: { projectId }
    })
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
  const mime = mimeForExtension(ext)
  const kind = detectKind(ext, mime)
  const id = nanoid(10)
  const relPath = `projects/${projectId}/media/${id}${ext}`
  const destAbs = join(getDataDir(), relPath)
  await mkdir(dirname(destAbs), { recursive: true })
  await writeFile(destAbs, buf)

  const now = Date.now()
  const assetName = name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || id
  getDb()
    .prepare(
      'INSERT INTO media (id, kind, mime, path, size_bytes, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, kind, mime, relPath, buf.length, now, assetName)

  return {
    id,
    kind,
    mime,
    path: relPath,
    sizeBytes: buf.length,
    createdAt: now,
    name: assetName
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
  const mime = mimeForExtension(ext)
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
  const assetName = name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || id
  getDb()
    .prepare(
      'INSERT INTO media (id, kind, mime, path, size_bytes, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, kind, mime, relPath, sizeBytes, now, assetName)

  return {
    id,
    kind,
    mime,
    path: relPath,
    sizeBytes,
    createdAt: now,
    name: assetName
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
  // 前缀范围查询可走 idx_media_path；原 substr() 条件无法使用索引，
  // 媒体行随所有项目累积后每次打开画布都全表扫描。范围语义与 substr 前缀完全一致。
  const prefix = `projects/${projectId}/media/`
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
  const rows = getDb()
    .prepare(
      `SELECT id, kind, mime, path, size_bytes, created_at, name FROM media
       WHERE path >= ? AND path < ? ORDER BY created_at DESC`
    )
    .all(prefix, upper) as {
    id: string
    kind: MediaKind
    mime: string
    path: string
    size_bytes: number
    created_at: number
    name: string | null
  }[]

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    path: r.path,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    ...(r.name ? { name: r.name } : {})
  }))
}

/** 按 id 全局读取媒体资产（headless 节点流输入解析用，不限项目作用域）。 */
export function getMediaAsset(mediaId: string): MediaAsset | null {
  const r = getDb()
    .prepare('SELECT id, kind, mime, path, size_bytes, created_at, name FROM media WHERE id = ?')
    .get(mediaId) as
    | {
        id: string
        kind: MediaKind
        mime: string
        path: string
        size_bytes: number
        created_at: number
        name: string | null
      }
    | undefined
  if (!r) return null
  return {
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    path: r.path,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    ...(r.name ? { name: r.name } : {})
  }
}

// 删除媒体资产（SQLite + 磁盘文件）
export async function deleteMedia(mediaId: string): Promise<boolean> {
  const row = getDb().prepare('SELECT path FROM media WHERE id = ?').get(mediaId) as
    { path: string } | undefined
  if (!row) return false
  const abs = getMediaAbsPath(row.path)
  if (!abs) throw new Error('媒体文件路径无效')
  try {
    await unlink(abs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  getDb().transaction(() => {
    getDb().prepare('DELETE FROM artifact_recipes WHERE media_id = ?').run(mediaId)
    getDb().prepare('DELETE FROM media WHERE id = ?').run(mediaId)
  })()
  return true
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/')
}

/** 回填用的元数据补丁：字段缺失或为 null 表示「这次没探测到」，不覆盖库里已有值。 */
export interface MediaMetadataPatch {
  width?: number | null
  height?: number | null
  durationSec?: number | null
}

/**
 * 按 id 回填媒体元数据（时间线 M3）：只 UPDATE 调用方明确给出的非 null 字段。
 *
 * 为什么不整行写入：一次探测可能只拿到尺寸（图片没有 duration）或只拿到时长
 * （纯音频没有宽高），用 null 覆盖会把之前探测到的正确数据擦掉。库里列名遵循
 * media 建表 SQL：width / height 是 INTEGER，duration_sec 是 REAL（秒）。
 * 调用方负责把探测到的毫秒换算成秒（durationSec = durationMs / 1000）。
 */
export function updateMediaMetadata(id: string, meta: MediaMetadataPatch): void {
  const assignments: string[] = []
  const values: number[] = []
  const add = (
    column: string,
    value: number | null | undefined,
    normalize: (input: number) => number | null
  ): void => {
    if (value === null || value === undefined) return
    const normalized = normalize(value)
    if (normalized === null) return
    assignments.push(`${column} = ?`)
    values.push(normalized)
  }
  add('width', meta.width, positiveDimension)
  add('height', meta.height, positiveDimension)
  add('duration_sec', meta.durationSec, nonNegativeSeconds)
  // 三项都没探测到时不发一条空 UPDATE，避免无意义的写锁与事件。
  if (assignments.length === 0) return
  getDb()
    .prepare(`UPDATE media SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id)
}

/** 宽高是像素整数；非正数/NaN 一律视为没探测到。 */
function positiveDimension(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

/** 时长按毫秒精度落库，保留三位小数即可，避免浮点尾数进数据库。 */
function nonNegativeSeconds(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 1000) / 1000
}
