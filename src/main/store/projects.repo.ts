// 项目仓库：SQLite 索引 + project.json 图数据（见《技术框架与规范》§9）
import { nanoid } from 'nanoid'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  lstatSync,
  copyFileSync
} from 'fs'
import { basename, join } from 'path'
import type { ProjectFile, ProjectMeta } from '../../shared/types'
import type { WorkspaceProfile } from '../../shared/workspace-profile'
import {
  defaultWorkspaceProfile,
  normalizeWorkspaceProfile
} from '../../shared/workspace-profile'
import { remapMediaReferences } from '../../shared/media-reference-remap'
import {
  GraphVersionConflictError,
  GraphWriteInProgressError
} from '../../shared/graph-snapshot-sync'
import { getDataDir, getDb, getProjectsDir } from './db'

interface ProjectRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  cover_media_id: string | null
  graph_version: number
}

function rowToMeta(row: ProjectRow): ProjectMeta {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    coverMediaId: row.cover_media_id ?? undefined,
    graphVersion: row.graph_version
  }
}

function projectDir(id: string): string {
  return join(getProjectsDir(), id)
}

function projectJsonPath(id: string): string {
  return join(projectDir(id), 'project.json')
}

const PROJECT_WRITE_LOCK_STALE_MS = 30_000

function acquireProjectWriteLock(lockPath: string): number {
  // 图快照事务只做本地同步 I/O；超过 30 秒仍存在的锁说明持锁进程已经异常终止。
  // 接管前仅按 mtime 判定，避免把不可探测的旧 Electron PID 当作活进程。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return openSync(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs
        if (ageMs >= PROJECT_WRITE_LOCK_STALE_MS && attempt === 0) {
          unlinkSync(lockPath)
          continue
        }
      } catch (lockError) {
        // 若锁刚被持有者删除，下一次循环重新尝试获取；其余错误仍按“写入中”返回。
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT' && attempt === 0) continue
      }
      throw new GraphWriteInProgressError()
    }
  }
  throw new GraphWriteInProgressError()
}

// 主文件损坏时回退 .bak（保存时每次轮转一份）
function readProjectFile(id: string): ProjectFile | null {
  const path = projectJsonPath(id)
  for (const p of [path, path + '.bak']) {
    if (!existsSync(p)) continue
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as ProjectFile
    } catch {
      continue
    }
  }
  return null
}

export function listProjects(): ProjectMeta[] {
  const rows = getDb()
    .prepare('SELECT * FROM projects WHERE deleted = 0 ORDER BY updated_at DESC')
    .all() as ProjectRow[]
  return rows.map(rowToMeta)
}

export function createProject(name: string, workspaceProfile?: WorkspaceProfile): ProjectMeta {
  const id = nanoid(12)
  const now = Date.now()
  const profile = workspaceProfile
    ? normalizeWorkspaceProfile(workspaceProfile)
    : defaultWorkspaceProfile()
  if (!profile) throw new Error('工作台节点配置无效')
  mkdirSync(join(projectDir(id), 'media'), { recursive: true })

  const file: ProjectFile = {
    version: 1,
    meta: { id, name, createdAt: now, updatedAt: now, graphVersion: 0 },
    nodes: [],
    edges: [],
    groups: [],
    workspaceProfile: profile
  }
  writeFileSync(projectJsonPath(id), JSON.stringify(file, null, 2), 'utf-8')

  getDb()
    .prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, graph_version) VALUES (?, ?, ?, ?, 0)'
    )
    .run(id, name, now, now)

  return { id, name, createdAt: now, updatedAt: now, graphVersion: 0 }
}

/** Update only workspace visibility without advancing the graph's optimistic-lock version. */
export function saveWorkspaceProfile(
  id: string,
  value: WorkspaceProfile
): ProjectMeta | null {
  const profile = normalizeWorkspaceProfile(value)
  if (!profile) throw new Error('工作台节点配置无效')
  if (!getProject(id)) return null
  const path = projectJsonPath(id)
  const lockFd = acquireProjectWriteLock(path + '.write-lock')
  try {
    const meta = getProject(id)
    const file = readProjectFile(id)
    if (!meta || !file) return null
    const now = Date.now()
    file.workspaceProfile = profile
    file.meta = { ...file.meta, updatedAt: now }
    const tmp = path + '.tmp'
    const bak = path + '.bak'
    let phase: 'write-tmp' | 'rotate-bak' | 'promote-tmp' | 'update-db' = 'write-tmp'
    try {
      writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
      phase = 'rotate-bak'
      if (existsSync(path)) renameSync(path, bak)
      phase = 'promote-tmp'
      renameSync(tmp, path)
      phase = 'update-db'
      getDb().prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, id)
    } catch (error) {
      try {
        if (phase === 'write-tmp' || phase === 'rotate-bak') {
          if (existsSync(tmp)) rmSync(tmp, { force: true })
        } else if (phase === 'promote-tmp') {
          if (existsSync(tmp)) rmSync(tmp, { force: true })
          if (!existsSync(path) && existsSync(bak)) renameSync(bak, path)
        } else {
          if (existsSync(path)) renameSync(path, tmp)
          if (existsSync(bak)) renameSync(bak, path)
          if (existsSync(tmp)) rmSync(tmp, { force: true })
        }
      } catch {
        // Keep recoverable tmp/bak files if rollback itself fails.
      }
      throw error
    }
    return getProject(id)
  } finally {
    closeSync(lockFd)
    try {
      if (existsSync(path + '.write-lock')) unlinkSync(path + '.write-lock')
    } catch {
      // Keep the lock if it cannot be safely removed; the next write reports it.
    }
  }
}

interface CloneMediaRow {
  id: string
  kind: string
  mime: string
  path: string
  size_bytes: number
  width: number | null
  height: number | null
  duration_sec: number | null
  name: string | null
}

function stopRunningClonedJobs(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map((item) => stopRunningClonedJobs(item, now))
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
    try {
      const parsed = JSON.parse(value) as unknown
      const stopped = stopRunningClonedJobs(parsed, now)
      return JSON.stringify(stopped) === JSON.stringify(parsed) ? value : JSON.stringify(stopped)
    } catch {
      return value
    }
  }
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'nodeRun' && child && typeof child === 'object') {
      const record = child as Record<string, unknown>
      output[key] = record.status === 'running'
        ? {
            ...record,
            status: 'cancelled',
            finishedAt: now,
            error: { phase: 'execution', reason: '项目副本不会继续源项目中的运行任务' }
          }
        : child
    } else {
      output[key] = stopRunningClonedJobs(child, now)
    }
  }
  return output
}

function freshCloneEntityId(value: string): string {
  const separator = value.indexOf(':')
  return separator > 0
    ? `${value.slice(0, separator)}:${nanoid(12)}`
    : nanoid(12)
}

function cloneEntityIdMap(file: ProjectFile, newProjectId: string): Map<string, string> {
  const ids = new Map<string, string>([[file.meta.id, newProjectId]])
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value && !ids.has(value)) ids.set(value, freshCloneEntityId(value))
  }
  file.nodes.forEach((node) => add(node.id))
  file.edges.forEach((edge) => add(edge.id))
  file.groups.forEach((group) => add(group.id))

  const snapshot = file.tldrawSnapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return ids
  const store = (snapshot as { store?: unknown }).store
  if (!store || typeof store !== 'object' || Array.isArray(store)) return ids
  for (const [key, raw] of Object.entries(store as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as { typeName?: unknown; id?: unknown }
    if (record.typeName === 'shape' || record.typeName === 'binding' ||
      record.typeName === 'page' || record.typeName === 'asset' ||
      record.typeName === 'instance_page_state') {
      add(typeof record.id === 'string' ? record.id : key)
    }
  }
  // tldraw camera records are keyed by their page ID rather than owning a standalone ID.
  for (const [key, raw] of Object.entries(store as Record<string, unknown>)) {
    if (!key.startsWith('camera:') || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const pageId = key.slice('camera:'.length)
    const clonedPageId = ids.get(pageId)
    if (clonedPageId) ids.set(key, `camera:${clonedPageId}`)
  }
  return ids
}

/** Clone a complete, independent project snapshot and remap every project media reference. */
export function cloneProject(sourceId: string, requestedName: string): ProjectMeta {
  const sourceMeta = getProject(sourceId)
  if (!sourceMeta) throw new Error('源项目不存在')
  const sourceFile = readProjectFile(sourceId)
  if (!sourceFile) throw new Error('源项目不存在或项目文件损坏')
  const name = requestedName.trim().slice(0, 120)
  if (!name) throw new Error('项目名称不能为空')

  const id = nanoid(12)
  const now = Date.now()
  const finalDir = projectDir(id)
  const stagingDir = join(getProjectsDir(), `${id}.cloning`)
  if (existsSync(finalDir) || existsSync(stagingDir)) throw new Error('项目 ID 冲突，请重试')
  const stagingMediaDir = join(stagingDir, 'media')
  const rows = getDb()
    .prepare(
      `SELECT id, kind, mime, path, size_bytes, width, height, duration_sec, name
       FROM media WHERE path LIKE ? ORDER BY created_at ASC`
    )
    .all(`projects/${sourceId}/media/%`) as CloneMediaRow[]
  const ids = new Map<string, string>()
  const paths = new Map<string, string>()
  const clonedRows: Array<CloneMediaRow & { newId: string; newPath: string }> = []

  mkdirSync(stagingMediaDir, { recursive: true })
  try {
    const dataRoot = getDataDir()
    for (const row of rows) {
      const normalized = row.path.replace(/\\/g, '/')
      const sourcePrefix = `projects/${sourceId}/media/`
      if (!normalized.startsWith(sourcePrefix)) throw new Error(`源项目媒体路径非法：${row.path}`)
      const fileName = normalized.slice(sourcePrefix.length)
      if (!fileName || fileName.includes('/') || fileName.includes('..')) {
        throw new Error(`源项目媒体路径非法：${row.path}`)
      }
      const sourcePath = join(dataRoot, 'projects', sourceId, 'media', fileName)
      if (!existsSync(sourcePath)) throw new Error(`项目媒体文件缺失：${fileName}`)
      const sourceStats = lstatSync(sourcePath)
      if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) throw new Error(`项目媒体文件类型无效：${fileName}`)
      const actualBytes = sourceStats.size
      if (actualBytes !== row.size_bytes) throw new Error(`项目媒体文件大小异常：${fileName}`)
      const newId = nanoid(10)
      const dot = fileName.lastIndexOf('.')
      const ext = dot > 0 ? fileName.slice(dot) : ''
      const newPath = `projects/${id}/media/${newId}${ext}`
      copyFileSync(sourcePath, join(stagingMediaDir, `${newId}${ext}`))
      ids.set(row.id, newId)
      paths.set(row.path, newPath)
      clonedRows.push({ ...row, newId, newPath })
    }

    const entityIds = cloneEntityIdMap(sourceFile, id)
    for (const [oldId, newId] of ids) entityIds.set(oldId, newId)
    const remappedFile = remapMediaReferences(sourceFile, { ids: entityIds, paths }) as ProjectFile
    if (remappedFile.tldrawSnapshot && typeof remappedFile.tldrawSnapshot === 'object') {
      const snapshot = remappedFile.tldrawSnapshot as { store?: unknown }
      if (snapshot.store && typeof snapshot.store === 'object' && !Array.isArray(snapshot.store)) {
        const store: Record<string, unknown> = {}
        for (const [key, record] of Object.entries(snapshot.store as Record<string, unknown>)) {
          store[entityIds.get(key) ?? key] = record
        }
        snapshot.store = store
      }
    }
    const clonedFile = stopRunningClonedJobs(remappedFile, now) as ProjectFile
    clonedFile.meta = {
      ...clonedFile.meta,
      id,
      name,
      createdAt: now,
      updatedAt: now,
      graphVersion: 0,
      ...(sourceFile.meta.coverMediaId && ids.has(sourceFile.meta.coverMediaId)
        ? { coverMediaId: ids.get(sourceFile.meta.coverMediaId) }
        : { coverMediaId: undefined })
    }
    writeFileSync(join(stagingDir, 'project.json'), JSON.stringify(clonedFile, null, 2), 'utf-8')

    const database = getDb()
    const usageRows = database.prepare(
      `SELECT resource_id, revision_id, component_ids_json, project_media_ids_json,
        materialized_node_ids_json, created_at, last_used_at
       FROM library_usages WHERE project_id = ?`
    ).all(sourceId) as Array<{
      resource_id: string
      revision_id: string
      component_ids_json: string
      project_media_ids_json: string
      materialized_node_ids_json: string
      created_at: number
      last_used_at: number
    }>
    const insertProject = database.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at, cover_media_id, graph_version)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    const insertMedia = database.prepare(
      `INSERT INTO media (id, kind, mime, path, size_bytes, width, height, duration_sec, created_at, name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertUsage = database.prepare(
      `INSERT INTO library_usages
        (id, project_id, resource_id, revision_id, component_ids_json,
         project_media_ids_json, materialized_node_ids_json, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // Publish the complete directory before exposing its project row. If the process exits
    // between the rename and DB commit, this leaves only an unlisted directory that can be
    // recovered or cleaned later, never a visible project with missing files.
    renameSync(stagingDir, finalDir)
    database.transaction(() => {
      insertProject.run(
        id,
        name,
        now,
        now,
        sourceMeta.coverMediaId ? ids.get(sourceMeta.coverMediaId) ?? null : null
      )
      for (const row of clonedRows) {
        insertMedia.run(
          row.newId,
          row.kind,
          row.mime,
          row.newPath,
          row.size_bytes,
          row.width,
          row.height,
          row.duration_sec,
          now,
          row.name ?? basename(row.newPath)
        )
      }
      for (const row of usageRows) {
        const remapJsonIds = (value: string): string => {
          try {
            const parsed = JSON.parse(value) as unknown
            return JSON.stringify(Array.isArray(parsed)
              ? parsed.map((item) => typeof item === 'string' ? entityIds.get(item) ?? item : item)
              : parsed)
          } catch {
            return value
          }
        }
        insertUsage.run(
          nanoid(12), id, row.resource_id, row.revision_id, row.component_ids_json,
          remapJsonIds(row.project_media_ids_json), remapJsonIds(row.materialized_node_ids_json),
          now, now
        )
      }
    })()
  } catch (error) {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true })
    throw error
  }
  return getProject(id) ?? { id, name, createdAt: now, updatedAt: now, graphVersion: 0 }
}

export function renameProject(id: string, name: string): ProjectMeta | null {
  const now = Date.now()
  const result = getDb()
    .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND deleted = 0')
    .run(name, now, id)
  if (result.changes === 0) return null
  return getProject(id)
}

export function deleteProject(id: string): boolean {
  // 软删除：标记后物理移入回收目录（M1 先直接软删，回收站目录 M7 补）
  const result = getDb()
    .prepare('UPDATE projects SET deleted = 1 WHERE id = ? AND deleted = 0')
    .run(id)
  return result.changes > 0
}

export function getProject(id: string): ProjectMeta | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ? AND deleted = 0').get(id) as
    ProjectRow | undefined
  return row ? rowToMeta(row) : null
}

export function openProject(id: string): ProjectFile | null {
  const meta = getProject(id)
  if (!meta) return null
  const file = readProjectFile(id)
  if (!file) return null
  file.meta = meta
  return file
}

/**
 * 保存项目（图写入事务）。
 *
 * - expectedGraphVersion 提供原子乐观锁：以 project.json 内的 meta.graphVersion
 *   为准在同一同步代码块内完成"读取-校验-写入"，关闭服务层先读后写的竞态窗口。
 *   不匹配时抛 GraphVersionConflictError，文件保持原样。
 * - 写入顺序：tmp → 旧文件转 .bak → tmp 转正 → SQLite 更新。回滚按失败阶段
 *   精确撤销：tmp 写入失败只清 tmp；轮转失败不动主文件；转正/SQLite 失败才用
 *   .bak 恢复主文件。任何情况下都不会删除主文件上唯一有效的数据。
 */
export function saveProject(input: {
  id: string
  tldrawSnapshot?: unknown
  graph?: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
  expectedGraphVersion?: number
}): { graphVersion: number } | null {
  // project.json 的 rename 是原子的，但“读取版本 → 校验 → 写入”不是跨进程原子。
  // CLI/MCP 可能各自运行在独立 Electron 进程，所以用同目录的排他锁把整个临界区
  // 包起来。锁文件只在写入期间存在；异常路径也必须释放，避免永久阻塞。
  const lockPath = projectJsonPath(input.id) + '.write-lock'
  const lockFd = acquireProjectWriteLock(lockPath)

  try {
    return saveProjectUnlocked(input)
  } finally {
    closeSync(lockFd)
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath)
    } catch {
      // 锁文件清理失败时保留现场，下一次调用会明确报告占用而不会悄悄覆盖数据。
    }
  }
}

function saveProjectUnlocked(input: {
  id: string
  tldrawSnapshot?: unknown
  graph?: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
  expectedGraphVersion?: number
}): { graphVersion: number } | null {
  const meta = getProject(input.id)
  if (!meta) return null

  const path = projectJsonPath(input.id)
  const file = readProjectFile(input.id) ?? {
    version: 1 as const,
    meta: { ...meta, graphVersion: 0 },
    nodes: [],
    edges: [],
    groups: []
  }

  if (
    input.expectedGraphVersion !== undefined &&
    file.meta.graphVersion !== input.expectedGraphVersion
  ) {
    throw new GraphVersionConflictError(input.expectedGraphVersion, file.meta.graphVersion)
  }

  if (input.tldrawSnapshot !== undefined) file.tldrawSnapshot = input.tldrawSnapshot
  if (input.graph) {
    file.nodes = input.graph.nodes as ProjectFile['nodes']
    file.edges = input.graph.edges as ProjectFile['edges']
    file.groups = input.graph.groups as ProjectFile['groups']
  }

  const nextVersion = file.meta.graphVersion + 1
  const now = Date.now()
  file.meta = { ...file.meta, graphVersion: nextVersion, updatedAt: now }

  const tmp = path + '.tmp'
  const bak = path + '.bak'
  // 阶段标记（F01 修复）：回滚必须知道失败发生在哪一步，才能只撤销已落盘的变更。
  // 此前的固定回滚序列（path→tmp→删除 tmp）在 tmp 写入或轮转阶段失败时，
  // 会把主文件上唯一有效的数据移进 tmp 再删除，造成 project.json 整体丢失。
  let phase: 'write-tmp' | 'rotate-bak' | 'promote-tmp' | 'update-db' = 'write-tmp'
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
    phase = 'rotate-bak'
    if (existsSync(path)) renameSync(path, bak)
    phase = 'promote-tmp'
    renameSync(tmp, path)
    phase = 'update-db'
    getDb()
      .prepare('UPDATE projects SET updated_at = ?, graph_version = ? WHERE id = ?')
      .run(now, nextVersion, input.id)
  } catch (error) {
    // 分阶段回滚：rename 具备原子性（要么完成要么未动），phase 在每步成功后立即推进，
    // 因此各阶段的主文件/.bak 状态是确定的；只清理真正未提交的残留。
    try {
      if (phase === 'write-tmp') {
        // tmp 写入失败：主文件与 .bak 均未触碰，清掉可能半写的 tmp 即可。
        if (existsSync(tmp)) rmSync(tmp, { force: true })
      } else if (phase === 'rotate-bak') {
        // 轮转失败：path 仍在且完好，tmp 是未提交的新数据，直接丢弃。
        if (existsSync(tmp)) rmSync(tmp, { force: true })
        // 极端环境下若 path 意外缺失，从 bak 恢复最后一份完整数据。
        if (!existsSync(path) && existsSync(bak)) renameSync(bak, path)
      } else if (phase === 'promote-tmp') {
        // 转正失败：bak 持有旧主文件而 path 缺失；恢复 bak 并丢弃未提交的 tmp。
        if (existsSync(tmp)) rmSync(tmp, { force: true })
        if (!existsSync(path) && existsSync(bak)) renameSync(bak, path)
      } else {
        // SQLite 更新失败：文件已提交新版（path=新、bak=旧），回滚文件到旧版本。
        if (existsSync(path)) renameSync(path, tmp)
        if (existsSync(bak)) renameSync(bak, path)
        if (existsSync(tmp)) rmSync(tmp, { force: true })
      }
    } catch {
      // 回滚本身失败：保留 .bak/tmp 现场，交给下次读取的 .bak 回退逻辑兜底
    }
    throw error
  }

  return { graphVersion: nextVersion }
}

export function purgeProjectFiles(id: string): void {
  const dir = projectDir(id)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
