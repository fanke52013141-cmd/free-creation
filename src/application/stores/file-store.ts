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
import type { ProjectStore } from '../types'

interface FileStoreOptions {
  /** 数据根目录（包含 projects/ 子目录） */
  dataDir: string
}

export class FileProjectStore implements ProjectStore {
  private projectsDir: string
  /** 内存缓存：projectId → ProjectFile */
  private cache = new Map<string, ProjectFile>()

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
    // 软删除：标记为已删除（与 SQLite 方案对齐）
    const file = this.readProjectFile(id)
    if (!file) return false
    // FileProjectStore 无 SQLite 索引，直接保留文件但从缓存移除
    this.cache.delete(id)
    return true
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
    graph: { nodes: CanvasNode[]; edges: CanvasEdge[]; groups: GroupDecl[] }
  ): Promise<{ graphVersion: number }> {
    const file = await this.getProject(projectId)
    if (!file) throw new Error(`项目不存在: ${projectId}`)

    file.nodes = graph.nodes
    file.edges = graph.edges
    file.groups = graph.groups

    const nextVersion = file.meta.graphVersion + 1
    file.meta.graphVersion = nextVersion
    file.meta.updatedAt = Date.now()

    this.writeProjectFile(projectId, file)
    this.cache.set(projectId, file)

    return { graphVersion: nextVersion }
  }

  // ── 媒体资产 ─────────────────────────────────────────────

  async listArtifacts(_projectId: string): Promise<MediaAsset[]> {
    // FileProjectStore 暂不支持完整的媒体索引
    // 生产环境应通过 IPC 或数据库查询
    return []
  }

  async getArtifact(_assetId: string): Promise<MediaAsset | null> {
    // FileProjectStore 暂不支持单个资产查询
    return null
  }

  // ── 内部方法 ─────────────────────────────────────────────

  private ensureProjectsDir(): void {
    if (!existsSync(this.projectsDir)) {
      mkdirSync(this.projectsDir, { recursive: true })
    }
  }

  private projectJsonPath(id: string): string {
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
