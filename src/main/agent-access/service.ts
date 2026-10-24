import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import {
  ACCESS_KEY_TTL_MS,
  ACCESS_OPERATIONS,
  AccessRequestSchema,
  nodeAccessDirectory,
  operationDirectory,
  operationResponseSchema,
  type AccessOperationId,
  type AccessResponse
} from '../../shared/agent-access/registry'
import {
  GraphVersionConflictError,
  GraphWriteInProgressError
} from '../../shared/graph-snapshot-sync'
import { newTraceId, newSpanId } from '../../shared/observability'
import { getDb, getSetting, setSetting } from '../store/db'
import * as projects from '../store/projects.repo'
import { exportProject } from '../store/transfer'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { DesktopAccessError, type AccessDesktop } from './desktop'

class AccessFailure extends Error {
  constructor(
    readonly code: string,
    readonly phase: string
  ) {
    super(code)
  }
}

function unhandledOperation(operation: never): never {
  void operation
  throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
}
interface Receipt {
  intent_hmac: string
  status: string
  receipt_json: string
}
export interface LocalAccessOptions {
  instanceId: string
  appVersion: string
  exportDirectory: string
  activeProjectId: () => string | null
  desktop?: AccessDesktop
}

/** Only this main-process service touches repositories; CLI/MCP are transport clients. */
export class LocalAccessService {
  readonly dataStoreId: string
  private readonly hmacKey: string
  private readonly exportRoot: string
  private mutating = false

  constructor(private readonly options: LocalAccessOptions) {
    this.dataStoreId = getSetting('local-agent-data-store-id') ?? randomUUID()
    setSetting('local-agent-data-store-id', this.dataStoreId)
    this.hmacKey = getSetting('local-agent-intent-key') ?? randomBytes(32).toString('hex')
    setSetting('local-agent-intent-key', this.hmacKey)
    mkdirSync(options.exportDirectory, { recursive: true })
    this.exportRoot = realpathSync(options.exportDirectory)
    if (this.exportRoot.toLowerCase() !== options.exportDirectory.toLowerCase())
      throw new AccessFailure('PATH_NOT_ALLOWED', 'startup')
    // An abandoned mutation is never replayed, including the commit/receipt crash window.
    getDb()
      .prepare("UPDATE local_agent_operations SET status='unknown' WHERE status='pending'")
      .run()
    getDb()
      .prepare('DELETE FROM local_agent_operations WHERE created_at < ?')
      .run(Date.now() - ACCESS_KEY_TTL_MS)
  }

  async dispatch(raw: unknown): Promise<AccessResponse> {
    const parsed = AccessRequestSchema.safeParse(raw)
    const base: AccessResponse = {
      apiVersion: 1,
      requestId: parsed.success ? parsed.data.requestId : 'invalid',
      operationId: parsed.success ? parsed.data.operationId : 'invalid',
      traceId: newTraceId(),
      status: 'failed'
    }
    let key: string | undefined
    let claimed = false
    let started = false
    let ownsMutation = false
    let metadataCommitted = false
    const spanId = newSpanId()
    const diagnostic = (stage: string, code?: string, phase = 'dispatch'): void => {
      emitGatewayEvent(
        `agent.access.${stage}`,
        '本地外部操作状态',
        {
          traceId: base.traceId,
          spanId,
          requestId: base.requestId
        },
        {
          ...(stage === 'completed' ? { status: 'success' as const } : {}),
          ...(stage === 'failed' || stage === 'rejected' ? { status: 'failed' as const } : {}),
          ...(stage === 'unknown' ? { status: 'unknown' as const } : {}),
          attributes: {
            operation: Object.hasOwn(ACCESS_OPERATIONS, base.operationId)
              ? base.operationId
              : 'unsupported',
            phase,
            ...(code ? { code } : {})
          }
        }
      )
    }
    try {
      if (!parsed.success) throw new AccessFailure('INVALID_INPUT', 'validate')
      const request = parsed.data
      if (request.expectedDataStoreId !== this.dataStoreId)
        throw new AccessFailure('INSTANCE_MISMATCH', 'connect')
      if (!Object.hasOwn(ACCESS_OPERATIONS, request.operationId))
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'validate')
      const operationId = request.operationId as AccessOperationId
      const spec = ACCESS_OPERATIONS[operationId]
      const checked = spec.input.safeParse(request.input)
      if (!checked.success) throw new AccessFailure('INVALID_INPUT', 'validate')
      if (spec.effect !== 'read') {
        key = request.idempotencyKey
        if (!key) throw new AccessFailure('IDEMPOTENCY_REQUIRED', 'validate')
        base.idempotencyKey = key
        const issued = Number(key.split(':')[0])
        if (issued > Date.now() + 300000) throw new AccessFailure('INVALID_INPUT', 'validate')
        if (issued < Date.now() - ACCESS_KEY_TTL_MS)
          throw new AccessFailure('IDEMPOTENCY_EXPIRED', 'validate')
        const intent = createHmac('sha256', this.hmacKey)
          .update(JSON.stringify({ operationId, version: 1, input: checked.data }))
          .digest('hex')
        const old = getDb()
          .prepare(
            'SELECT intent_hmac,status,receipt_json FROM local_agent_operations WHERE idempotency_key=?'
          )
          .get(key) as Receipt | undefined
        if (old) {
          if (old.intent_hmac !== intent)
            throw new AccessFailure('IDEMPOTENCY_CONFLICT', 'admission')
          const result = JSON.parse(old.receipt_json) as AccessResponse
          result.requestId = request.requestId
          if (old.status !== 'completed' && old.status !== 'failed') {
            result.status = 'unknown'
            result.error = { code: 'OUTCOME_UNKNOWN', phase: 'reconcile', retryable: false }
          }
          return result
        }
        const pending = {
          ...base,
          status: 'unknown',
          error: { code: 'OUTCOME_UNKNOWN', phase: 'reconcile', retryable: false }
        }
        getDb()
          .prepare(
            'INSERT INTO local_agent_operations (idempotency_key,intent_hmac,status,receipt_json,created_at) VALUES (?,?,?,?,?)'
          )
          .run(key, intent, 'pending', JSON.stringify(pending), issued)
        claimed = true
      }
      diagnostic('started')
      started = true
      const input = checked.data as Record<string, unknown>
      const id = input.projectId as string | undefined
      if (spec.effect !== 'read') {
        if (this.mutating) throw new AccessFailure('RESOURCE_BUSY', 'operation-occupancy')
        this.mutating = ownsMutation = true
      }
      if (id && spec.effect !== 'read') this.assertNoActiveTasks(id)
      const active = this.options.activeProjectId()
      // The desktop must never have its open canvas deleted from underneath it.
      if (operationId === 'project.delete' && id === active)
        throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
      let result: unknown
      if (operationId === 'project.open' || (id === active && spec.effect !== 'read')) {
        if (!this.options.desktop) throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
        const target = projects.openProject(id!)
        if (!target) throw new AccessFailure('NOT_FOUND', 'read')
        if (
          operationId !== 'project.open' &&
          target.meta.graphVersion !== input.expectedGraphVersion
        )
          throw new AccessFailure('REVISION_CONFLICT', 'storage')
        if (active) this.assertNoActiveTasks(active)
        if (operationId === 'project.open') {
          await this.options.desktop.run({ action: 'open', projectId: id! }, () => {
            if (this.options.activeProjectId() !== active)
              throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
            if (active) this.assertNoActiveTasks(active)
            this.assertNoActiveTasks(id!)
            const meta = projects.getProject(id!)
            if (!meta) throw new AccessFailure('NOT_FOUND', 'read')
            return meta
          })
          if (this.options.activeProjectId() !== id)
            throw new DesktopAccessError('DESKTOP_CHANGED', true)
          result = { meta: projects.getProject(id!), opened: true }
        } else {
          const rename = operationId === 'project.rename' || operationId === 'project.update'
          const version = await this.options.desktop.run(
            {
              action: rename ? 'rename' : 'flush',
              projectId: id!,
              ...(rename ? { name: input.name as string } : {})
            },
            rename
              ? (version) => {
                  if (this.options.activeProjectId() !== id)
                    throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
                  this.assertNoActiveTasks(id!)
                  if (projects.getProject(id!)?.name !== target.meta.name)
                    throw new AccessFailure('REVISION_CONFLICT', 'metadata')
                  const meta = projects.renameProjectAtVersion(id!, input.name as string, version)
                  if (!meta) throw new AccessFailure('NOT_FOUND', 'read')
                  metadataCommitted = true
                  return meta
                }
              : undefined
          )
          if (this.options.activeProjectId() !== id)
            throw new DesktopAccessError('DESKTOP_CHANGED', true)
          this.assertNoActiveTasks(id!)
          if (projects.openProject(id!)?.meta.graphVersion !== version)
            throw new AccessFailure('REVISION_CONFLICT', 'desktop-flush')
          result = rename
            ? { meta: projects.getProject(id!), saved: true }
            : operationId === 'project.save'
              ? { graphVersion: version, saved: true }
              : this.execute(operationId, { ...input, expectedGraphVersion: version })
        }
      } else result = this.execute(operationId, input)
      base.status = 'completed'
      // Repositories use optional undefined properties; the wire contract is JSON.
      base.data = JSON.parse(JSON.stringify(result)) as unknown
      operationResponseSchema(operationId).parse(base)
      if (key) this.finish(key, base)
      diagnostic('completed')
      return base
    } catch (error) {
      const known =
        error instanceof DesktopAccessError && !error.unknownOutcome
          ? new AccessFailure(error.code, 'desktop-handshake')
          : error instanceof AccessFailure
            ? error
            : error instanceof GraphVersionConflictError
              ? new AccessFailure('REVISION_CONFLICT', 'storage')
              : error instanceof GraphWriteInProgressError
                ? new AccessFailure('RESOURCE_BUSY', 'storage')
                : null
      base.status = metadataCommitted
        ? 'unknown'
        : known
          ? 'failed'
          : claimed
            ? 'unknown'
            : 'failed'
      base.error = {
        code: metadataCommitted
          ? 'OUTCOME_UNKNOWN'
          : (known?.code ?? (claimed ? 'OUTCOME_UNKNOWN' : 'STORAGE_UNAVAILABLE')),
        phase:
          known?.phase ?? (error instanceof DesktopAccessError ? 'desktop-handshake' : 'storage'),
        retryable: false
      }
      delete base.data
      if (claimed && key) {
        try {
          this.finish(key, base)
        } catch {
          base.status = 'unknown'
          base.error = { code: 'OUTCOME_UNKNOWN', phase: 'receipt', retryable: false }
        }
      }
      diagnostic(
        base.status === 'unknown' ? 'unknown' : started ? 'failed' : 'rejected',
        base.error.code,
        base.error.phase
      )
      return base
    } finally {
      if (ownsMutation) this.mutating = false
    }
  }

  private finish(key: string, response: AccessResponse): void {
    getDb()
      .prepare('UPDATE local_agent_operations SET status=?,receipt_json=? WHERE idempotency_key=?')
      .run(response.status, JSON.stringify(response), key)
  }

  private assertNoActiveTasks(id: string): void {
    if (projects.hasRecoveryCopy(id)) throw new AccessFailure('RESOURCE_BUSY', 'recovery-ownership')
    if (this.taskOccupied(id)) throw new AccessFailure('RESOURCE_BUSY', 'task-occupancy')
  }

  private taskOccupied(id: string): boolean {
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
        .get(id)
    )
  }

  private deleteSnapshot(
    id: string
  ): { graphVersion: number; impact: Record<'nodeCount' | 'edgeCount' | 'groupCount' | 'mediaCount' | 'mediaBytes' | 'libraryUsageCount', number> } {
    const file = projects.openProject(id)
    if (!file) throw new AccessFailure('NOT_FOUND', 'read')
    const db = getDb()
    const media = db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM media WHERE substr(path,1,length(?))=?'
      )
      .get(`projects/${id}/media/`, `projects/${id}/media/`) as { n: number; bytes: number }
    const usage = db.prepare('SELECT COUNT(*) AS n FROM library_usages WHERE project_id=?').get(
      id
    ) as { n: number }
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

  private impactToken(id: string, graphVersion: number, impact: unknown, expiresAt: number): string {
    const payload = JSON.stringify({
      d: this.dataStoreId,
      p: id,
      v: graphVersion,
      i: impact,
      e: expiresAt
    })
    return `${expiresAt}.${createHmac('sha256', this.hmacKey).update(payload).digest('hex')}`
  }

  private deletePrecheck(id: string): unknown {
    const snapshot = this.deleteSnapshot(id)
    const blockers: Array<'ACTIVE_PROJECT' | 'RECOVERY_COPY' | 'TASK_OCCUPANCY'> = []
    if (this.options.activeProjectId() === id) blockers.push('ACTIVE_PROJECT')
    if (projects.hasRecoveryCopy(id)) blockers.push('RECOVERY_COPY')
    if (this.taskOccupied(id)) blockers.push('TASK_OCCUPANCY')
    if (blockers.length)
      return { projectId: id, graphVersion: snapshot.graphVersion, impact: snapshot.impact, blockers }
    const expiresAt = Date.now() + 600000
    return {
      projectId: id,
      graphVersion: snapshot.graphVersion,
      impact: snapshot.impact,
      blockers,
      impactToken: this.impactToken(id, snapshot.graphVersion, snapshot.impact, expiresAt),
      expiresAt
    }
  }

  /** The signature binds instance, target, revision and impact; a mismatch of any
   * fact (tamper, expiry, revision or impact drift) requires a fresh precheck. */
  private executeDelete(id: string, token: string | undefined): unknown {
    if (!token) throw new AccessFailure('IMPACT_CONFIRM_REQUIRED', 'delete-admission')
    const [rawExpiry, supplied] = token.split('.')
    const expiresAt = Number(rawExpiry)
    if (!rawExpiry || !supplied || !Number.isInteger(expiresAt) || Date.now() > expiresAt)
      throw new AccessFailure('IMPACT_TOKEN_INVALID', 'delete-admission')
    const snapshot = this.deleteSnapshot(id)
    const expected = this.impactToken(
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

  private execute(operation: AccessOperationId, input: Record<string, unknown>): unknown {
    const id = input.projectId as string
    switch (operation) {
      case 'app.status':
        return {
          instanceId: this.options.instanceId,
          dataStoreId: this.dataStoreId,
          appVersion: this.options.appVersion,
          apiVersion: 1,
          nextIdempotencyKey: `${Date.now()}:${randomUUID()}`
        }
      case 'capability.list':
        return {
          operations: operationDirectory(),
          limitations: [
            'DESKTOP_HANDSHAKE_REQUIRED',
            'NO_NODE_EXECUTION',
            'NO_PROJECT_IMPORT',
            'EXPORT_DIRECTORY_ONLY'
          ]
        }
      case 'node.type.list':
        return { nodes: nodeAccessDirectory() }
      case 'project.list': {
        const all = projects.listProjects()
        return {
          projects: all
            .slice(input.offset as number, (input.offset as number) + (input.limit as number))
            .map(({ id, name, createdAt, updatedAt, graphVersion }) => ({
              id,
              name,
              createdAt,
              updatedAt,
              graphVersion
            })),
          total: all.length
        }
      }
      case 'project.get': {
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        return {
          meta: file.meta,
          nodeCount: file.nodes.length,
          edgeCount: file.edges.length,
          groupCount: file.groups.length,
          saved: true
        }
      }
      case 'project.create':
        return {
          meta: projects.createProject(input.name as string, undefined, nanoid(12)),
          saved: true
        }
      case 'project.rename': {
        return this.execute('project.update', input)
      }
      case 'project.open':
        throw new AccessFailure('DESKTOP_UNAVAILABLE', 'desktop-handshake')
      case 'project.update': {
        const meta = projects.renameProjectAtVersion(
          id,
          input.name as string,
          input.expectedGraphVersion as number
        )
        if (!meta) throw new AccessFailure('NOT_FOUND', 'read')
        return { meta, saved: true }
      }
      case 'project.save': {
        const result = projects.saveProject({
          id,
          expectedGraphVersion: input.expectedGraphVersion as number
        })
        if (!result) throw new AccessFailure('NOT_FOUND', 'read')
        return { ...result, saved: true }
      }
      case 'project.clone': {
        const meta = projects.withProjectVersionLock(id, input.expectedGraphVersion as number, () =>
          projects.cloneProject(id, input.name as string)
        )
        if (!meta) throw new AccessFailure('NOT_FOUND', 'read')
        return { meta, saved: true }
      }
      case 'project.delete.precheck':
        return this.deletePrecheck(id)
      case 'project.delete':
        return this.executeDelete(id, input.impactToken as string | undefined)
      case 'project.export': {
        const result = projects.withProjectVersionLock(
          id,
          input.expectedGraphVersion as number,
          () => {
            const destination = join(this.exportRoot, input.fileName as string)
            if (existsSync(destination)) throw new AccessFailure('OUTPUT_EXISTS', 'export')
            const temporary = join(this.exportRoot, `.${randomUUID()}.canvasbundle`)
            try {
              if (realpathSync(this.exportRoot) !== this.exportRoot)
                throw new AccessFailure('PATH_NOT_ALLOWED', 'export')
              const exported = exportProject(id, temporary, { requireComplete: true })
              if (exported.missingMediaCount) throw new AccessFailure('EXPORT_INCOMPLETE', 'export')
              const digest = createHash('sha256').update(readFileSync(temporary)).digest('hex')
              const bytes = statSync(temporary).size
              const fd = openSync(temporary, 'r+')
              try {
                fsyncSync(fd)
              } finally {
                closeSync(fd)
              }
              // Exclusive final-name creation: an existing file/symlink is never overwritten.
              linkSync(temporary, destination)
              return {
                path: destination,
                sourceGraphVersion: input.expectedGraphVersion,
                byteSize: bytes,
                sha256: digest,
                missingMediaCount: 0
              }
            } finally {
              if (existsSync(temporary)) rmSync(temporary)
            }
          }
        )
        if (!result) throw new AccessFailure('NOT_FOUND', 'read')
        return result
      }
    }
    return unhandledOperation(operation)
  }
}
