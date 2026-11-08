import { FlowSkillStore } from '../agent-flow/skill-store'
import { accessSkillAgent, chatNodeAgent, installAccessSkill, skillSummary } from './skills'
import { listWorkflowTemplates, saveWorkflowTemplate } from '../store/workspace-state.repo'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
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
import { basename, extname, isAbsolute, join } from 'node:path'
import { nanoid } from 'nanoid'
import { createResource } from '../store/library.repo'
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
  resolvePatchReferences,
  toGraphView,
  type GraphPatchOp
} from '../../shared/agent-access/graph-ops'
import {
  GraphVersionConflictError,
  GraphWriteInProgressError
} from '../../shared/graph-snapshot-sync'
import { newTraceId, newSpanId } from '../../shared/observability'
import { getDb, getSetting, setSetting } from '../store/db'
import * as projects from '../store/projects.repo'
import { deleteMedia, importMedia, listMedia } from '../store/media.repo'
import { exportProject } from '../store/transfer'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { assertLicenseActive } from '../security/license/gate'
import { DesktopAccessError, type AccessDesktop } from './desktop'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { FlowTaskStore } from '../agent-flow/task-store'
import type { DiagnosticsService } from '../diagnostics/service'
import { accessDiagnosticsSummary, searchAccessLibrary } from './queries'
import {
  createExternalRun,
  getExternalRun,
  reportExternalRun,
  requestExternalRunCancel
} from './runs'
import {
  buildProjectionShape,
  DETERMINISTIC_OUTPUT_SOURCES
} from '../../shared/agent-access/run-ops'
import { DETERMINISTIC_PROJECTIONS } from '../../shared/engine/deterministic-projections'
import { parseChat as parseChatShared, chatConversations as chatConversationsShared } from '../../shared/engine/chat-data'

class AccessFailure extends Error {
  constructor(
    readonly code: string,
    readonly phase: string,
    readonly detail?: string
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
const IMAGE_MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
])
export interface LocalAccessOptions {
  instanceId: string
  appVersion: string
  exportDirectory: string
  activeProjectId: () => string | null
  desktop?: AccessDesktop
  diagnostics?: Pick<DiagnosticsService, 'health'> | null
}

/** 活动项目上需要"先 flush 画布再操作"的写入集合；其余写入不触碰画布。 */
const FLUSH_HANDSHAKE_OPERATIONS: ReadonlySet<AccessOperationId> = new Set([
  'project.save',
  'project.rename',
  'project.update',
  'project.clone',
  'project.export',
  'chat.skill.bind'
] as AccessOperationId[])

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
    // 授权守卫：授权失效后立即停止响应外部操作。
    try {
      assertLicenseActive('agent.access.dispatch')
    } catch {
      return {
        apiVersion: 1,
        requestId: 'rejected',
        operationId: 'invalid',
        traceId: newTraceId(),
        status: 'failed'
      }
    }
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
      // run.cancel 是对在途任务的控制操作，豁免占用检查（否则取消不了自己要停的任务）。
      if (id && spec.effect !== 'read' && operationId !== 'run.cancel')
        this.assertNoActiveTasks(id)
      const active = this.options.activeProjectId()
      // The desktop must never have its open canvas deleted from underneath it.
      if (operationId === 'project.delete' && id === active)
        throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
      let result: unknown
      if (operationId === 'chat.skill.bind' && (id !== active || !this.options.desktop))
        throw new AccessFailure('ACTIVE_PROJECT_REQUIRED', 'desktop-ownership')
      if (operationId === 'node.execute') {
        // F3 执行准入：宿主驻留 + 目标存在 + 持久任务受理；最终状态只由 run.get 判定。
        if (id !== active || !this.options.desktop)
          throw new AccessFailure(
            'ACTIVE_PROJECT_REQUIRED',
            'desktop-ownership',
            'project.open the target canvas first, then retry node.execute'
          )
        const executeFile = projects.openProject(id)
        if (!executeFile) throw new AccessFailure('NOT_FOUND', 'read')
        const executeNodeIds = input.nodeIds as string[]
        for (const nodeId of executeNodeIds)
          if (!executeFile.nodes.some((candidate) => candidate.id === nodeId))
            throw new AccessFailure('NODE_NOT_FOUND', 'precheck', nodeId.slice(0, 60))
        const run = createExternalRun({
          projectId: id,
          mode: (input.mode as 'single' | 'subgraph') ?? 'subgraph',
          nodeIds: executeNodeIds
        })
        try {
          await this.options.desktop.run({
            action: 'execute-nodes',
            projectId: id,
            taskId: run.id,
            mode: run.mode === 'single' ? 'single' : 'subgraph',
            nodeIds: executeNodeIds,
            confirmPaidRerun: input.confirmPaidRerun === true
          })
        } catch (error) {
          if (error instanceof DesktopAccessError && !error.unknownOutcome) {
            // 宿主明确拒绝（引擎忙/付费重跑未确认等）：任务从未开始。
            reportExternalRun(run.id, 'failed', { error: error.code })
            throw new AccessFailure(error.code, 'execute-handshake', error.detail)
          }
          // 超时/丢失：任务保持 accepted，由 run.get 核对，不盲目重发。
          throw error
        }
        const after = getExternalRun(run.id)!
        result = {
          projectId: id,
          taskId: run.id,
          accepted: true,
          mode: run.mode,
          nodeIds: executeNodeIds,
          state: after.status === 'running' ? 'running' : 'accepted'
        }
      } else if (operationId === 'run.cancel') {
        const row = getExternalRun(input.taskId as string)
        if (!row || row.project_id !== id)
          throw new AccessFailure('NOT_FOUND', 'run-read', 'node-run task not found')
        if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
          result = { projectId: id, taskId: row.id, state: row.status, cancelRequested: false }
        } else {
          const updated = requestExternalRunCancel(row.id)!
          if (id === active && this.options.desktop) {
            try {
              await this.options.desktop.run({ action: 'cancel-run', projectId: id, taskId: row.id })
            } catch {
              // 通知失败不改变取消请求登记；终态仍以宿主报告为准。
            }
          }
          result = {
            projectId: id,
            taskId: row.id,
            state: updated.status === 'cancel-requested' ? 'cancel-requested' : updated.status,
            cancelRequested: true
          }
        }
      } else if (operationId === 'graph.patch') {
        // F2 画布编辑走权威宿主：未打开的项目返回明确等待动作，不另建 headless 编辑路径。
        if (id !== active || !this.options.desktop)
          throw new AccessFailure(
            'ACTIVE_PROJECT_REQUIRED',
            'desktop-ownership',
            'project.open the target canvas first, then retry graph.patch'
          )
        const current = projects.openProject(id)
        if (!current) throw new AccessFailure('NOT_FOUND', 'read')
        const resolved = resolvePatchReferences(input.ops as GraphPatchOp[], {
          nodes: current.nodes,
          edges: current.edges
        })
        if (!resolved.ok)
          throw new AccessFailure(
            'PATCH_REFERENCE_INVALID',
            'precheck',
            resolved.errors
              .slice(0, 5)
              .map((e) => `op[${e.index}]:${e.code}`)
              .join(',')
          )
        // F4：素材引用必须已登记到同一项目；解析事实（相对路径/MIME）按 mediaId 注入宿主载荷。
        const mediaResolutions: Record<
          string,
          { mediaId: string; mediaPath: string; mediaMime: string; name?: string }
        > = {}
        const chatMediaResolutions: typeof mediaResolutions = {}
        for (const op of input.ops as GraphPatchOp[]) {
          const mediaRef = op.action === 'node.create' || op.action === 'node.update' ? op.media : undefined
          if (!mediaRef || mediaResolutions[mediaRef.mediaId]) continue
          const asset = listMedia(id).find((candidate) => candidate.id === mediaRef.mediaId)
          if (!asset) throw new AccessFailure('MEDIA_NOT_FOUND', 'precheck', mediaRef.mediaId)
          mediaResolutions[mediaRef.mediaId] = {
            mediaId: asset.id,
            mediaPath: asset.path,
            mediaMime: asset.mime,
            ...(asset.name ? { name: asset.name.slice(0, 200) } : {})
          }
        }
        // F6：chat.patch 预检——目标必须是对话节点；附件 mediaId 解析同媒体规则。
        for (const op of input.ops as GraphPatchOp[]) {
          if (op.action !== 'chat.patch') continue
          const chatNode = current.nodes.find((candidate) => candidate.id === op.nodeId)
          if (!chatNode || chatNode.type !== 'chat')
            throw new AccessFailure('CHAT_NODE_REQUIRED', 'precheck', op.nodeId.slice(0, 60))
          for (const chatOp of op.ops) {
            if (chatOp.action !== 'chat.message.append' || !chatOp.message.images) continue
            for (const image of chatOp.message.images) {
              const asset = listMedia(id).find((candidate) => candidate.id === image.mediaId)
              if (!asset)
                throw new AccessFailure('MEDIA_NOT_FOUND', 'precheck', image.mediaId)
              chatMediaResolutions[image.mediaId] = {
                mediaId: asset.id,
                mediaPath: asset.path,
                mediaMime: asset.mime,
                ...(asset.name ? { name: asset.name.slice(0, 200) } : {})
              }
            }
          }
        }
        const patchResult = await this.options.desktop.run(
          {
            action: 'graph-patch',
            projectId: id,
            ops: input.ops as GraphPatchOp[],
            expectedGraphVersion: input.expectedGraphVersion as number,
            ...(Object.keys(mediaResolutions).length ? { mediaResolutions } : {}),
            ...(Object.keys(chatMediaResolutions).length ? { mediaResolutions: chatMediaResolutions } : {})
          },
          (version) => {
            if (this.options.activeProjectId() !== id)
              throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
            this.assertNoActiveTasks(id)
            const admitted = projects.openProject(id)
            if (!admitted || admitted.meta.graphVersion !== version)
              throw new AccessFailure('REVISION_CONFLICT', 'patch-admission')
            // From this admission onward the renderer may have persisted a mutation.
            metadataCommitted = true
            return admitted.meta
          }
        )
        // main 读取并核对：回执中的每个创建节点必须真实落盘，数量必须与保存结果一致。
        const savedFile = projects.openProject(id)
        if (!savedFile || savedFile.meta.graphVersion !== patchResult.graphVersion)
          throw new AccessFailure('REVISION_CONFLICT', 'patch-verify')
        const payload = (patchResult.result ?? {}) as {
          created?: Array<{ ref?: string; nodeId?: string }>
          counts?: Partial<Record<'nodeCreated' | 'nodeUpdated' | 'nodeDeleted' | 'edgeCreated' | 'edgeDeleted', number>>
        }
        const createdNodes = (payload.created ?? []).filter((c): c is { ref?: string; nodeId: string } =>
          typeof c.nodeId === 'string'
        )
        for (const created of createdNodes) {
          // 每个回执 ID（节点或连线）都必须能在正式持久化数据中核对到。
          const persisted =
            savedFile.nodes.some((n) => n.id === created.nodeId) ||
            savedFile.edges.some((e) => e.id === created.nodeId)
          if (!persisted)
            throw new AccessFailure('STORAGE_INCONSISTENT', 'patch-verify', created.nodeId.slice(0, 60))
        }
        const zero = { nodeCreated: 0, nodeUpdated: 0, nodeDeleted: 0, edgeCreated: 0, edgeDeleted: 0 }
        const counts = { ...zero, ...(payload.counts ?? {}) }
        result = {
          projectId: id,
          graphVersion: patchResult.graphVersion,
          saved: true,
          created: createdNodes.map((c) => ({ ...(c.ref ? { ref: c.ref } : {}), nodeId: c.nodeId })),
          applied: counts
        }
      } else if (
        operationId === 'project.open' ||
        // 仅"需要协调活动画布"的写入走 flush 握手；画布无关写入（如 media.import）
        // 直接走存储服务，避免无关版本核对拒绝。
        (id === active && FLUSH_HANDSHAKE_OPERATIONS.has(operationId))
      ) {
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
          const bind = operationId === 'chat.skill.bind'
          let agent: ReturnType<typeof accessSkillAgent> | undefined
          if (bind) {
            try {
              agent = accessSkillAgent(input as Parameters<typeof accessSkillAgent>[0])
            } catch (error) {
              throw new AccessFailure(
                error instanceof AgentRuntimeError ? error.code : 'SKILL_BINDING_INVALID',
                'skill-validation'
              )
            }
          }
          const version = (
            await this.options.desktop.run(
              {
                action: bind ? 'bind-skills' : rename ? 'rename' : 'flush',
                ...(bind ? { nodeId: input.nodeId as string, agent } : {}),
                projectId: id!,
                ...(rename ? { name: input.name as string } : {})
              },
            bind
              ? (version) => {
                  if (this.options.activeProjectId() !== id)
                    throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
                  this.assertNoActiveTasks(id!)
                  const file = projects.openProject(id!)
                  if (!file || file.meta.graphVersion !== version)
                    throw new AccessFailure('REVISION_CONFLICT', 'skill-admission')
                  const node = file.nodes.find((node) => node.id === input.nodeId)
                  if (!node || node.type !== 'chat')
                    throw new AccessFailure('CHAT_NODE_REQUIRED', 'skill-admission')
                  // From this admission onward the renderer may have persisted a mutation.
                  metadataCommitted = true
                  return file.meta
                }
              : rename
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
          ).graphVersion
          if (this.options.activeProjectId() !== id)
            throw new DesktopAccessError('DESKTOP_CHANGED', true)
          this.assertNoActiveTasks(id!)
          if (projects.openProject(id!)?.meta.graphVersion !== version)
            throw new AccessFailure('REVISION_CONFLICT', 'desktop-flush')
          if (bind) {
            const savedNode = projects
              .openProject(id!)
              ?.nodes.find((node) => node.id === input.nodeId)
            if (!savedNode || JSON.stringify(chatNodeAgent(savedNode)) !== JSON.stringify(agent))
              throw new DesktopAccessError('SKILL_BIND_NOT_SAVED', true)
          }
          result = bind
            ? {
                projectId: id,
                nodeId: input.nodeId,
                graphVersion: version,
                saved: true,
                skills: input.skills
              }
            : rename
              ? { meta: projects.getProject(id!), saved: true }
              : operationId === 'project.save'
                ? { graphVersion: version, saved: true }
                : await this.execute(operationId, { ...input, expectedGraphVersion: version })
        }
      } else result = await this.execute(operationId, input)
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
          ? new AccessFailure(error.code, 'desktop-handshake', error.detail)
          : error instanceof AccessFailure
            ? error
            : error instanceof AgentRuntimeError
              ? new AccessFailure(error.code, 'skill-storage')
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
        retryable: false,
        ...(known?.detail ? { detail: known.detail } : {})
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

  /** external_runs 行 → run.get / run.wait 的 node-run DTO。 */
  private externalRunDto(
    row: { id: string; project_id: string; mode: string; node_ids: string; status: string; error: string | null; created_at: number; updated_at: number },
    hostResident: boolean
  ): unknown {
    let nodeIds: string[] = []
    try {
      const parsed: unknown = JSON.parse(row.node_ids)
      if (Array.isArray(parsed)) nodeIds = parsed.filter((v): v is string => typeof v === 'string')
    } catch {
      nodeIds = []
    }
    return {
      taskId: row.id,
      projectId: row.project_id,
      source: 'node-run',
      state: row.status,
      mode: row.mode === 'single' ? 'single' : 'subgraph',
      nodeIds,
      cancelRequested: row.status === 'cancel-requested' || row.status === 'cancelled',
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      hostResident
    }
  }

  private assertNoActiveTasks(id: string): void {
    if (projects.hasRecoveryCopy(id)) throw new AccessFailure('RESOURCE_BUSY', 'recovery-ownership')
    if (this.taskOccupied(id)) throw new AccessFailure('RESOURCE_BUSY', 'task-occupancy')
  }

  /** Media enters from a local file the agent already downloaded; bytes never cross the wire.
   * The holder of the access token is the same local user, so any absolute path is admitted,
   * but the file must be a non-empty image within the repository's component size limit. */
  private readLibraryImage(source: string): Uint8Array {
    if (!isAbsolute(source) || source.length > 500)
      throw new AccessFailure('INVALID_INPUT', 'validate')
    let size: number
    try {
      size = statSync(source).size
    } catch {
      throw new AccessFailure('INVALID_INPUT', 'validate')
    }
    if (size < 1 || size > 128 * 1024 * 1024) throw new AccessFailure('INVALID_INPUT', 'validate')
    return new Uint8Array(readFileSync(source))
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
        .get(id) ||
      db
        .prepare(
          "SELECT 1 FROM external_runs WHERE project_id=? AND status IN ('accepted','running','cancel-requested') LIMIT 1"
        )
        .get(id)
    )
  }

  private deleteSnapshot(id: string): {
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

  private impactToken(
    id: string,
    graphVersion: number,
    impact: unknown,
    expiresAt: number
  ): string {
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
    const expected = this.impactToken(id, snapshot.graphVersion, snapshot.impact, expiresAt).split(
      '.'
    )[1]
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

  private async execute(operation: AccessOperationId, input: Record<string, unknown>): Promise<unknown> {
    const id = input.projectId as string
    switch (operation) {
      case 'media.import': {
        // F4：素材经公共导入服务登记为项目受控媒体；字节不过线，路径是导入请求。
        if (!projects.getProject(id)) throw new AccessFailure('NOT_FOUND', 'read')
        const outcome = await importMedia(id, input.filePath as string)
        if (!outcome.ok)
          throw new AccessFailure(
            'MEDIA_IMPORT_FAILED',
            'media-import',
            outcome.reason.slice(0, 120)
          )
        const asset = outcome.asset
        const textContent =
          typeof asset.textContent === 'string' ? asset.textContent.slice(0, 20_000) : undefined
        return {
          projectId: id,
          mediaId: asset.id,
          kind: asset.kind,
          mime: asset.mime,
          path: asset.path,
          sizeBytes: asset.sizeBytes,
          name: (input.name as string | undefined) ?? asset.name ?? '',
          ...(textContent ? { textContent } : {})
        }
      }
      case 'media.list': {
        if (!projects.getProject(id)) throw new AccessFailure('NOT_FOUND', 'read')
        const all = listMedia(id)
        return {
          projectId: id,
          total: all.length,
          items: all
            .slice(input.offset as number, (input.offset as number) + (input.limit as number))
            .map((asset) => ({
              mediaId: asset.id,
              kind: asset.kind,
              mime: asset.mime,
              path: asset.path,
              sizeBytes: asset.sizeBytes,
              name: (asset.name ?? '').slice(0, 200)
            }))
        }
      }
      case 'media.delete': {
        // F4 收尾：与 GUI 面板删除同一 deleteMedia 服务；外部额外校验项目归属，
        // 回执携带保存图引用计数（信息性，不阻断——与 GUI 规则一致）。
        if (!projects.getProject(id)) throw new AccessFailure('NOT_FOUND', 'read')
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        const asset = listMedia(id).find((candidate) => candidate.id === input.mediaId)
        if (!asset) throw new AccessFailure('MEDIA_NOT_FOUND', 'read', String(input.mediaId).slice(0, 40))
        const referenced = file.nodes.filter(
          (node) => node.content.kind === 'media' && node.content.mediaId === asset.id
        ).length
        const deleted = await deleteMedia(asset.id)
        if (!deleted) throw new AccessFailure('MEDIA_NOT_FOUND', 'media-delete')
        return {
          projectId: id,
          deleted: true,
          mediaId: asset.id,
          referencedBySavedNodes: referenced
        }
      }
      case 'graph.get': {
        const view = (input.view as 'persisted' | 'latest') ?? 'persisted'
        const offset = input.offset as number
        const limit = input.limit as number
        if (view === 'latest' && id === this.options.activeProjectId() && this.options.desktop) {
          // latest 视图取权威宿主当前状态（含未保存编辑）；未打开项目没有宿主，
          // persisted 视图即当前唯一权威。分页与 DTO 投影在宿主侧用同一 toGraphView 完成。
          const { result } = await this.options.desktop.run({
            action: 'read-graph',
            projectId: id,
            offset,
            limit
          })
          const projected = (result ?? {}) as {
            graphVersion?: number
            unsaved?: boolean
            total?: number
            offset?: number
            nodes?: unknown
            edges?: unknown
            groups?: unknown
          }
          if (
            typeof projected.graphVersion !== 'number' ||
            typeof projected.total !== 'number' ||
            !Array.isArray(projected.nodes) ||
            !Array.isArray(projected.edges) ||
            !Array.isArray(projected.groups)
          )
            throw new AccessFailure('HOST_NOT_READY', 'graph-read')
          return {
            projectId: id,
            view,
            graphVersion: projected.graphVersion,
            unsaved: projected.unsaved === true,
            total: projected.total,
            offset: projected.offset ?? offset,
            nodes: projected.nodes,
            edges: projected.edges,
            groups: projected.groups
          }
        }
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        return {
          projectId: id,
          view: 'persisted',
          graphVersion: file.meta.graphVersion,
          unsaved: false,
          ...toGraphView(file, offset, limit)
        }
      }
      case 'node.get': {
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        const node = file.nodes.find((candidate) => candidate.id === input.nodeId)
        if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'read')
        let config: unknown = null
        const rawConfig = node.params.config
        if (typeof rawConfig === 'string' && rawConfig.trim()) {
          try {
            config = JSON.parse(rawConfig)
          } catch {
            config = null
          }
        }
        const edgesIn = file.edges
          .filter((edge) => edge.to.nodeId === node.id)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 2000)
          .map((edge) => ({
            edgeId: edge.id,
            from: edge.from,
            to: edge.to,
            ...(edge.connectOrder !== undefined ? { connectOrder: edge.connectOrder } : {})
          }))
        const edgesOut = file.edges
          .filter((edge) => edge.from.nodeId === node.id)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 2000)
          .map((edge) => ({
            edgeId: edge.id,
            from: edge.from,
            to: edge.to,
            ...(edge.connectOrder !== undefined ? { connectOrder: edge.connectOrder } : {})
          }))
        return {
          projectId: id,
          graphVersion: file.meta.graphVersion,
          node: {
            nodeId: node.id,
            type: node.type,
            contractVersion: node.contractVersion,
            title: node.title.slice(0, 200),
            x: node.x,
            y: node.y,
            w: node.w,
            h: node.h,
            ports: node.ports.map((port) => ({
              id: port.id,
              dir: port.dir,
              type: port.type,
              required: port.required,
              cardinality: port.cardinality,
              name: (port.name ?? port.id).slice(0, 80),
              ...(port.schema ? { schema: port.schema } : {})
            })),
            contentKind:
              node.content.kind === 'media'
                ? 'media'
                : node.content.kind === 'text'
                  ? 'text'
                  : 'empty',
            text: node.content.kind === 'text' ? node.content.text : '',
            config,
            ...(node.content.kind === 'media' && node.content.mediaId
              ? { mediaId: node.content.mediaId }
              : {}),
            ...(typeof node.params.mediaPath === 'string'
              ? { mediaPath: node.params.mediaPath }
              : {}),
            ...(typeof node.params.mediaMime === 'string'
              ? { mediaMime: node.params.mediaMime }
              : {}),
            exec: String(node.exec?.status ?? 'idle'),
            edgesIn,
            edgesOut
          }
        }
      }
      case 'skill.list': {
        const all = new FlowSkillStore(getDb()).list()
        return {
          items: all
            .slice(input.offset as number, (input.offset as number) + (input.limit as number))
            .map(skillSummary),
          total: all.length
        }
      }
      case 'skill.install': {
        try {
          return skillSummary(installAccessSkill(input.sourcePath as string, input.name as string))
        } catch (error) {
          throw new AccessFailure(
            error instanceof AgentRuntimeError ? error.code : 'SKILL_PACKAGE_INVALID',
            'skill-install'
          )
        }
      }
      case 'chat.skill.list': {
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        const nodes = file.nodes.filter((node) => node.type === 'chat')
        return {
          graphVersion: file.meta.graphVersion,
          total: nodes.length,
          nodes: nodes
            .slice(input.offset as number, (input.offset as number) + (input.limit as number))
            .map((node) => ({
              nodeId: node.id,
              title: node.title,
              skills: chatNodeAgent(node).skills.map(({ id, version }) => ({ id, version }))
            }))
        }
      }
      case 'chat.skill.bind':
        throw new AccessFailure('ACTIVE_PROJECT_REQUIRED', 'desktop-ownership')
      case 'node.library.list': {
        const all = listWorkflowTemplates()
        return {
          total: all.length,
          items: all
            .slice(input.offset as number, (input.offset as number) + (input.limit as number))
            .map(({ id, name, createdAt, nodeCount }) => ({ id, name, createdAt, nodeCount }))
        }
      }
      case 'node.library.save': {
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        if (file.meta.graphVersion !== input.expectedGraphVersion)
          throw new AccessFailure('REVISION_CONFLICT', 'storage')
        const node = file.nodes.find((node) => node.id === input.nodeId)
        if (!node || node.type !== 'chat')
          throw new AccessFailure('CHAT_NODE_REQUIRED', 'template-validation')
        // Keep only the explicit reusable skill configuration, never chat history, attachments or results.
        const agent = chatNodeAgent(node)
        const entry = saveWorkflowTemplate({
          name: input.name as string,
          nodeCount: 1,
          edges: [],
          nodes: [
            {
              nodeType: 'chat',
              title: node.title,
              dx: 0,
              dy: 0,
              w: node.w,
              h: node.h,
              text: '',
              config: JSON.stringify({ agent })
            }
          ]
        })
        const { id: templateId, name, createdAt, nodeCount } = entry
        return { id: templateId, name, createdAt, nodeCount }
      }
      case 'model.list':
        return new SqliteModelHost(getDb()).listAccessModels(
          input.offset as number,
          input.limit as number
        )
      case 'library.search':
        return searchAccessLibrary(ACCESS_OPERATIONS['library.search'].input.parse(input))
      case 'library.create_resource': {
        const source = input.imagePath as string
        const mime = IMAGE_MIME_BY_EXTENSION.get(extname(source).toLowerCase())
        if (!mime) throw new AccessFailure('INVALID_INPUT', 'validate')
        const data = this.readLibraryImage(source)
        const detail = createResource({
          title: input.title as string,
          formPreset: 'image',
          ...(typeof input.description === 'string' && input.description.trim()
            ? { description: input.description }
            : {}),
          ...(Array.isArray(input.tags) && input.tags.length
            ? { tags: input.tags as string[] }
            : {}),
          components: [
            {
              role: 'reference-image',
              valueType: 'image',
              data,
              mime,
              fileName: basename(source),
              metadata: {}
            }
          ]
        })
        const image = detail.components.find((component) => component.valueType === 'image')
        if (!image?.contentHash) throw new AccessFailure('STORAGE_INCONSISTENT', 'storage')
        return {
          resourceId: detail.id,
          revisionId: detail.latestRevisionId,
          revisionNumber: detail.revisionNumber,
          title: detail.title,
          imageSha256: image.contentHash
        }
      }
      case 'run.get': {
        if (!projects.getProject(id)) throw new AccessFailure('NOT_FOUND', 'read')
        // F3：external_runs 优先；flow 任务保持既有 DTO（source 区分，字段不重名）。
        const external = getExternalRun(input.taskId as string)
        if (external && external.project_id === id)
          return this.externalRunDto(external, id === this.options.activeProjectId())
        const task = new FlowTaskStore(getDb()).summary(id, input.taskId as string)
        if (!task) throw new AccessFailure('NOT_FOUND', 'flow-task-read')
        return task
      }
      case 'run.wait': {
        // 只等待 external_runs 任务；flow 任务用 run.get 轮询（终态拥有者不同）。
        if (!projects.getProject(id)) throw new AccessFailure('NOT_FOUND', 'read')
        const deadline = Date.now() + (input.timeoutMs as number)
        for (;;) {
          const row = getExternalRun(input.taskId as string)
          if (!row || row.project_id !== id)
            throw new AccessFailure('NOT_FOUND', 'run-read', 'node-run task not found')
          if (
            row.status === 'completed' ||
            row.status === 'failed' ||
            row.status === 'cancelled' ||
            Date.now() >= deadline
          )
            return this.externalRunDto(row, id === this.options.activeProjectId())
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      }
      case 'output.get': {
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        const outputNode = file.nodes.find((candidate) => candidate.id === input.nodeId)
        if (!outputNode) throw new AccessFailure('NODE_NOT_FOUND', 'read')
        const projector = DETERMINISTIC_PROJECTIONS[outputNode.type]
        const outputSource = DETERMINISTIC_OUTPUT_SOURCES[outputNode.type]
        if (!projector || !outputSource)
          throw new AccessFailure(
            'UNSUPPORTED_CONTRACT',
            'output-projection',
            `${outputNode.type}: output projection lands with its node family package`
          )
        const shape = buildProjectionShape(file, outputNode.id)
        if (!shape) throw new AccessFailure('STORAGE_INCONSISTENT', 'output-projection')
        const projected = projector(shape as Parameters<typeof projector>[0])
        return {
          projectId: id,
          graphVersion: file.meta.graphVersion,
          nodeId: outputNode.id,
          nodeType: outputNode.type,
          outputSource,
          outputs: Object.entries(projected)
            .slice(0, 32)
            .map(([portId, value]) => {
              const v = value as Record<string, unknown>
              const kind = String(v.kind)
              if (kind === 'text' || kind === 'markdown')
                return { portId, kind, text: String(v.text ?? '').slice(0, 20_000) }
              if (kind === 'json' || kind === 'camera' || kind === 'any' || kind === 'iteration') {
                const encoded = JSON.stringify(v.data ?? null) ?? 'null'
                if (encoded.length > 100_000)
                  throw new AccessFailure('OUTPUT_TOO_LARGE', 'output-projection', portId)
                return { portId, kind, json: JSON.parse(encoded) as unknown }
              }
              return {
                portId,
                kind,
                ...(typeof v.mediaId === 'string' ? { mediaId: v.mediaId } : {}),
                ...(typeof v.mediaPath === 'string' ? { mediaPath: v.mediaPath } : {}),
                ...(typeof v.mime === 'string' ? { mime: v.mime } : {})
              }
            }),
          projection: 'deterministic@1'
        }
      }
      case 'diagnostics.summary':
        return accessDiagnosticsSummary(this.options.diagnostics)
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
      case 'graph.patch':
        // graph.patch 在 dispatch 中经权威宿主握手执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'node.execute':
      case 'run.cancel':
        // 同上：执行与取消需要权威宿主握手，在 dispatch 分支处理。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'chat.read': {
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        const chatNode = file.nodes.find((candidate) => candidate.id === input.nodeId)
        if (!chatNode) throw new AccessFailure('NODE_NOT_FOUND', 'read')
        if (chatNode.type !== 'chat')
          throw new AccessFailure('CHAT_NODE_REQUIRED', 'read', chatNode.type.slice(0, 40))
        let modelKey = ''
        const rawConfig = chatNode.params.config
        if (typeof rawConfig === 'string' && rawConfig.trim()) {
          try {
            const parsedConfig = JSON.parse(rawConfig) as { modelKey?: unknown }
            if (typeof parsedConfig.modelKey === 'string')
              modelKey = parsedConfig.modelKey.slice(0, 200)
          } catch {
            modelKey = ''
          }
        }
        const readData = parseChatShared(chatNode.content.kind === 'text' ? chatNode.content.text : '')
        const conversations = chatConversationsShared(readData)
        return {
          projectId: id,
          graphVersion: file.meta.graphVersion,
          nodeId: chatNode.id,
          modelKey,
          system: readData.system.slice(0, 2000),
          activeConversationId: readData.activeConversationId ?? null,
          conversations: conversations.slice(0, 50).map((conversation) => ({
            id: conversation.id.slice(0, 80),
            title: conversation.title.slice(0, 120),
            messageCount: conversation.messages.length,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            active:
              conversation.id ===
              (readData.activeConversationId ?? conversations[0]?.id)
          }))
        }
      }
      case 'chat.messages': {
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        const chatNode = file.nodes.find((candidate) => candidate.id === input.nodeId)
        if (!chatNode) throw new AccessFailure('NODE_NOT_FOUND', 'read')
        if (chatNode.type !== 'chat') throw new AccessFailure('CHAT_NODE_REQUIRED', 'read')
        const msgData = parseChatShared(chatNode.content.kind === 'text' ? chatNode.content.text : '')
        const conversations = chatConversationsShared(msgData)
        const requested =
          typeof input.sessionId === 'string' ? input.sessionId : msgData.activeConversationId
        const conversation =
          conversations.find((candidate) => candidate.id === requested) ?? conversations[0]
        if (!conversation) throw new AccessFailure('NOT_FOUND', 'chat-session')
        const messages = conversation.messages.slice(
          input.offset as number,
          (input.offset as number) + (input.limit as number)
        )
        return {
          projectId: id,
          nodeId: chatNode.id,
          sessionId: conversation.id,
          total: conversation.messages.length,
          offset: input.offset as number,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.reasoning ? { reasoning: message.reasoning.slice(0, 20000) } : {}),
            ...(message.intent ? { intent: message.intent } : {}),
            ...(message.images?.length
              ? {
                  images: message.images.slice(0, 8).map((image) => ({
                    mediaId: image.mediaId,
                    mediaPath: image.mediaPath,
                    name: (image.name ?? '').slice(0, 200),
                    mime: image.mime
                  }))
                }
              : {})
          }))
        }
      }
    }
    return unhandledOperation(operation)
  }
}
