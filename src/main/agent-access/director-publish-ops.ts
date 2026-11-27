import { parseDirectorProject, parseDirectorPublishRecord } from '../../shared/director-data'
import {
  PUBLISH_AUTHORIZATION_TTL_MS,
  PublishArtifactSchema,
  PublishHostResultSchema,
  type PublishMode
} from '../../shared/agent-access/publish'
import { buildProjectionShape } from '../../shared/agent-access/run-ops'
import * as projects from '../store/projects.repo'
import { AccessFailure } from './access-failure'
import { DesktopAccessError, type AccessDesktop } from './desktop'
import { assertProjectHasNoActiveTasks } from './project-delete-ops'
import {
  PublishLimitError,
  authorizePublishRequest,
  claimPublishRequest,
  completePublishRequest,
  createPublishRequest,
  denyPublishRequest,
  failPublishRequest,
  getPublishRequest
} from './publish'

export type DirectorPublishOperationId =
  | 'director.publish.prepare'
  | 'director.publish.status'
  | 'director.publish.continue'

export interface DirectorPublishOpsContext {
  activeProjectId: () => string | null
  desktop?: AccessDesktop
}

export async function runDirectorPublishOperation(
  ctx: DirectorPublishOpsContext,
  operationId: DirectorPublishOperationId,
  id: string,
  active: string | null | undefined,
  input: Record<string, unknown>,
  onMetadataCommitted: () => void,
  isMetadataCommitted: () => boolean
): Promise<unknown> {
  if (operationId === 'director.publish.status') {
    const row = getPublishRequest(input.publishRequestId as string)
    if (!row || row.project_id !== id) throw new AccessFailure('NOT_FOUND', 'publish-read')
    const artifact = PublishArtifactSchema.safeParse({
      mediaId: row.media_id ?? '',
      mediaPath: row.media_path ?? '',
      mime: row.media_mime ?? ''
    })
    return {
      projectId: row.project_id,
      publishRequestId: row.id,
      nodeId: row.node_id,
      mode: row.mode,
      shotId: row.shot_id,
      status: row.status,
      authorizationRequired: row.status === 'awaiting-authorization',
      expiresAt: row.expires_at,
      graphVersion: row.expected_graph_version,
      ...(artifact.success ? { artifact: artifact.data } : {}),
      ...(row.error ? { error: row.error } : {})
    }
  }

  if (id !== active || !ctx.desktop) {
    throw new AccessFailure(
      'ACTIVE_PROJECT_REQUIRED',
      'desktop-ownership',
      'project.open the target canvas first, then retry director.publish'
    )
  }

  if (operationId === 'director.publish.prepare') {
    const file = projects.openProject(id)
    if (!file) throw new AccessFailure('NOT_FOUND', 'read')
    if (file.meta.graphVersion !== input.expectedGraphVersion)
      throw new AccessFailure('REVISION_CONFLICT', 'precheck')
    const node = file.nodes.find((candidate) => candidate.id === input.nodeId)
    if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'precheck')
    if (node.type !== 'director')
      throw new AccessFailure('DIRECTOR_NODE_REQUIRED', 'precheck', String(node.type).slice(0, 40))
    const directorProject = parseDirectorProject(
      typeof node.params.config === 'string' ? node.params.config : ''
    )
    const shotId = (input.shotId as string | undefined) ?? directorProject.activeShotId
    if (!directorProject.shots.some((shot) => shot.id === shotId))
      throw new AccessFailure('SHOT_NOT_FOUND', 'precheck')
    const mode = (input.mode as PublishMode | undefined) ?? 'frame'
    let row
    try {
      row = createPublishRequest({
        projectId: id,
        nodeId: node.id,
        mode,
        shotId,
        expectedGraphVersion: file.meta.graphVersion
      })
    } catch (error) {
      if (error instanceof PublishLimitError)
        throw new AccessFailure('PUBLISH_REQUEST_LIMIT', 'precheck')
      throw error
    }
    void ctx.desktop
      .ask(
        {
          action: 'publish-authorize',
          projectId: id,
          nodeId: row.node_id,
          publishRequestId: row.id,
          publishMode: row.mode,
          shotId: row.shot_id,
          expectedGraphVersion: row.expected_graph_version
        },
        PUBLISH_AUTHORIZATION_TTL_MS
      )
      .then((reply) => {
        if (reply.authorized) authorizePublishRequest(row.id)
        else denyPublishRequest(row.id)
      })
      .catch(() => {
        // 宿主不可用：请求保持待授权，过期自然作废，不静默放行。
      })
    return {
      projectId: id,
      publishRequestId: row.id,
      nodeId: row.node_id,
      mode: row.mode,
      shotId: row.shot_id,
      status: row.status,
      authorizationRequired: true,
      expiresAt: row.expires_at,
      graphVersion: file.meta.graphVersion
    }
  }

  const row = getPublishRequest(input.publishRequestId as string)
  if (!row || row.project_id !== id) throw new AccessFailure('NOT_FOUND', 'publish-request')
  const existing = PublishArtifactSchema.safeParse({
    mediaId: row.media_id ?? '',
    mediaPath: row.media_path ?? '',
    mime: row.media_mime ?? ''
  })
  if (row.status === 'completed') {
    if (!existing.success) throw new AccessFailure('STORAGE_INCONSISTENT', 'publish-verify')
    return {
      projectId: id,
      publishRequestId: row.id,
      nodeId: row.node_id,
      mode: row.mode,
      shotId: row.shot_id,
      status: 'completed',
      graphVersion: row.expected_graph_version,
      saved: true,
      artifact: existing.data
    }
  }
  if (row.status === 'denied') {
    throw new AccessFailure('PUBLISH_DENIED', 'publish-admission', 'the user denied this publish request')
  }
  if (row.status === 'expired') {
    throw new AccessFailure(
      'PUBLISH_AUTHORIZATION_EXPIRED',
      'publish-admission',
      'authorization window elapsed; prepare a new request'
    )
  }
  if (row.status === 'failed') {
    throw new AccessFailure('PUBLISH_FAILED', 'publish-admission', row.error ?? undefined)
  }
  if (row.status === 'executing') {
    throw new AccessFailure('RESOURCE_BUSY', 'publish-admission')
  }
  if (row.status !== 'authorized') {
    throw new AccessFailure(
      'PUBLISH_NOT_AUTHORIZED',
      'publish-admission',
      'a human must authorize this publish request in the GUI first'
    )
  }

  const file = projects.openProject(id)
  if (!file) throw new AccessFailure('NOT_FOUND', 'read')
  if (
    file.meta.graphVersion !== input.expectedGraphVersion ||
    row.expected_graph_version !== input.expectedGraphVersion
  )
    throw new AccessFailure(
      'REVISION_CONFLICT',
      'publish-admission',
      'canvas changed after prepare; prepare a new publish request'
    )
  const node = file.nodes.find((candidate) => candidate.id === row.node_id)
  if (!node || node.type !== 'director')
    throw new AccessFailure('DIRECTOR_NODE_REQUIRED', 'publish-admission')
  if (!claimPublishRequest(row.id))
    throw new AccessFailure('RESOURCE_BUSY', 'publish-admission')
  try {
    const reply = await ctx.desktop.run(
      {
        action: 'director-publish',
        projectId: id,
        nodeId: row.node_id,
        publishRequestId: row.id,
        publishMode: row.mode,
        shotId: row.shot_id,
        expectedGraphVersion: input.expectedGraphVersion as number
      },
      (version) => {
        if (ctx.activeProjectId() !== id)
          throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
        assertProjectHasNoActiveTasks(id)
        const admitted = projects.openProject(id)
        if (!admitted || admitted.meta.graphVersion !== version)
          throw new AccessFailure('REVISION_CONFLICT', 'publish-admission')
        onMetadataCommitted()
        return admitted.meta
      },
      60000
    )
    const published = PublishHostResultSchema.safeParse(reply.result)
    if (!published.success)
      throw new AccessFailure('STORAGE_INCONSISTENT', 'publish-verify', 'host result invalid')
    const savedFile = projects.openProject(id)
    const projection = savedFile ? buildProjectionShape(savedFile, row.node_id) : null
    let persisted: ReturnType<typeof parseDirectorPublishRecord> = null
    try {
      persisted = parseDirectorPublishRecord(
        typeof projection?.meta?.nodeResult === 'string'
          ? JSON.parse(String(projection.meta.nodeResult))
          : null
      )
    } catch {
      persisted = null
    }
    const media = row.mode === 'frame' ? persisted?.frame : persisted?.video
    if (media?.mediaId !== published.data.mediaId)
      throw new AccessFailure(
        'STORAGE_INCONSISTENT',
        'publish-verify',
        'publish record not persisted'
      )
    completePublishRequest(row.id, {
      mediaId: published.data.mediaId,
      mediaPath: published.data.mediaPath,
      mime: published.data.mime
    })
    return {
      projectId: id,
      publishRequestId: row.id,
      nodeId: row.node_id,
      mode: row.mode,
      shotId: published.data.shotId,
      status: 'completed',
      graphVersion: reply.graphVersion,
      saved: true,
      artifact: {
        mediaId: published.data.mediaId,
        mediaPath: published.data.mediaPath,
        mime: published.data.mime
      }
    }
  } catch (error) {
    if (isMetadataCommitted()) {
      failPublishRequest(row.id, 'PUBLISH_OUTCOME_UNKNOWN')
      throw error
    }
    if (error instanceof DesktopAccessError && !error.unknownOutcome) {
      failPublishRequest(row.id, error.code)
      throw new AccessFailure(error.code, 'publish-handshake', error.detail)
    }
    if (error instanceof AccessFailure) {
      failPublishRequest(row.id, error.code)
      throw error
    }
    failPublishRequest(row.id, 'PUBLISH_OUTCOME_UNKNOWN')
    throw error
  }
}
