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
import { listArtifactRecipes, saveArtifactRecipe } from './artifact-recipes.repo'
import { artifactRecipeSchema } from '../../shared/artifact-recipe'

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
    .prepare(`SELECT id, kind, mime, path, size_bytes, created_at FROM media WHERE substr(path, 1, length(?)) = ?`)
    .all(`projects/${projectId}/media/`, `projects/${projectId}/media/`) as Array<{
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

export interface ProjectExportResult {
  path: string
  /** 导出时在磁盘上已缺失、未能打入包内的媒体文件数量；>0 表示导出包不完整（R-33）。 */
  missingMediaCount: number
}

/** 导出项目为 zip 到 destPath；返回目标路径与缺失媒体计数。 */
export function exportProject(id: string, destPath: string): ProjectExportResult {
  const file = readProjectJson(id)
  if (!file) throw new Error('项目数据文件缺失或已损坏')
  const path = destPath.endsWith(BUNDLE_EXT) ? destPath : `${destPath}${BUNDLE_EXT}`

  const zip = new AdmZip()
  zip.addFile('recipes.json', Buffer.from(JSON.stringify(listArtifactRecipes(id)), 'utf-8'))
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
  // 磁盘上缺失的媒体只计数不阻断导出：主文件仍可备份，但计数必须透传给用户告警。
  let missingMediaCount = 0
  for (const media of listProjectMedia(id)) {
    const rel = media.path.replace(`projects/${id}/`, '') // media/<id>.<ext>
    const abs = join(getProjectsDir(), id, rel)
    if (existsSync(abs)) zip.addLocalFile(abs, 'media')
    else missingMediaCount += 1
  }

  zip.writeZip(path)
  return { path, missingMediaCount }
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
  const finalMediaDir = join(newProjectDir, 'media')
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

    const recipesEntry = zip.getEntry('recipes.json')
    const recipes: unknown = recipesEntry
      ? JSON.parse(recipesEntry.getData().toString('utf-8'))
      : []
    if (!Array.isArray(recipes) || recipes.length > 100000) throw new Error('生成来源记录无效')
    const importedRecipes = recipes.map((recipe) => artifactRecipeSchema.parse(recipe))
    const remapped = remapMediaReferences(file, {
      ids: new Map(mediaRefs.map((ref) => [ref.oldId, ref.newId])),
      paths: new Map(mediaRefs.map((ref) => [ref.oldPath, ref.newPath]))
    })
    const newFile: ProjectFile = {
      ...remapped,
      meta: { id: newId, name, createdAt: now, updatedAt: now, graphVersion: 0 }
    }
    writeFileSync(join(stagingDir, 'project.json'), JSON.stringify(newFile, null, 2), 'utf-8')

    // 目录先就位、数据库后提交（R-34）：中间崩溃的残留只可能是
    // ① rename 前的 `<id>.importing` staging（workspace-health 搬入 .recovery），或
    // ② rename 后的「目录存在但无 DB 记录」——列表不可见，reconcile 以
    // orphanedProjectIds 上报。绝不会出现「列表可见但目录缺失」的幽灵项目。
    renameSync(stagingDir, newProjectDir)

    const database = getDb()
    const insertProject = database.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, graph_version) VALUES (?, ?, ?, ?, 0)'
    )
    const insertMedia = database.prepare(
      'INSERT INTO media (id, kind, mime, path, size_bytes, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    database.transaction(() => {
      insertProject.run(newId, name, now, now)
      for (const ref of mediaRefs) {
        const ext = extName(ref.newPath)
        const finalPath = join(finalMediaDir, `${ref.newId}${ext}`)
        const mime = mimeForExtension(ext)
        insertMedia.run(
          ref.newId,
          kindFor(mime),
          mime,
          ref.newPath,
          readFileSync(finalPath).byteLength,
          now,
          `${kindFor(mime) === 'image' ? '图片' : kindFor(mime) === 'video' ? '视频' : kindFor(mime) === 'audio' ? '音频' : '文件'}素材-${ref.newId.slice(0, 6)}`
        )
      }
      const mediaIds = new Map(mediaRefs.map((ref) => [ref.oldId, ref.newId]))
      for (const recipe of importedRecipes) {
        const mediaId = mediaIds.get(recipe.mediaId)
        if (!mediaId) continue
        saveArtifactRecipe({
          ...recipe,
          projectId: newId,
          mediaId,
          paramsJson: remapMediaReferences(recipe.paramsJson, {
            ids: mediaIds,
            paths: new Map(mediaRefs.map((ref) => [ref.oldPath, ref.newPath]))
          }),
          inputMediaIds: recipe.inputMediaIds.flatMap((id) =>
            mediaIds.has(id) ? [mediaIds.get(id)!] : []
          ),
          missingInputMediaIds: [
            ...new Set([
              ...(recipe.missingInputMediaIds ?? []),
              ...recipe.inputMediaIds.filter((id) => !mediaIds.has(id))
            ])
          ]
        })
      }
    })()
  } catch (error) {
    // 回滚与提交顺序相反：目录已 rename 则删正式目录（此刻项目从未对用户可见，
    // 且 DB 事务原子回滚，不存在指向该目录的记录）；仍在 staging 则按既有约定删 staging。
    if (existsSync(newProjectDir)) rmSync(newProjectDir, { recursive: true, force: true })
    else if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }

  return { id: newId, name, createdAt: now, updatedAt: now, graphVersion: 0 }
}
