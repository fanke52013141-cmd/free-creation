// 项目导出/导入（路线图 R7 / 发布与数据安全）
//
// 把单个项目打包为自包含 zip（.canvasbundle），内含 project.json + 该项目 media/* 文件，
// 可复制到另一台机器后导入恢复。导入时会为项目生成新 id、为媒体生成新 mediaId，
// 避免与目标机器上的已有 id 冲突；并进行版本兼容检查（仅接受当前支持的 ProjectFile.version）。
//
// 安全：项目目录只含节点/连线/媒体，不含供应商 API Key（供应商配置存全局 app.db）；
// 因此导出包不包含 API Key，满足「导出诊断包不包含 API Key」。
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import type { MediaAsset, ProjectFile } from '../../shared/types'
import { getDb, getProjectsDir } from './db'

const BUNDLE_EXT = '.canvasbundle'
/** 当前支持的 ProjectFile version；导入时其它版本拒绝。 */
const SUPPORTED_PROJECT_VERSION = 1

interface BundleMeta {
  projectName: string
  sourceGraphVersion: number
  exportedAt: number
  projectVersion: number
}

export interface ProjectMetaInfo {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  graphVersion: number
}

function projectMediaDir(id: string): string {
  return join(getProjectsDir(), id, 'media')
}

/** 收集指定项目的媒体资产（从 SQLite 按路径前缀）。 */
function listProjectMedia(projectId: string): MediaAsset[] {
  const rows = getDb()
    .prepare(`SELECT id, kind, mime, path, size_bytes, created_at FROM media WHERE path LIKE ?`)
    .all(`projects/${projectId}/media/%`) as Array<{
    id: string
    kind: MediaAsset['kind']
    mime: string
    path: string
    size_bytes: number
    created_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    path: r.path,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at
  }))
}

/** 读取源项目文件（含 .bak 兜底）。 */
function readProjectJson(id: string): ProjectFile | null {
  const base = join(getProjectsDir(), id, 'project.json')
  for (const p of [base, base + '.bak']) {
    if (!existsSync(p)) continue
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as ProjectFile
    } catch {
      continue
    }
  }
  return null
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
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4'
}

function extName(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function kindFor(mime: string): MediaAsset['kind'] {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

/** 导出项目为 zip 到 destPath；返回目标路径。 */
export function exportProject(id: string, destPath: string): string {
  const file = readProjectJson(id)
  if (!file) throw new Error('项目数据文件缺失或已损坏')
  const path = destPath.endsWith(BUNDLE_EXT) ? destPath : `${destPath}${BUNDLE_EXT}`

  const zip = new AdmZip()
  zip.addFile('project.json', Buffer.from(JSON.stringify(file, null, 2), 'utf-8'))
  zip.addFile(
    'bundle.json',
    Buffer.from(
      JSON.stringify({
        projectName: file.meta.name,
        sourceGraphVersion: file.meta.graphVersion,
        exportedAt: Date.now(),
        projectVersion: file.version
      } satisfies BundleMeta)
    )
  )

  // zip 内 media/<原文件名>。原文件名形如 <mediaId>.<ext>，用 mediaId + ext 也可还原。
  for (const media of listProjectMedia(id)) {
    const rel = media.path.replace(`projects/${id}/`, '') // media/<id>.<ext>
    const abs = join(getProjectsDir(), id, rel)
    if (existsSync(abs)) zip.addLocalFile(abs, 'media')
  }

  zip.writeZip(path)
  return path
}

/** 导入项目 bundle，返回新项目元信息；版本不兼容或包损坏时抛错。 */
export function importProject(srcPath: string): ProjectMetaInfo {
  const zip = new AdmZip(srcPath)
  const fileEntry = zip.getEntry('project.json')
  if (!fileEntry) throw new Error('不是有效的项目导出包（缺少 project.json）')

  const file = JSON.parse(fileEntry.getData().toString('utf-8')) as ProjectFile
  if (file.version !== SUPPORTED_PROJECT_VERSION) {
    throw new Error(
      `项目版本不兼容：文件为 v${file.version}，当前支持 v${SUPPORTED_PROJECT_VERSION}`
    )
  }
  let bundleProjectName = file.meta.name
  const bundleEntry = zip.getEntry('bundle.json')
  if (bundleEntry) {
    try {
      const bundle = JSON.parse(bundleEntry.getData().toString('utf-8')) as Partial<BundleMeta>
      if (typeof bundle.projectName === 'string') bundleProjectName = bundle.projectName
    } catch {
      // bundle.json 损坏时用 project.json 的 name 兜底
    }
  }

  const newId = nanoid(12)
  const now = Date.now()
  const name = bundleProjectName || '导入的项目'
  const newMediaDir = projectMediaDir(newId)
  mkdirSync(newMediaDir, { recursive: true })

  // 媒体解包到新 media 目录，重写 mediaId + 重新入库。media/<origId>.<ext>
  const idMap = new Map<string, string>()
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith('media/') || entry.isDirectory) continue
    const origName = entry.entryName.replace('media/', '')
    const newMediaId = nanoid(10)
    idMap.set(origName, newMediaId)
    const ext = extName(origName)
    const mediaAbs = join(newMediaDir, `${newMediaId}${ext}`)
    writeFileSync(mediaAbs, entry.getData())

    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    const relPath = `projects/${newId}/media/${newMediaId}${ext}`
    getDb()
      .prepare(
        'INSERT INTO media (id, kind, mime, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(newMediaId, kindFor(mime), mime, relPath, readFileSync(mediaAbs).byteLength, now)
  }

  // 替换节点里的 mediaId 引用：按 `<mediaId>.<ext>` 的 mediaId 前缀映射到新 id
  const byMediaId = new Map<string, string>()
  for (const [origName, nid] of idMap) {
    byMediaId.set(origName.split('.')[0], nid)
  }
  for (const node of file.nodes) {
    if (node.content?.kind === 'media' && node.content.mediaId) {
      const newId = byMediaId.get(node.content.mediaId)
      if (newId) node.content = { kind: 'media', mediaId: newId }
    }
  }

  // 写新 project.json（重置 graphVersion=0）
  const newFile: ProjectFile = {
    ...file,
    meta: { id: newId, name, createdAt: now, updatedAt: now, graphVersion: 0 },
    nodes: file.nodes
  }
  writeFileSync(
    join(getProjectsDir(), newId, 'project.json'),
    JSON.stringify(newFile, null, 2),
    'utf-8'
  )

  getDb()
    .prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, graph_version) VALUES (?, ?, ?, ?, 0)'
    )
    .run(newId, name, now, now)

  return { id: newId, name, createdAt: now, updatedAt: now, graphVersion: 0 }
}
