/**
 * FileProjectStore — 基于文件系统的 ProjectStore 实现
 *
 * 直接读写 project.json，不依赖 Electron 主进程或 tldraw。
 * 用于 CLI 和 MCP 场景的无界面数据访问。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import type {
  CanvasNode,
  CanvasEdge,
  GroupDecl,
  ProjectMeta,
  ProjectFile,
  MediaAsset
} from '@shared/types'
import { syncGraphSnapshot, GraphVersionConflictError } from '@shared/graph-snapshot-sync'
import type { ProjectStore, RunRecord, RunUpdatePatch, RunStatus, RunArtifactRecord } from '../types'

interface FileStoreOptions {
  /** 数据根目录（包含 projects/ 子目录） */
  dataDir: string
}

export class FileProjectStore implements ProjectStore {
  private projectsDir: string
  /** 内存缓存：projectId → ProjectFile */
  private cache = new Map<string, ProjectFile>()
  /** 内存 Run 存储（测试用） */
  private runs = new Map<string, RunRecord>()
  /** 内存 Artifact 存储（测试用） */
  private runArtifacts: RunArtifactRecord[] = []

  constructor(options: FileStoreOptions) {
    this.projectsDir = join(options.dataDir, 'projects')
  }

  // ── 项目操作 ─────────────────────────────────────────────

  async listProjects(): Promise<ProjectMeta[]> {
    this.ensureProjectsDir()
    const dirs = readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)

    const metas: ProjectMeta[] = []
    for (const dir of dirs) {
      const file = this.readProjectFile(dir)
      if (file) metas.push(file.meta)
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    return metas
  }

  async getProject(id: string): Promise<ProjectFile | null> {
    if (!isSafeProjectId(id)) return null
    return this.readProjectFile(id)
  }

  async createProject(name: string): Promise<ProjectMeta> {
    this.ensureProjectsDir()
    const id = nanoid(12)
    const now = Date.now()
    const dir = join(this.projectsDir, id, 'media')
    mkdirSync(dir, { recursive: true })

    const meta: ProjectMeta = { id, name, createdAt: now, updatedAt: now, graphVersion: 0 }
    const file: ProjectFile = {
      version: 1,
      meta,
      nodes: [],
      edges: [],
      groups: []
    }
    this.writeProjectFile(id, file)
    this.cache.set(id, file)
    return meta
  }

  async deleteProject(id: string): Promise<boolean> {
    if (!isSafeProjectId(id)) return false
    const file = this.readProjectFile(id)
    if (!file) return false
    // 独立文件存储没有项目索引，不能谎称已删除；它仅在测试/迁移场景使用。
    // 外部 CLI/MCP 已改为 DesktopProjectStore，由 SQLite 完成软删除。
    this.cache.delete(id)
    return false
  }

  // ── 图数据操作 ───────────────────────────────────────────

  async getNodes(projectId: string): Promise<CanvasNode[]> {
    const file = await this.getProject(projectId)
    return file?.nodes ?? []
  }

  async getEdges(projectId: string): Promise<CanvasEdge[]> {
    const file = await this.getProject(projectId)
    return file?.edges ?? []
  }

  async getGroups(projectId: string): Promise<GroupDecl[]> {
    const file = await this.getProject(projectId)
    return file?.groups ?? []
  }

  async saveGraph(
    projectId: string,
    graph: { nodes: CanvasNode[]; edges: CanvasEdge[]; groups: GroupDecl[] },
    options?: { expectedGraphVersion?: number }
  ): Promise<{ graphVersion: number }> {
    if (!isSafeProjectId(projectId)) throw new Error('非法项目 ID')
    const file = await this.getProject(projectId)
    if (!file) throw new Error(`项目不存在: ${projectId}`)
    if (
      options?.expectedGraphVersion !== undefined &&
      file.meta.graphVersion !== options.expectedGraphVersion
    ) {
      throw new GraphVersionConflictError(options.expectedGraphVersion, file.meta.graphVersion)
    }

    const { snapshot } = syncGraphSnapshot(file.tldrawSnapshot, graph)
    file.nodes = graph.nodes
    file.edges = graph.edges
    file.groups = graph.groups
    file.tldrawSnapshot = snapshot

    const nextVersion = file.meta.graphVersion + 1
    file.meta.graphVersion = nextVersion
    file.meta.updatedAt = Date.now()

    this.writeProjectFile(projectId, file)
    this.cache.set(projectId, file)

    return { graphVersion: nextVersion }
  }

  // ── 媒体资产 ─────────────────────────────────────────────

  async listArtifacts(): Promise<MediaAsset[]> {
    // FileProjectStore 暂不支持完整的媒体索引
    // 生产环境应通过 IPC 或数据库查询
    return []
  }

  async getArtifact(): Promise<MediaAsset | null> {
    // FileProjectStore 暂不支持单个资产查询
    return null
  }

  // ── Run / Artifact 持久化（内存实现，供测试使用） ────────

  async createRun(record: Omit<RunRecord, 'createdAt'>): Promise<RunRecord> {
    const full: RunRecord = { ...record, createdAt: Date.now() }
    this.runs.set(full.runId, full)
    return full
  }

  async updateRun(runId: string, patch: RunUpdatePatch): Promise<RunRecord | null> {
    const existing = this.runs.get(runId)
    if (!existing) return null
    const updated: RunRecord = { ...existing, ...patch }
    this.runs.set(runId, updated)
    return updated
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null
  }

  async listRuns(projectId: string, filter?: { status?: RunStatus }): Promise<RunRecord[]> {
    return Array.from(this.runs.values())
      .filter((r) => r.projectId === projectId)
      .filter((r) => !filter?.status || r.status === filter.status)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async createRunArtifact(
    record: Omit<RunArtifactRecord, 'artifactId' | 'createdAt'>
  ): Promise<RunArtifactRecord> {
    const full: RunArtifactRecord = {
      ...record,
      artifactId: nanoid(12),
      createdAt: Date.now()
    }
    this.runArtifacts.push(full)
    return full
  }

  async listRunArtifacts(runId: string): Promise<RunArtifactRecord[]> {
    return this.runArtifacts.filter((a) => a.runId === runId)
  }

  // ── 内部方法 ─────────────────────────────────────────────

  private ensureProjectsDir(): void {
    if (!existsSync(this.projectsDir)) {
      mkdirSync(this.projectsDir, { recursive: true })
    }
  }

  private projectJsonPath(id: string): string {
    if (!isSafeProjectId(id)) throw new Error('非法项目 ID')
    return join(this.projectsDir, id, 'project.json')
  }

  private readProjectFile(id: string): ProjectFile | null {
    // 先查缓存
    const cached = this.cache.get(id)
    if (cached) return cached

    const path = this.projectJsonPath(id)
    // 尝试主文件和 .bak
    for (const p of [path, path + '.bak']) {
      if (!existsSync(p)) continue
      try {
        const file = JSON.parse(readFileSync(p, 'utf-8')) as ProjectFile
        this.cache.set(id, file)
        return file
      } catch {
        continue
      }
    }
    return null
  }

  private writeProjectFile(id: string, file: ProjectFile): void {
    const path = this.projectJsonPath(id)
    // 原子写：先临时文件再替换
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
    if (existsSync(path)) {
      renameSync(path, path + '.bak')
    }
    renameSync(tmp, path)
  }

  /** 清除内存缓存（测试用） */
  invalidateCache(projectId?: string): void {
    if (projectId) {
      this.cache.delete(projectId)
    } else {
      this.cache.clear()
    }
  }
}

/** projectId 永远来自 nanoid 或受控数据库，禁止进入路径分隔符或父目录。 */
function isSafeProjectId(id: string): boolean {
  return /^[A-Za-z0-9_-]{6,64}$/.test(id)
}
