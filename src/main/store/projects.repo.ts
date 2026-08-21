// 项目仓库：SQLite 索引 + project.json 图数据（见《技术框架与规范》§9）
import { nanoid } from 'nanoid'
import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import type { ProjectFile, ProjectMeta } from '../../shared/types'
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

export function saveProject(input: {
  id: string
  tldrawSnapshot?: unknown
  graph?: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
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

  if (input.tldrawSnapshot !== undefined) file.tldrawSnapshot = input.tldrawSnapshot
  if (input.graph) {
    file.nodes = input.graph.nodes as ProjectFile['nodes']
    file.edges = input.graph.edges as ProjectFile['edges']
    file.groups = input.graph.groups as ProjectFile['groups']
  }

  const nextVersion = file.meta.graphVersion + 1
  const now = Date.now()
  file.meta = { ...file.meta, graphVersion: nextVersion, updatedAt: now }

  // 原子写：先临时文件再替换；旧版留 .bak
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
  if (existsSync(path)) {
    renameSync(path, path + '.bak')
  }
  renameSync(tmp, path)

  getDb()
    .prepare('UPDATE projects SET updated_at = ?, graph_version = ? WHERE id = ?')
    .run(now, nextVersion, input.id)

  return { graphVersion: nextVersion }
}

export function purgeProjectFiles(id: string): void {
  const dir = projectDir(id)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
