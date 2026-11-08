import { nanoid } from 'nanoid'
import { getDb } from '../store/db'
import {
  PUBLISH_AUTHORIZATION_TTL_MS,
  PUBLISH_MAX_OPEN_REQUESTS,
  PUBLISH_REQUEST_PREFIX,
  type PublishMode,
  type PublishStatus
} from '../../shared/agent-access/publish'

/**
 * 导演台发布授权账本。
 *
 * 状态机（单向，唯一终态拥有者是 main）：
 *   awaiting-authorization → authorized | denied | expired
 *   authorized → executing → completed | failed
 * 已 revoked（denied/expired/failed）的请求不再接受 continue；completed 只做幂等回执。
 * 这里不写画布：渲染与正式结果一律由权威宿主（renderer）用 GUI 同一发布服务完成。
 */
export interface PublishRequestRow {
  id: string
  project_id: string
  node_id: string
  mode: PublishMode
  shot_id: string
  expected_graph_version: number
  status: PublishStatus
  error: string | null
  media_id: string | null
  media_path: string | null
  media_mime: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

const OPEN_STATUSES: ReadonlyArray<PublishStatus> = [
  'awaiting-authorization',
  'authorized',
  'executing'
]

export function createPublishRequest(input: {
  projectId: string
  nodeId: string
  mode: PublishMode
  shotId: string
  expectedGraphVersion: number
}): PublishRequestRow {
  const db = getDb()
  const now = Date.now()
  // 过期请求先结算，避免它们长期占用开放额度。
  db.prepare(
    "UPDATE director_publish_requests SET status='expired', updated_at=? WHERE status='awaiting-authorization' AND expires_at<=?"
  ).run(now, now)
  const open = db
    .prepare(
      `SELECT COUNT(*) AS n FROM director_publish_requests WHERE project_id=? AND node_id=? AND status IN (${OPEN_STATUSES.map(
        () => '?'
      ).join(',')})`
    )
    .get(input.projectId, input.nodeId, ...OPEN_STATUSES) as { n: number }
  if (open.n >= PUBLISH_MAX_OPEN_REQUESTS) throw new PublishLimitError()
  // 同一节点只允许一条待授权请求：人只需要处理最新一次申请。
  db.prepare(
    "UPDATE director_publish_requests SET status='expired', updated_at=? WHERE project_id=? AND node_id=? AND status IN ('awaiting-authorization','authorized')"
  ).run(now, input.projectId, input.nodeId)
  const row: PublishRequestRow = {
    id: `${PUBLISH_REQUEST_PREFIX}${nanoid(20)}`,
    project_id: input.projectId,
    node_id: input.nodeId,
    mode: input.mode,
    shot_id: input.shotId,
    expected_graph_version: input.expectedGraphVersion,
    status: 'awaiting-authorization',
    error: null,
    media_id: null,
    media_path: null,
    media_mime: null,
    created_at: now,
    updated_at: now,
    expires_at: now + PUBLISH_AUTHORIZATION_TTL_MS
  }
  db.prepare(
    `INSERT INTO director_publish_requests
      (id, project_id, node_id, mode, shot_id, expected_graph_version, status, error, media_id, media_path, media_mime, created_at, updated_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id,
    row.project_id,
    row.node_id,
    row.mode,
    row.shot_id,
    row.expected_graph_version,
    row.status,
    row.error,
    row.media_id,
    row.media_path,
    row.media_mime,
    row.created_at,
    row.updated_at,
    row.expires_at
  )
  return row
}

export class PublishLimitError extends Error {
  constructor() {
    super('PUBLISH_REQUEST_LIMIT')
  }
}

export function getPublishRequest(id: string): PublishRequestRow | null {
  const row = getDb()
    .prepare('SELECT * FROM director_publish_requests WHERE id=?')
    .get(id) as PublishRequestRow | undefined
  if (!row) return null
  // 惰性结算过期：等待人工授权的请求过期即作废，不自动续期。
  if (row.status === 'awaiting-authorization' && row.expires_at <= Date.now()) {
    updateStatus(row.id, 'expired')
    return { ...row, status: 'expired' }
  }
  return row
}

function updateStatus(id: string, status: PublishStatus, error: string | null = null): void {
  getDb()
    .prepare('UPDATE director_publish_requests SET status=?, error=?, updated_at=? WHERE id=?')
    .run(status, error, Date.now(), id)
}

/** 人类在 GUI 确认后由 main 记录授权；只能从待授权态前进。 */
export function authorizePublishRequest(id: string): PublishRequestRow | null {
  const row = getPublishRequest(id)
  if (!row || row.status !== 'awaiting-authorization') return row
  updateStatus(id, 'authorized')
  return { ...row, status: 'authorized' }
}

export function denyPublishRequest(id: string): PublishRequestRow | null {
  const row = getPublishRequest(id)
  if (!row || row.status !== 'awaiting-authorization') return row
  updateStatus(id, 'denied', 'PUBLISH_DENIED_BY_USER')
  return { ...row, status: 'denied', error: 'PUBLISH_DENIED_BY_USER' }
}

/** 原子领取执行权：并发 continue 只有一个能进入执行，另一个按占用拒绝。 */
export function claimPublishRequest(id: string): boolean {
  const row = getPublishRequest(id)
  if (!row || row.status !== 'authorized') return false
  const changed = getDb()
    .prepare(
      "UPDATE director_publish_requests SET status='executing', updated_at=? WHERE id=? AND status='authorized'"
    )
    .run(Date.now(), id)
  return changed.changes === 1
}

export function failPublishRequest(id: string, error: string): void {
  updateStatus(id, 'failed', error.slice(0, 120))
}

export function completePublishRequest(
  id: string,
  artifact: { mediaId: string; mediaPath: string; mime: string }
): void {
  getDb()
    .prepare(
      "UPDATE director_publish_requests SET status='completed', error=NULL, media_id=?, media_path=?, media_mime=?, updated_at=? WHERE id=?"
    )
    .run(artifact.mediaId, artifact.mediaPath, artifact.mime, Date.now(), id)
}

/** 崩溃遗留的执行中请求按 unknown 核对语义处理：不自动重发，等外部重新 prepare。 */
export function recoverAbandonedPublishRequests(): void {
  getDb()
    .prepare(
      "UPDATE director_publish_requests SET status='failed', error='PUBLISH_OUTCOME_UNKNOWN', updated_at=? WHERE status='executing'"
    )
    .run(Date.now())
}
