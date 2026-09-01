/**
 * DesktopProjectStore
 *
 * CLI/MCP 与 Electron 桌面端共享同一个 SQLite 项目索引、project.json 和媒体索引。
 * 它刻意不伪造 tldraw 快照：写入能力仍由入口层显式开关保护，直到画布快照事务
 * 完整接入；读取、校验和媒体查询已经与桌面端保持同源。
 */

import type {
  CanvasEdge,
  CanvasNode,
  GroupDecl,
  MediaAsset,
  ProjectFile,
  ProjectMeta
} from '@shared/types'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  openProject,
  saveProject
} from '../../main/store/projects.repo'
import { listMedia } from '../../main/store/media.repo'
import type { ProjectStore } from '../types'

export class DesktopProjectStore implements ProjectStore {
  async listProjects(): Promise<ProjectMeta[]> {
    return listProjects()
  }

  async getProject(id: string): Promise<ProjectFile | null> {
    return openProject(id)
  }

  async createProject(name: string): Promise<ProjectMeta> {
    return createProject(name)
  }

  async deleteProject(id: string): Promise<boolean> {
    return deleteProject(id)
  }

  async getNodes(projectId: string): Promise<CanvasNode[]> {
    return (openProject(projectId)?.nodes ?? []).map((node) => ({ ...node }))
  }

  async getEdges(projectId: string): Promise<CanvasEdge[]> {
    return (openProject(projectId)?.edges ?? []).map((edge) => ({ ...edge }))
  }

  async getGroups(projectId: string): Promise<GroupDecl[]> {
    return (openProject(projectId)?.groups ?? []).map((group) => ({ ...group }))
  }

  async saveGraph(
    projectId: string,
    graph: { nodes: CanvasNode[]; edges: CanvasEdge[]; groups: GroupDecl[] },
    options?: { expectedGraphVersion?: number }
  ): Promise<{ graphVersion: number }> {
    const current = getProject(projectId)
    if (!current) throw new Error(`项目不存在: ${projectId}`)
    if (
      options?.expectedGraphVersion !== undefined &&
      current.graphVersion !== options.expectedGraphVersion
    ) {
      throw new Error(
        `项目版本冲突：期望 ${options.expectedGraphVersion}，当前 ${current.graphVersion}`
      )
    }
    const saved = saveProject({ id: projectId, graph })
    if (!saved) throw new Error(`项目保存失败: ${projectId}`)
    return saved
  }

  async listArtifacts(projectId: string): Promise<MediaAsset[]> {
    return listMedia(projectId)
  }

  async getArtifact(assetId: string): Promise<MediaAsset | null> {
    for (const project of listProjects()) {
      const match = listMedia(project.id).find((asset) => asset.id === assetId)
      if (match) return match
    }
    return null
  }
}
