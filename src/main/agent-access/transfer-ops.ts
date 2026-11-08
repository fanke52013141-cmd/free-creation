// 外部包传输（F7）：受控导出目录内的项目包 / 画布结构包 / 资源包导入导出。
//
// 设计边界（与 AGENT_PARITY_SPEC §5/§6、AGENTS.md「本地数据安全」一致）：
// 1) 业务实现只有一份：直接调用 GUI 使用的 store 服务
//    （store/transfer 的 exportProject/importProject、store/canvas-structure-transfer 的
//    importCanvasStructure、store/library.repo 的 exportResourcePackage/importResourcePackage），
//    本模块不复制解包、媒体重映射、密钥剥离或事务逻辑。
// 2) 外部独有的只有边界职责：包文件必须位于服务启动时确定的受控导出目录内
//    （realpath 后包含校验，拒绝路径穿越/符号链接逃逸）；导出先写目录内临时文件、
//    fsync、排他 link 落位（不覆盖）、返回 sha256/字节数回执；导入提交后核对
//    项目/媒体真实可读，异常时按公共服务的回滚语义清理半个项目。
// 3) 密钥剥离由 transfer 服务的 stripTransferCredentials 完成（项目文件/配方/Flow 资产）；
//    本模块不接触凭据，也不把路径、包内容或媒体字节写入日志。
import AdmZip from 'adm-zip'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { extname, isAbsolute, join, relative } from 'node:path'
import type { AccessOutput } from '../../shared/agent-access/registry'
import { completeTransferMediaMap } from '../store/flow-transfer'
import { listArtifactRecipes } from '../store/artifact-recipes.repo'
import { getDb, getProjectsDir } from '../store/db'
import * as projects from '../store/projects.repo'
import { importProject } from '../store/transfer'
import { exportCanvasStructure, importCanvasStructure } from '../store/canvas-structure-transfer'
import {
  exportResourcePackage,
  getResourceDetail,
  importResourcePackage
} from '../store/library.repo'
import { listMedia } from '../store/media.repo'

/** 失败作为值返回：service 的 switch case 只做 code/phase → AccessFailure 映射。 */
export type TransferOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; phase: string; detail?: string }

function fail(code: string, phase: string, detail?: string): TransferOutcome<never> {
  return { ok: false, code, phase, ...(detail ? { detail: detail.slice(0, 120) } : {}) }
}

interface ResolvedPackage {
  absolute: string
  byteSize: number
}

/** 流式 sha256：导入包可能接近 2GB 上限，不能整包读进内存。 */
function hashFile(path: string): string {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      digest.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return digest.digest('hex')
}

/**
 * 受控目录解析：只接受导出根目录（服务启动时 realpath 固定）内的普通包文件。
 * 先 realpath 再判包含，符号链接指向目录外时同样被拒绝。
 */
function resolveControlledPackage(
  exportRoot: string,
  rawPath: unknown,
  allowedExtensions: readonly string[]
): TransferOutcome<ResolvedPackage> {
  const input = typeof rawPath === 'string' ? rawPath.trim() : ''
  // eslint-disable-next-line no-control-regex -- 控制字符就是要拒绝的输入
  if (!input || input.length > 1000 || /[\u0000-\u001f]/.test(input))
    return fail('INVALID_INPUT', 'package-path', 'filePath')
  let root: string
  try {
    root = realpathSync(exportRoot)
  } catch {
    return fail('PATH_NOT_ALLOWED', 'package-path', 'export-root')
  }
  if (root !== exportRoot) return fail('PATH_NOT_ALLOWED', 'package-path', 'export-root')
  // 先做词法包含判断：即使目标不存在，`..`/绝对路径越界也返回 PATH_NOT_ALLOWED，
  // 不把“目录外是否存在某文件”暴露成可探测的错误差异；realpath 再兜住符号链接逃逸。
  const candidate = isAbsolute(input) ? input : join(root, input)
  const lexical = relative(root, candidate)
  if (!lexical || lexical.startsWith('..') || isAbsolute(lexical))
    return fail('PATH_NOT_ALLOWED', 'package-path', 'outside-export-directory')
  let absolute: string
  try {
    absolute = realpathSync(candidate)
  } catch {
    return fail('NOT_FOUND', 'package-path', 'package-missing')
  }
  const child = relative(root, absolute)
  if (!child || child.startsWith('..') || isAbsolute(child))
    return fail('PATH_NOT_ALLOWED', 'package-path', 'outside-export-directory')
  const extension = extname(absolute).toLowerCase()
  if (!allowedExtensions.includes(extension))
    return fail('INVALID_INPUT', 'package-path', 'package-extension')
  let byteSize: number
  try {
    const stat = statSync(absolute)
    if (!stat.isFile()) return fail('INVALID_INPUT', 'package-path', 'package-not-file')
    byteSize = stat.size
  } catch {
    return fail('NOT_FOUND', 'package-path', 'package-missing')
  }
  if (byteSize <= 0) return fail('PACKAGE_INVALID', 'package-path', 'package-empty')
  return { ok: true, data: { absolute, byteSize } }
}

/** 导入后核对：每个媒体索引都必须有可读文件，且大小与索引一致。 */
function mediaFilesReadable(projectId: string): boolean {
  const prefix = `projects/${projectId}/media/`
  let media: ReturnType<typeof listMedia>
  try {
    media = listMedia(projectId)
  } catch {
    return false
  }
  for (const asset of media) {
    if (typeof asset.path !== 'string' || !asset.path.startsWith(prefix)) return false
    const name = asset.path.slice(prefix.length)
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false
    try {
      const stat = statSync(join(getProjectsDir(), projectId, 'media', name))
      if (!stat.isFile() || stat.size !== asset.sizeBytes) return false
    } catch {
      return false
    }
  }
  return true
}

/** 包内被引用但未随包提供的媒体数量（与导出侧 requireComplete 同一遍历口径）。 */
function countMissingMedia(projectId: string, file: NonNullable<ReturnType<typeof projects.openProject>>): number {
  const media = listMedia(projectId)
  const known = {
    ids: new Map(media.map((item) => [item.id, item.id])),
    paths: new Map(media.map((item) => [item.path, item.path]))
  }
  const referenced = completeTransferMediaMap(completeClone(file), known, projectId, [
    listArtifactRecipes(projectId)
  ])
  return (
    [...referenced.ids.keys()].filter((key) => !known.ids.has(key)).length +
    [...referenced.paths.keys()].filter((key) => !known.paths.has(key)).length
  )
}

/** completeTransferMediaMap 会补全缺失引用（不改入参，但深拷贝避免调用方误用返回映射）。 */
function completeClone(file: NonNullable<ReturnType<typeof projects.openProject>>): typeof file {
  return JSON.parse(JSON.stringify(file)) as typeof file
}

/**
 * 提交后核对失败时清理刚导入的项目：它从未对用户可用（没有 opened/缓存），
 * 删除是回滚而不是破坏用户数据；清理失败保留现场由 workspace-health 上报。
 */
function cleanupImportedProject(projectId: string): void {
  try {
    projects.deleteProject(projectId)
  } catch {
    // 尽力清理；下面的目录删除仍会移除文件。
  }
  try {
    projects.purgeProjectFiles(projectId)
  } catch {
    // 清理失败不改变“导入失败”这一业务终态。
  }
  try {
    const staging = join(getProjectsDir(), `${projectId}.importing`)
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  } catch {
    // 暂存残留由启动时 workspace-health 处理。
  }
}

function classifyProjectImportFailure(error: unknown): TransferOutcome<never> {
  const message = error instanceof Error ? error.message : String(error)
  const transferCode = /FLOW_TRANSFER_[A-Z_]+/.exec(message)?.[0]
  if (transferCode) return fail('PACKAGE_CONTENT_INVALID', 'project-import', transferCode)
  if (message.includes('版本不兼容'))
    return fail('PACKAGE_VERSION_UNSUPPORTED', 'project-import', 'project.version')
  if (message.includes('条目数过多') || message.includes('解压后大小'))
    return fail('PACKAGE_TOO_LARGE', 'project-import', 'bundle.limits')
  if (message.includes('缺少 project.json'))
    return fail('PACKAGE_INVALID', 'project-import', 'bundle.manifest')
  if (message.includes('非法媒体路径'))
    return fail('PACKAGE_PATH_INVALID', 'project-import', 'bundle.media-path')
  if (message.includes('生成来源记录无效'))
    return fail('PACKAGE_CONTENT_INVALID', 'project-import', 'recipe.invalid')
  if (message.includes('导入项目 ID 冲突'))
    return fail('IMPORT_CONFLICT', 'project-import', 'project.id')
  if (error instanceof SyntaxError)
    return fail('PACKAGE_INVALID', 'project-import', 'bundle.json')
  return fail('IMPORT_FAILED', 'project-import', 'bundle.storage')
}

function classifyStructureImportFailure(error: unknown): TransferOutcome<never> {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('文件不存在')) return fail('NOT_FOUND', 'structure-import', 'structure-missing')
  if (message.includes('版本不受支持'))
    return fail('PACKAGE_VERSION_UNSUPPORTED', 'structure-import', 'structure.version')
  if (message.includes('超过 50 MB') || message.includes('文件为空'))
    return fail('PACKAGE_TOO_LARGE', 'structure-import', 'structure.limits')
  if (message.includes('不是有效的画布结构 JSON'))
    return fail('PACKAGE_INVALID', 'structure-import', 'structure.json')
  if (message.includes('缺少项目名称'))
    return fail('PACKAGE_INVALID', 'structure-import', 'structure.name')
  if (message.includes('嵌套过深') || message.includes('无效节点') || message.includes('无效连线') ||
      message.includes('无效分组') || message.includes('列表无效') || message.includes('快照') ||
      message.includes('记录过多'))
    return fail('PACKAGE_CONTENT_INVALID', 'structure-import', 'structure.graph')
  if (message.includes('无法保存导入的画布结构') || message.includes('工作台节点配置无效'))
    return fail('IMPORT_FAILED', 'structure-import', 'structure.storage')
  if (error instanceof SyntaxError)
    return fail('PACKAGE_INVALID', 'structure-import', 'structure.json')
  return fail('IMPORT_FAILED', 'structure-import', 'structure.storage')
}

function classifyLibraryImportFailure(error: unknown): TransferOutcome<never> {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('已导入过')) return fail('PACKAGE_DUPLICATE', 'library-import', 'package.sha256')
  if (message.includes('哈希校验失败'))
    return fail('PACKAGE_HASH_MISMATCH', 'library-import', 'blob.sha256')
  if (message.includes('大小校验失败'))
    return fail('PACKAGE_HASH_MISMATCH', 'library-import', 'blob.size')
  if (message.includes('格式或版本不受支持'))
    return fail('PACKAGE_VERSION_UNSUPPORTED', 'library-import', 'library.version')
  if (message.includes('条目过多') || message.includes('512 MB') || message.includes('资源包为空'))
    return fail('PACKAGE_TOO_LARGE', 'library-import', 'library.limits')
  if (message.includes('缺少有效清单') || message.includes('清单不是有效 JSON') || message.includes('清单无效'))
    return fail('PACKAGE_INVALID', 'library-import', 'library.manifest')
  if (message.includes('文件引用非法'))
    return fail('PACKAGE_PATH_INVALID', 'library-import', 'library.blob-path')
  if (
    message.includes('无效资源') ||
    message.includes('重复资源 ID') ||
    message.includes('重复版本 ID') ||
    message.includes('文件夹结构无效') ||
    message.includes('分类列表无效') ||
    message.includes('缺少文件')
  )
    return fail('PACKAGE_CONTENT_INVALID', 'library-import', 'library.content')
  if (error instanceof SyntaxError)
    return fail('PACKAGE_INVALID', 'library-import', 'library.manifest')
  return fail('LIBRARY_IMPORT_FAILED', 'library-import', 'library.storage')
}

function countLibraryResources(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM library_resources').get() as { n: number }
  return row.n
}

/** 完整项目包导入：暂存/校验/重映射/剥离凭据/事务提交都由公共 importProject 完成。 */
export function importProjectPackage(
  input: Record<string, unknown>,
  exportRoot: string
): TransferOutcome<AccessOutput<'project.import'>> {
  const resolved = resolveControlledPackage(exportRoot, input.filePath, ['.canvasbundle'])
  if (!resolved.ok) return resolved
  const { absolute, byteSize } = resolved.data
  const digest = hashFile(absolute)
  let imported: ReturnType<typeof importProject>
  try {
    imported = importProject(absolute)
  } catch (error) {
    return classifyProjectImportFailure(error)
  }
  // 提交后核对：列表可见的项目必须可读，媒体索引必须有真实文件。
  const index = projects.getProject(imported.id)
  const file = projects.openProject(imported.id)
  if (!index || !file || !mediaFilesReadable(imported.id)) {
    cleanupImportedProject(imported.id)
    return fail('STORAGE_INCONSISTENT', 'project-import-verify', 'committed-project-unreadable')
  }
  return {
    ok: true,
    data: {
      meta: index,
      nodeCount: file.nodes.length,
      edgeCount: file.edges.length,
      groupCount: file.groups.length,
      mediaCount: listMedia(imported.id).length,
      missingMediaCount: countMissingMedia(imported.id, file),
      sha256: digest,
      byteSize,
      committed: true
    }
  }
}

/** 结构包导入：复用 importCanvasStructure（新项目、清洗媒体引用与运行结果）。 */
export function importStructurePackage(
  input: Record<string, unknown>,
  exportRoot: string
): TransferOutcome<AccessOutput<'project.importStructure'>> {
  const resolved = resolveControlledPackage(exportRoot, input.filePath, ['.canvasflow'])
  if (!resolved.ok) return resolved
  const { absolute, byteSize } = resolved.data
  const digest = hashFile(absolute)
  let imported: ReturnType<typeof importCanvasStructure>
  try {
    imported = importCanvasStructure(absolute)
  } catch (error) {
    return classifyStructureImportFailure(error)
  }
  const index = projects.getProject(imported.id)
  const file = projects.openProject(imported.id)
  if (!index || !file) {
    cleanupImportedProject(imported.id)
    return fail('STORAGE_INCONSISTENT', 'structure-import-verify', 'committed-project-unreadable')
  }
  return {
    ok: true,
    data: {
      meta: index,
      nodeCount: file.nodes.length,
      edgeCount: file.edges.length,
      groupCount: file.groups.length,
      sha256: digest,
      byteSize,
      committed: true
    }
  }
}

/** 资源包导入：复用 importResourcePackage（清单/版本/逐文件哈希 + 单事务登记）。 */
export function importLibraryPackage(
  input: Record<string, unknown>,
  exportRoot: string
): TransferOutcome<AccessOutput<'library.import'>> {
  const resolved = resolveControlledPackage(exportRoot, input.filePath, ['.canvaslib'])
  if (!resolved.ok) return resolved
  const { absolute, byteSize } = resolved.data
  const digest = hashFile(absolute)
  let before: number
  try {
    before = countLibraryResources()
  } catch {
    return fail('STORAGE_UNAVAILABLE', 'library-import', 'library.read')
  }
  let imported: number
  try {
    imported = importResourcePackage(absolute)
  } catch (error) {
    return classifyLibraryImportFailure(error)
  }
  let after: number
  try {
    after = countLibraryResources()
  } catch {
    return fail('STORAGE_UNAVAILABLE', 'library-import-verify', 'library.read')
  }
  if (!Number.isInteger(imported) || imported < 0 || after - before !== imported) {
    // 事务已提交但业务事实不符：不伪造成功，明确要求在 GUI 复核资源库。
    return fail('STORAGE_INCONSISTENT', 'library-import-verify', 'library.count-mismatch')
  }
  return { ok: true, data: { imported, packageSha256: digest, byteSize, committed: true } }
}

/** 结构包导出：把**已保存**画布结构导出到受控目录（临时文件→fsync→排他落位，不覆盖）。 */
export async function exportStructurePackage(
  input: Record<string, unknown>,
  exportRoot: string,
  desktop?: {
    run: (request: {
      action: 'flush'
      projectId: string
      expectedGraphVersion?: number
    }) => Promise<{ graphVersion: number }>
  }
): Promise<TransferOutcome<AccessOutput<'project.exportStructure'>>> {
  const projectId = typeof input.projectId === 'string' ? input.projectId : ''
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(projectId))
    return fail('INVALID_INPUT', 'structure-export', 'projectId')
  const fileName = typeof input.fileName === 'string' ? input.fileName : ''
  if (!/^[a-zA-Z0-9_-]{1,100}\.canvasflow$/.test(fileName))
    return fail('INVALID_INPUT', 'structure-export', 'fileName')
  let file = projects.openProject(projectId)
  if (!file) return fail('NOT_FOUND', 'structure-export', 'projectId')
  // 结构包必须携带画布快照。若当前没有快照（例如项目只在外部建过图、从未在界面保存过），
  // 先经权威宿主做一次保存屏障：它会带上一份完整的 tldraw 快照。这样外部导出就不再
  // 依赖"必须先有人打开界面保存一次"。
  if ((!file.tldrawSnapshot || typeof file.tldrawSnapshot !== 'object') && desktop) {
    try {
      await desktop.run({
        action: 'flush',
        projectId,
        expectedGraphVersion: file.meta.graphVersion
      })
    } catch {
      // 保存屏障失败不在这里判死：下面仍会按"没有快照"如实拒绝。
    }
    file = projects.openProject(projectId)
    if (!file) return fail('NOT_FOUND', 'structure-export', 'projectId')
  }
  const snapshot = file.tldrawSnapshot
  if (!snapshot || typeof snapshot !== 'object')
    return fail(
      'STRUCTURE_SNAPSHOT_MISSING',
      'structure-export',
      'project has no saved canvas snapshot; open it in the GUI and save once first'
    )
  let root: string
  try {
    root = realpathSync(exportRoot)
  } catch {
    return fail('PATH_NOT_ALLOWED', 'structure-export', 'export-root')
  }
  if (root !== exportRoot) return fail('PATH_NOT_ALLOWED', 'structure-export', 'export-root')
  const destination = join(root, fileName)
  if (existsSync(destination)) return fail('OUTPUT_EXISTS', 'structure-export', fileName)
  const temporary = join(root, `.${randomUUID()}.canvasflow`)
  try {
    // 导出的是**已保存**的权威结构：外部请求不携带画布快照（renderer 的未保存编辑不在范围内，
    // 需要最新编辑请先 project.save；这与 GUI"导出画布结构"读取当前文档不同，如实写进台账）。
    const exported = exportCanvasStructure(temporary, {
      id: projectId,
      name: file.meta.name,
      graph: { nodes: file.nodes, edges: file.edges, groups: file.groups },
      snapshot
    })
    const fd = openSync(temporary, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const byteSize = statSync(temporary).size
    if (byteSize <= 0) return fail('EXPORT_FAILED', 'structure-export', 'package-empty')
    const sha256 = hashFile(temporary)
    // 排他创建：并发下也不会覆盖已有文件。
    linkSync(temporary, destination)
    return {
      ok: true,
      data: {
        fileName,
        byteSize,
        sha256,
        nodeCount: exported.nodeCount,
        overwritten: false
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') return fail('OUTPUT_EXISTS', 'structure-export', fileName)
    if (/版本不受支持|缺少项目名称/.test(error instanceof Error ? error.message : ''))
      return fail('PACKAGE_CONTENT_INVALID', 'structure-export', 'structure.graph')
    return fail('EXPORT_FAILED', 'structure-export', 'structure-write')
  } finally {
    try {
      if (existsSync(temporary)) rmSync(temporary, { force: true })
    } catch {
      // 临时文件清理失败不改变导出结果；残留为受控目录内隐藏文件。
    }
  }
}

/** 资源包导出：临时文件 + fsync + 排他 link 落位（不覆盖），回执 sha256/字节数。 */
export function exportLibraryPackage(
  input: Record<string, unknown>,
  exportRoot: string
): TransferOutcome<AccessOutput<'library.export'>> {
  const fileName = typeof input.fileName === 'string' ? input.fileName : ''
  if (!/^[a-zA-Z0-9_-]{1,100}\.canvaslib$/.test(fileName))
    return fail('INVALID_INPUT', 'library-export', 'fileName')
  const requested = input.resourceIds
  if (
    requested !== undefined &&
    (!Array.isArray(requested) ||
      requested.length > 500 ||
      requested.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)))
  )
    return fail('INVALID_INPUT', 'library-export', 'resourceIds')
  const ids = Array.isArray(requested) ? (requested as string[]) : undefined
  if (ids?.length) {
    for (const id of ids) {
      if (!getResourceDetail(id))
        return fail('NOT_FOUND', 'library-export', `resource:${id.slice(0, 40)}`)
    }
  }
  let root: string
  try {
    root = realpathSync(exportRoot)
  } catch {
    return fail('PATH_NOT_ALLOWED', 'library-export', 'export-root')
  }
  if (root !== exportRoot) return fail('PATH_NOT_ALLOWED', 'library-export', 'export-root')
  const destination = join(root, fileName)
  if (existsSync(destination)) return fail('OUTPUT_EXISTS', 'library-export', fileName)
  const temporary = join(root, `.${randomUUID()}.canvaslib`)
  try {
    exportResourcePackage(temporary, ids?.length ? ids : undefined)
    const fd = openSync(temporary, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const byteSize = statSync(temporary).size
    if (byteSize <= 0) return fail('EXPORT_FAILED', 'library-export', 'package-empty')
    const zim = new AdmZip(temporary)
    const manifestEntry = zim.getEntry('manifest.json')
    if (!manifestEntry) return fail('EXPORT_FAILED', 'library-export', 'package-manifest')
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as { resources?: unknown }
    if (!Array.isArray(manifest.resources))
      return fail('EXPORT_FAILED', 'library-export', 'package-manifest')
    const sha256 = hashFile(temporary)
    // 排他创建：并发下也不会覆盖已有文件（link 在目标存在时失败）。
    linkSync(temporary, destination)
    return {
      ok: true,
      data: {
        path: destination,
        byteSize,
        sha256,
        resourceCount: manifest.resources.length,
        overwritten: false
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') return fail('OUTPUT_EXISTS', 'library-export', fileName)
    if (error instanceof SyntaxError || error instanceof TypeError)
      return fail('EXPORT_FAILED', 'library-export', 'package-manifest')
    return fail('EXPORT_FAILED', 'library-export', 'library.storage')
  } finally {
    try {
      if (existsSync(temporary)) rmSync(temporary, { force: true })
    } catch {
      // 临时文件清理失败不改变导出结果；残留为受控目录内隐藏文件。
    }
  }
}
