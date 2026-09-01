/**
 * DesktopProjectStore
 *
 * CLI/MCP 与 Electron 桌面端共享同一个 SQLite 项目索引、project.json 和媒体索引。
 * 写入走完整图事务：saveGraph 会把 nodes/edges/groups 同步进 tldraw 快照
 * （node-card / arrow / binding），并以 expectedGraphVersion 做原子乐观锁，
 * 保证 Agent 写入的内容在画布上可见、不会被下一次画布保存静默覆盖。
 */

import type {
  CanvasEdge,
  CanvasNode,
  GroupDecl,
  MediaAsset,
  ProjectFile,
  ProjectMeta
} from '@shared/types'
import { syncGraphSnapshot } from '@shared/graph-snapshot-sync'
import {
  createProject,
  deleteProject,
  listProjects,
  openProject,
  saveProject
} from '../../main/store/projects.repo'
import { listMedia } from '../../main/store/media.repo'
import {
  createRun,
  updateRun,
  getRun,
  listRuns,
  createRunArtifact,
  listRunArtifacts
} from '../../main/store/runs.repo'
import type { ProjectStore, RunRecord, RunUpdatePatch, RunStatus, RunArtifactRecord } from '../types'

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
    const file = openProject(projectId)
    if (!file) throw new Error(`项目不存在: ${projectId}`)
    const { snapshot } = syncGraphSnapshot(file.tldrawSnapshot, graph)
    // 版本冲突以 GraphVersionConflictError 形式抛出，由服务层映射为 REVISION_CONFLICT
    const saved = saveProject({
      id: projectId,
      graph,
      tldrawSnapshot: snapshot,
      expectedGraphVersion: options?.expectedGraphVersion
    })
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

  // ── Run / Artifact 持久化 ────────────────────────────────

  async createRun(record: Omit<RunRecord, 'createdAt'>): Promise<RunRecord> {
    return createRun(record)
  }

  async updateRun(runId: string, patch: RunUpdatePatch): Promise<RunRecord | null> {
    return updateRun(runId, patch)
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return getRun(runId)
  }

  async listRuns(projectId: string, filter?: { status?: RunStatus }): Promise<RunRecord[]> {
    return listRuns(projectId, filter)
  }

  async createRunArtifact(
    record: Omit<RunArtifactRecord, 'artifactId' | 'createdAt'>
  ): Promise<RunArtifactRecord> {
    return createRunArtifact(record)
  }

  async listRunArtifacts(runId: string): Promise<RunArtifactRecord[]> {
    return listRunArtifacts(runId)
  }
}
