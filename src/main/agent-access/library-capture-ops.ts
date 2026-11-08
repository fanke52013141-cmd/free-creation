// F7 收尾：资源捕获（画布 → 资源库）的外部实现。
//
// 唯一实现：复用 `library.repo` 的 captureProjectMedia / captureProjectNodes（GUI 同一服务），
// 本模块只做外部边界——**校验节点与媒体的项目归属**，防止外部拿别的项目的 ID 伪造采集。
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { captureProjectMedia, captureProjectNodes } from '../store/library.repo'
import { listMedia } from '../store/media.repo'
import { openProject } from '../store/projects.repo'
import { DesktopAccessError } from './desktop'

export const LIBRARY_CAPTURE_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'library.captureProjectMedia',
  'library.captureProjectNodes'
] as AccessOperationId[])

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

/** 统一回执：只给创建结果，不返回组件正文或媒体路径。 */
function capturedDto(detail: {
  id: string
  latestRevisionId: string | null
  revisionNumber: number
  title: string
  components: unknown[]
}): {
  resourceId: string
  revisionId: string
  revisionNumber: number
  title: string
  componentCount: number
} {
  // 资源刚创建必然有 latestRevisionId；缺失说明存储异常，如实报错而不是编一个。
  if (!detail.latestRevisionId) refuse('STORAGE_INCONSISTENT', 'missingRevision')
  return {
    resourceId: detail.id,
    revisionId: detail.latestRevisionId,
    revisionNumber: detail.revisionNumber,
    title: detail.title.slice(0, 180),
    componentCount: detail.components.length
  }
}

export function runLibraryCaptureOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>
): unknown {
  const projectId = input.projectId as string
  const file = openProject(projectId)
  if (!file) refuse('NOT_FOUND', 'projectId')

  if (operationId === 'library.captureProjectMedia') {
    const mediaId = input.mediaId as string
    // 先做归属校验：媒体必须属于该项目（避免跨项目读取他人素材）。
    if (!listMedia(projectId).some((asset) => asset.id === mediaId))
      refuse('MEDIA_NOT_FOUND', mediaId)
    try {
      return capturedDto(
        captureProjectMedia({
          projectId,
          mediaId,
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {})
        })
      )
    } catch (error) {
      refuse('CAPTURE_FAILED', error instanceof Error ? error.message.slice(0, 120) : undefined)
    }
  }

  // library.captureProjectNodes：逐个校验节点真实存在、类型一致、媒体属于本项目。
  const nodes = input.nodes as Array<{
    nodeId: string
    title: string
    nodeType: string
    slotId?: string
    text?: string
    mediaId?: string
    mediaMime?: string
  }>
  const projectMedia = new Set(listMedia(projectId).map((asset) => asset.id))
  for (const node of nodes) {
    const persisted = file.nodes.find((candidate) => candidate.id === node.nodeId)
    if (!persisted) refuse('NODE_NOT_FOUND', node.nodeId.slice(0, 60))
    // 类型必须与持久化数据一致：外部不能把文本节点谎报成图片节点混进资源。
    if (persisted.type !== node.nodeType)
      refuse('NODE_TYPE_MISMATCH', `${node.nodeId.slice(0, 40)}:${String(persisted.type).slice(0, 40)}`)
    if (node.mediaId && !projectMedia.has(node.mediaId))
      refuse('MEDIA_NOT_FOUND', node.mediaId)
  }
  try {
    return capturedDto(
      captureProjectNodes({
        projectId,
        title: input.title as string,
        ...(typeof input.folderId === 'string' ? { folderId: input.folderId } : {}),
        ...(typeof input.resourceId === 'string' ? { resourceId: input.resourceId } : {}),
        ...(typeof input.baseRevisionId === 'string'
          ? { baseRevisionId: input.baseRevisionId }
          : {}),
        ...(typeof input.changeNote === 'string' ? { changeNote: input.changeNote } : {}),
        nodes
      })
    )
  } catch (error) {
    refuse('CAPTURE_FAILED', error instanceof Error ? error.message.slice(0, 120) : undefined)
  }
}
