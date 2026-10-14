import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaAsset } from '../../shared/types'
import { getDataDir, getDb } from '../store/db'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import type { GatewayDiagnosticsContext } from '../../shared/contracts'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { acquireProcessLock, type ProcessLock } from '../store/process-lock'

interface Receipt {
  version: 1
  identity: string
  phase: 'reserved' | 'prepared' | 'committed'
  digest?: string
  size?: number
}
interface Task {
  id: string
  project_id: string
  provider_id: string
  model_id: string
  node_id: string
  input: string | null
  output: string | null
}
const active = new Map<string, Promise<MediaAsset>>()
const fail = (): never => {
  throw new Error('VIDEO_MATERIALIZATION_CONFLICT')
}
function task(taskId: string, projectId: string): Task {
  const row = getDb()
    .prepare("SELECT * FROM tasks WHERE id=? AND project_id=? AND kind='video'")
    .get(taskId, projectId) as Task | undefined
  if (!row || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return fail()
  return row
}
function identity(row: Task): string {
  const input = JSON.parse(row.input ?? '{}')
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
  const fixedInput = { ...input }
  delete fixedInput.cancelRequested
  // Stop intent is mutable; submission and supplier identity are not.
  return createHash('sha256')
    .update(
      canonicalFlowJson([
        row.id,
        row.project_id,
        row.provider_id,
        row.model_id,
        row.node_id,
        fixedInput
      ])
    )
    .digest('hex')
}
function output(row: Task): Record<string, unknown> {
  const value = JSON.parse(row.output ?? '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value
}
function receipt(row: Task): Receipt | null {
  const raw = output(row).videoMaterialization
  if (raw === undefined) return null
  const value = raw as Receipt
  const mediaId = output(row).mediaId
  if (
    !value ||
    value.version !== 1 ||
    value.identity !== identity(row) ||
    (mediaId !== undefined && mediaId !== `video-${value.identity}`) ||
    !['reserved', 'prepared', 'committed'].includes(value.phase) ||
    (value.phase !== 'reserved' &&
      (!/^[a-f0-9]{64}$/.test(value.digest ?? '') ||
        !Number.isSafeInteger(value.size) ||
        value.size! <= 0))
  )
    return fail()
  return value
}
async function fingerprint(path: string): Promise<{ digest: string; size: number }> {
  const info = await stat(path)
  if (!info.isFile() || info.size <= 0 || info.size > 2 * 1024 * 1024 * 1024) return fail()
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { digest: hash.digest('hex'), size: info.size }
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function paths(
  projectId: string,
  value: Receipt
): { mediaId: string; relative: string; target: string; staging: string } {
  const mediaId = `video-${value.identity}`
  const relative = `projects/${projectId}/media/${mediaId}.mp4`
  return {
    mediaId,
    relative,
    target: join(getDataDir(), relative),
    staging: join(getDataDir(), 'video-recovery', `${value.identity}.part`)
  }
}
async function commit(
  taskId: string,
  projectId: string,
  value: Receipt,
  lock: ProcessLock
): Promise<MediaAsset> {
  const locations = paths(projectId, value)
  const source = (await exists(locations.target)) ? locations.target : locations.staging
  const found = await fingerprint(source)
  if (found.digest !== value.digest || found.size !== value.size) return fail()
  if (source !== locations.target) {
    await mkdir(join(getDataDir(), `projects/${projectId}/media`), { recursive: true })
    lock.assertOwned()
    if (JSON.parse(task(taskId, projectId).input ?? '{}').cancelRequested)
      throw new Error('VIDEO_MATERIALIZATION_STOPPED')
    await rename(source, locations.target)
  }
  const db = getDb()
  return db.transaction((): MediaAsset => {
    lock.assertOwned()
    const row = task(taskId, projectId)
    // Stop can arrive while hashing, creating directories or promoting the file.
    // Keep verified bytes, but do not publish a media receipt after that intent.
    if (JSON.parse(row.input ?? '{}').cancelRequested)
      throw new Error('VIDEO_MATERIALIZATION_STOPPED')
    const current = receipt(row)
    if (!current || current.identity !== value.identity || current.digest !== value.digest)
      return fail()
    const existing = db.prepare('SELECT * FROM media WHERE id=?').get(locations.mediaId) as
      | { path: string; size_bytes: number; kind: string; mime: string; created_at: number }
      | undefined
    if (
      existing &&
      (existing.path !== locations.relative ||
        existing.size_bytes !== value.size ||
        existing.kind !== 'video' ||
        existing.mime !== 'video/mp4')
    )
      return fail()
    const now = existing?.created_at ?? Date.now()
    if (!existing)
      db.prepare(
        'INSERT INTO media (id,kind,mime,path,size_bytes,created_at,name) VALUES (?,?,?,?,?,?,?)'
      ).run(locations.mediaId, 'video', 'video/mp4', locations.relative, value.size, now, 'video')
    db.prepare('UPDATE tasks SET output=?,updated_at=? WHERE id=? AND project_id=?').run(
      JSON.stringify({
        ...output(row),
        mediaId: locations.mediaId,
        videoMaterialization: { ...value, phase: 'committed' }
      }),
      Date.now(),
      taskId,
      projectId
    )
    return {
      id: locations.mediaId,
      kind: 'video',
      mime: 'video/mp4',
      path: locations.relative,
      sizeBytes: value.size!,
      createdAt: now,
      name: 'video'
    }
  })()
}
/** Complete receipts can be recovered entirely offline; partial bytes are never promoted. */
async function recoverUnlocked(
  taskId: string,
  projectId: string,
  lock: ProcessLock,
  diagnostics?: GatewayDiagnosticsContext
): Promise<MediaAsset | null> {
  const value = receipt(task(taskId, projectId))
  if (!value || value.phase === 'reserved') return null
  if (diagnostics)
    emitGatewayEvent(
      'media.persist_started',
      '已下载视频成果恢复开始',
      { ...diagnostics, taskId },
      { attributes: { operation: 'video.recover' } }
    )
  try {
    const asset = await commit(taskId, projectId, value, lock)
    if (diagnostics)
      emitGatewayEvent(
        'media.persist_completed',
        '已下载视频成果恢复完成',
        { ...diagnostics, taskId },
        {
          status: 'success',
          attributes: { operation: 'video.recover', mediaId: asset.id, mime: asset.mime }
        }
      )
    return asset
  } catch (error) {
    if (diagnostics)
      emitGatewayEvent(
        'media.persist_failed',
        '已下载视频成果恢复失败',
        { ...diagnostics, taskId },
        {
          error: new Error(
            error instanceof Error && error.message === 'VIDEO_MATERIALIZATION_STOPPED'
              ? 'VIDEO_MATERIALIZATION_STOPPED'
              : 'VIDEO_MATERIALIZATION_CONFLICT'
          ),
          attributes: { operation: 'video.recover' }
        }
      )
    throw error
  }
}
const resource = (taskId: string, projectId: string): string =>
  `video:${JSON.stringify([projectId, taskId])}`
export async function recoverVideoAsset(
  taskId: string,
  projectId: string,
  diagnostics?: GatewayDiagnosticsContext
): Promise<MediaAsset | null> {
  const lock = acquireProcessLock(resource(taskId, projectId))
  try {
    return await recoverUnlocked(taskId, projectId, lock, diagnostics)
  } finally {
    lock.release()
  }
}
/** One stable file and media identity per task. Download retries never submit generation. */
export function materializeVideoAsset(
  taskId: string,
  projectId: string,
  download: (target: string) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<MediaAsset> {
  const key = JSON.stringify([projectId, taskId])
  const pending = active.get(key)
  if (pending) return pending
  const work = (async () => {
    const lock = acquireProcessLock(resource(taskId, projectId))
    try {
      const restored = await recoverUnlocked(taskId, projectId, lock)
      if (restored) return restored
      const row = task(taskId, projectId)
      const value: Receipt = receipt(row) ?? {
        version: 1,
        identity: identity(row),
        phase: 'reserved'
      }
      // Never retrofit an unbound legacy output into a new recovery identity.
      if (output(row).mediaId && !receipt(row)) return fail()
      lock.assertOwned()
      getDb()
        .prepare('UPDATE tasks SET output=? WHERE id=? AND project_id=?')
        .run(JSON.stringify({ ...output(row), videoMaterialization: value }), taskId, projectId)
      const locations = paths(projectId, value)
      if (await exists(locations.target)) return fail()
      await mkdir(join(getDataDir(), 'video-recovery'), { recursive: true })
      lock.assertOwned()
      await download(locations.staging)
      const found = await fingerprint(locations.staging)
      const latest = task(taskId, projectId)
      lock.assertOwned()
      if (identity(latest) !== value.identity) return fail()
      const prepared: Receipt = { ...value, phase: 'prepared', ...found }
      getDb()
        .prepare('UPDATE tasks SET output=? WHERE id=? AND project_id=?')
        .run(
          JSON.stringify({ ...output(latest), videoMaterialization: prepared }),
          taskId,
          projectId
        )
      if (shouldStop()) throw new Error('VIDEO_MATERIALIZATION_STOPPED')
      return await commit(taskId, projectId, prepared, lock)
    } finally {
      lock.release()
    }
  })()
  active.set(key, work)
  void work
    .finally(() => {
      if (active.get(key) === work) active.delete(key)
    })
    .catch(() => {})
  return work
}
