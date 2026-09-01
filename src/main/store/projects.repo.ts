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
  statSync
} from 'fs'
import { join } from 'path'
import type { ProjectFile, ProjectMeta } from '../../shared/types'
import {
  GraphVersionConflictError,
  GraphWriteInProgressError
} from '../../shared/graph-snapshot-sync'
import { getDb, getProjectsDir } from './db'

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

export function createProject(name: string): ProjectMeta {
  const id = nanoid(12)
  const now = Date.now()
  mkdirSync(join(projectDir(id), 'media'), { recursive: true })

  const file: ProjectFile = {
    version: 1,
    meta: { id, name, createdAt: now, updatedAt: now, graphVersion: 0 },
    nodes: [],
    edges: [],
    groups: []
  }
  writeFileSync(projectJsonPath(id), JSON.stringify(file, null, 2), 'utf-8')

  getDb()
    .prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, graph_version) VALUES (?, ?, ?, ?, 0)'
    )
    .run(id, name, now, now)

  return { id, name, createdAt: now, updatedAt: now, graphVersion: 0 }
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
 * - 写入顺序：tmp → 旧文件转 .bak → tmp 转正 → SQLite 更新。任何一步失败都会
 *   尽力把 .bak 恢复为主文件，保证图数据与快照不会停留在半提交状态。
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
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
    if (existsSync(path)) renameSync(path, bak)
    renameSync(tmp, path)
    getDb()
      .prepare('UPDATE projects SET updated_at = ?, graph_version = ? WHERE id = ?')
      .run(now, nextVersion, input.id)
  } catch (error) {
    // 回滚：把最后一份完整数据恢复为主文件，清理事务残留
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
      if (existsSync(path)) renameSync(path, tmp)
      if (existsSync(bak)) renameSync(bak, path)
      if (existsSync(tmp)) rmSync(tmp, { force: true })
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
