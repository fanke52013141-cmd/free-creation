// 项目导出/导入（路线图 R7 / 发布与数据安全）
//
// 把单个项目打包为自包含 zip（.canvasbundle），内含 project.json + 该项目 media/* 文件，
// 可复制到另一台机器后导入恢复。导入时会为项目生成新 id、为媒体生成新 mediaId，
// 避免与目标机器上的已有 id 冲突；并进行版本兼容检查（仅接受当前支持的 ProjectFile.version）。
//
// 安全：项目目录只含节点/连线/媒体，不含供应商 API Key（供应商配置存全局 app.db）；
// 因此导出包不包含 API Key，满足「导出诊断包不包含 API Key」。
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import type { MediaAsset, ProjectFile } from '../../shared/types'
import { mimeForExtension } from '../../shared/mime'
import { remapMediaReferences } from '../../shared/media-reference-remap'
import { getDb, getProjectsDir } from './db'

const BUNDLE_EXT = '.canvasbundle'
/** 当前支持的 ProjectFile version；导入时其它版本拒绝。 */
const SUPPORTED_PROJECT_VERSION = 1
/** 导入包条目数上限：防止 zip 炸弹 / 损坏包耗尽文件描述符与磁盘。 */
const MAX_BUNDLE_ENTRIES = 50_000
/** 导入包解压后总大小上限（2GB）：与单文件媒体上限一致。 */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024

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

interface ImportedMediaRef {
  oldId: string
  newId: string
  oldPath: string
  newPath: string
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

  // 导入安全上限：拒绝条目过多或解压体过大的包，防止 zip 炸弹 / 损坏包耗尽
  // 文件描述符与磁盘。AdmZip 仍是同步整包载入内存，这两个上限能卡住异常包，
  // 但彻底流式化需换 yauzl 等库（更大重构，本次不做）。
  const entries = zip.getEntries()
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error(`项目包条目数过多（${entries.length}），可能已损坏`)
  }
  let totalUncompressed = 0
  for (const entry of entries) {
    totalUncompressed += entry.header.size ?? 0
  }
  if (totalUncompressed > MAX_BUNDLE_BYTES) {
    throw new Error(`项目包解压后大小超过 2GB 上限`)
  }

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
  const projectsDir = getProjectsDir()
  const newProjectDir = join(projectsDir, newId)
  const stagingDir = join(projectsDir, `${newId}.importing`)
  const stagingMediaDir = join(stagingDir, 'media')
  const sourceProjectId = file.meta.id
  if (existsSync(newProjectDir) || existsSync(stagingDir))
    throw new Error('导入项目 ID 冲突，请重试')

  mkdirSync(stagingMediaDir, { recursive: true })
  const mediaRefs: ImportedMediaRef[] = []
  let databaseInserted = false
  try {
    // 先完整写入临时目录；遇到任何损坏条目时不会留下可见项目或数据库记录。
    for (const entry of zip.getEntries()) {
      if (!entry.entryName.startsWith('media/') || entry.isDirectory) continue
      const origName = entry.entryName.slice('media/'.length)
      if (
        !origName ||
        origName.includes('/') ||
        origName.includes('\\') ||
        origName.includes('..')
      ) {
        throw new Error(`项目包包含非法媒体路径：${entry.entryName}`)
      }
      const dot = origName.lastIndexOf('.')
      const oldMediaId = dot > 0 ? origName.slice(0, dot) : origName
      const ext = extName(origName)
      const newMediaId = nanoid(10)
      const stagedPath = join(stagingMediaDir, `${newMediaId}${ext}`)
      writeFileSync(stagedPath, entry.getData())
      mediaRefs.push({
        oldId: oldMediaId,
        newId: newMediaId,
        oldPath: `projects/${sourceProjectId}/media/${origName}`,
        newPath: `projects/${newId}/media/${newMediaId}${ext}`
      })
    }

    const remapped = remapMediaReferences(file, {
      ids: new Map(mediaRefs.map((ref) => [ref.oldId, ref.newId])),
      paths: new Map(mediaRefs.map((ref) => [ref.oldPath, ref.newPath]))
    })
    const newFile: ProjectFile = {
      ...remapped,
      meta: { id: newId, name, createdAt: now, updatedAt: now, graphVersion: 0 }
    }
    writeFileSync(join(stagingDir, 'project.json'), JSON.stringify(newFile, null, 2), 'utf-8')

    const database = getDb()
    const insertProject = database.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, graph_version) VALUES (?, ?, ?, ?, 0)'
    )
    const insertMedia = database.prepare(
      'INSERT INTO media (id, kind, mime, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    database.transaction(() => {
      insertProject.run(newId, name, now, now)
      for (const ref of mediaRefs) {
        const ext = extName(ref.newPath)
        const stagedPath = join(stagingMediaDir, `${ref.newId}${ext}`)
        const mime = mimeForExtension(ext)
        insertMedia.run(
          ref.newId,
          kindFor(mime),
          mime,
          ref.newPath,
          readFileSync(stagedPath).byteLength,
          now
        )
      }
    })()
    databaseInserted = true

    // 数据库提交成功后，目录的单次 rename 才让项目对列表可见。
    renameSync(stagingDir, newProjectDir)
  } catch (error) {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
    // rename 前的 DB 写入失败路径需要补偿，避免项目列表出现指向不存在目录的幽灵记录。
    if (databaseInserted && !existsSync(newProjectDir)) {
      const database = getDb()
      database.transaction(() => {
        database.prepare('DELETE FROM media WHERE path LIKE ?').run(`projects/${newId}/media/%`)
        database.prepare('DELETE FROM projects WHERE id = ?').run(newId)
      })()
    }
    // rename 成功后的异常保留正式目录，避免删除可恢复的用户项目。
    throw error
  }

  return { id: newId, name, createdAt: now, updatedAt: now, graphVersion: 0 }
}
