import { createHmac, timingSafeEqual } from 'node:crypto'
import { getDb } from '../store/db'
import * as projects from '../store/projects.repo'
import { AccessFailure } from './access-failure'
import { isGuiRunBusy } from './gui-busy'

export function isProjectTaskOccupied(id: string): boolean {
  const db = getDb()
  return !!(
    db
      .prepare(
        "SELECT 1 FROM flow_commands WHERE project_id=? AND state IN ('pending','unknown') LIMIT 1"
      )
      .get(id) ||
    db
      .prepare(
        "SELECT 1 FROM flow_agent_tasks WHERE project_id=? AND state IN ('ready','running','waiting','blocked') LIMIT 1"
      )
      .get(id) ||
    db.prepare('SELECT 1 FROM flow_coordination_scope WHERE project_id=? LIMIT 1').get(id) ||
    db
      .prepare(
        "SELECT 1 FROM tasks WHERE project_id=? AND status NOT IN ('completed','done','success','failed','cancelled') LIMIT 1"
      )
      .get(id) ||
    db
      .prepare(
        "SELECT 1 FROM external_runs WHERE project_id=? AND status IN ('accepted','running','cancel-requested') LIMIT 1"
      )
      .get(id)
  )
}

export function assertProjectHasNoActiveTasks(id: string): void {
  if (projects.hasRecoveryCopy(id)) throw new AccessFailure('RESOURCE_BUSY', 'recovery-ownership')
  if (isGuiRunBusy(id)) throw new AccessFailure('RESOURCE_BUSY', 'gui-run-occupancy')
  if (isProjectTaskOccupied(id)) throw new AccessFailure('RESOURCE_BUSY', 'task-occupancy')
}

function deleteSnapshot(id: string): {
  graphVersion: number
  impact: Record<
    'nodeCount' | 'edgeCount' | 'groupCount' | 'mediaCount' | 'mediaBytes' | 'libraryUsageCount',
    number
  >
} {
  const file = projects.openProject(id)
  if (!file) throw new AccessFailure('NOT_FOUND', 'read')
  const db = getDb()
  const media = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM media WHERE substr(path,1,length(?))=?'
    )
    .get(`projects/${id}/media/`, `projects/${id}/media/`) as { n: number; bytes: number }
  const usage = db
    .prepare('SELECT COUNT(*) AS n FROM library_usages WHERE project_id=?')
    .get(id) as { n: number }
  return {
    graphVersion: file.meta.graphVersion,
    impact: {
      nodeCount: file.nodes.length,
      edgeCount: file.edges.length,
      groupCount: file.groups.length,
      mediaCount: media.n,
      mediaBytes: media.bytes,
      libraryUsageCount: usage.n
    }
  }
}

export function buildImpactToken(
  dataStoreId: string,
  hmacKey: string,
  id: string,
  graphVersion: number,
  impact: unknown,
  expiresAt: number
): string {
  const payload = JSON.stringify({
    d: dataStoreId,
    p: id,
    v: graphVersion,
    i: impact,
    e: expiresAt
  })
  return `${expiresAt}.${createHmac('sha256', hmacKey).update(payload).digest('hex')}`
}

export interface ProjectDeleteContext {
  dataStoreId: string
  hmacKey: string
  activeProjectId: () => string | null
}

export function runProjectDeletePrecheck(id: string, ctx: ProjectDeleteContext): unknown {
  const snapshot = deleteSnapshot(id)
  const blockers: Array<'ACTIVE_PROJECT' | 'RECOVERY_COPY' | 'TASK_OCCUPANCY'> = []
  if (ctx.activeProjectId() === id) blockers.push('ACTIVE_PROJECT')
  if (projects.hasRecoveryCopy(id)) blockers.push('RECOVERY_COPY')
  if (isProjectTaskOccupied(id)) blockers.push('TASK_OCCUPANCY')
  if (blockers.length)
    return {
      projectId: id,
      graphVersion: snapshot.graphVersion,
      impact: snapshot.impact,
      blockers
    }
  const expiresAt = Date.now() + 600000
  return {
    projectId: id,
    graphVersion: snapshot.graphVersion,
    impact: snapshot.impact,
    blockers,
    impactToken: buildImpactToken(
      ctx.dataStoreId,
      ctx.hmacKey,
      id,
      snapshot.graphVersion,
      snapshot.impact,
      expiresAt
    ),
    expiresAt
  }
}

/** The signature binds instance, target, revision and impact; a mismatch of any
 * fact (tamper, expiry, revision or impact drift) requires a fresh precheck. */
export function runProjectDelete(
  id: string,
  token: string | undefined,
  ctx: ProjectDeleteContext
): unknown {
  if (!token) throw new AccessFailure('IMPACT_CONFIRM_REQUIRED', 'delete-admission')
  const [rawExpiry, supplied] = token.split('.')
  const expiresAt = Number(rawExpiry)
  if (!rawExpiry || !supplied || !Number.isInteger(expiresAt) || Date.now() > expiresAt)
    throw new AccessFailure('IMPACT_TOKEN_INVALID', 'delete-admission')
  const snapshot = deleteSnapshot(id)
  const expected = buildImpactToken(
    ctx.dataStoreId,
    ctx.hmacKey,
    id,
    snapshot.graphVersion,
    snapshot.impact,
    expiresAt
  ).split('.')[1]
  let signature: Buffer
  try {
    signature = Buffer.from(supplied, 'hex')
  } catch {
    throw new AccessFailure('IMPACT_TOKEN_INVALID', 'delete-admission')
  }
  const reference = Buffer.from(expected, 'hex')
  if (signature.length !== reference.length || !timingSafeEqual(signature, reference))
    throw new AccessFailure('IMPACT_TOKEN_INVALID', 'delete-admission')
  if (!projects.deleteProject(id)) throw new AccessFailure('NOT_FOUND', 'read')
  return { deleted: true, projectId: id, graphVersion: snapshot.graphVersion }
}
