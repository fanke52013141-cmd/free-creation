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
  nodeAccessDirectorySummary,
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
import { deleteMedia, importMedia, listMedia, getMediaAsset } from '../store/media.repo'
import { listArtifactRecipes } from '../store/artifact-recipes.repo'
import { exportProject } from '../store/transfer'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { ACCESS_ERROR_CATALOG } from '../../shared/agent-access/metadata'
import { assertLicenseActive } from '../security/license/gate'
import { DesktopAccessError, type AccessDesktop } from './desktop'
import { runNodeLibraryOperation } from './node-library-ops'
import { runCompositeOperation, previewCompositeUpgrade } from './composite-ops'
import { getCompositeVersion, getCompositeCapability } from '../store/composite.repo'
import {
  getCompositeRun,
  countCompositeRetries,
  resubmitCompositeRun,
  getCompositeStepOutputs
} from '../store/composite-run.repo'
import {
  getOpenCompositeRunWait,
  satisfyCompositeRunWait,
  getSatisfiedHumanSubmissions
} from '../store/composite-run-wait.repo'
import { validateCompositeManifest } from '../../shared/composite/validate'
import { compositeContentHash } from '../../shared/composite/manifest'
import type { CompositeResolutionMap } from '../../shared/agent-access/graph-ops'
import { COMPOSITE_OPERATION_IDS } from '../../shared/agent-access/ops/composite'
import { runHistoryOperation } from './history-ops'
import { FLOW_AGENT_OPERATION_IDS, runFlowAgentOperation } from './flow-agents-ops'
import { FLOW_AGENT_RUN_OPERATION_IDS, runFlowAgentRunOperation } from './flow-agent-run-ops'
import { FLOW_AGENT_BUILD_OPERATION_IDS, runFlowAgentBuildOperation } from './flow-agent-build-ops'
import { nodeContract } from '../../shared/agent-access/node-contracts'
import {
  parseStateMachineInstance,
  parseStateMachinePending
} from '../../shared/engine/executors/agentFlow'
import {
  HumanTaskInstanceSchema,
  HumanTaskPendingSchema,
  HumanTaskNodeConfigSchema
} from '../../shared/agent-flow/node-contracts'
import { FLOW_ASSET_OPERATION_IDS, runFlowAssetOperation } from './flow-assets-ops'
import { isFlowCommandOperation, runFlowCommandOperation } from './flow-commands-ops'
import { isSettingsOperation, runSettingsOperation } from './settings-ops'
import { runDiagnosticsOperation } from './diagnostics-ops'
import { MODEL_ADMIN_OPERATION_IDS, runModelAdminOperation } from './model-admin-ops'
import { MEDIA_ASSET_OPERATION_IDS, runMediaAssetOperation } from './media-assets-ops'
import { LIBRARY_CAPTURE_OPERATION_IDS, runLibraryCaptureOperation } from './library-capture-ops'
import { CANVAS_HISTORY_OPERATION_IDS, runCanvasHistoryOperation } from './canvas-history-ops'
import { PROVIDER_OPERATION_IDS, runProviderOperation } from './providers-ops'
import { PROVIDER_NETWORK_OPERATION_IDS, runProviderNetworkOperation } from './provider-network-ops'
import { WEB_SEARCH_OPERATION_IDS, runWebSearchOperation } from './web-search-ops'
import { PROVIDER_ADMIN_OPERATION_IDS, runProviderAdminOperation } from './provider-admin-ops'
import { KEY_PACKAGE_OPERATION_IDS, runKeyPackageOperation } from './key-package-ops'
import { runProjectSettingsOperation } from './project-settings-ops'
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
import {
  parseChat as parseChatShared,
  chatConversations as chatConversationsShared
} from '../../shared/engine/chat-data'
import { parseDirectorProject, parseDirectorPublishRecord } from '../../shared/director-data'
import {
  PUBLISH_AUTHORIZATION_TTL_MS,
  PublishArtifactSchema,
  PublishHostResultSchema,
  type PublishMode
} from '../../shared/agent-access/publish'
import {
  PublishLimitError,
  authorizePublishRequest,
  claimPublishRequest,
  completePublishRequest,
  createPublishRequest,
  denyPublishRequest,
  failPublishRequest,
  getPublishRequest,
  recoverAbandonedPublishRequests
} from './publish'
import {
  exportLibraryPackage,
  exportStructurePackage,
  importLibraryPackage,
  importProjectPackage,
  importStructurePackage
} from './transfer-ops'
import { runLibraryOperation } from './library-ops'

class AccessFailure extends Error {
  constructor(
    readonly code: string,
    readonly phase: string,
    readonly detail?: string,
    /** 版本冲突时宿主报告的当前图版本（结构化回传，客户端可直接用它重试）。 */
    readonly currentGraphVersion?: number
  ) {
    super(code)
  }
}

/** 本项目里有生成谱系（recipe）的媒体 ID 集合：供 media.list 标注 hasRecipe。 */
function mediaIdsWithRecipe(projectId: string): string[] {
  try {
    return listArtifactRecipes(projectId)
      .map((recipe) => String(recipe.mediaId ?? ''))
      .filter((mediaId) => mediaId.length > 0)
  } catch {
    // 谱系表缺失/损坏不应让列表失败：退化为"未知即没有"，并保持列表可用。
    return []
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

/**
 * 必须独占应用级状态的写入（F8 按项目锁的例外）。
 *
 * `project.open` 会切换"应用当前的权威画布"，它是应用级事实而不是某个项目的事实：
 * 两个项目同时 open 会互相抢活动画布，因此仍用全局锁把它们串起来。
 * 其余带 projectId 的写入按项目互斥，不同项目可以并行。
 */
const GLOBAL_LOCK_OPERATIONS: ReadonlySet<AccessOperationId> = new Set([
  'project.open'
] as AccessOperationId[])

/** F7 节点库/历史操作：在 dispatch 内带 trace/span 与占用回调执行（见 case 分支），不另建执行器。 */
const F7_DISPATCH_OPERATIONS: ReadonlySet<AccessOperationId> = new Set([
  'node.library.compose',
  'node.library.update',
  'node.library.delete',
  'node.library.get',
  'node.library.search',
  'node.library.insert',
  'history.list',
  'history.snapshot.create',
  'history.snapshot.delete',
  'history.restore.precheck',
  'history.restore',
  'history.recovery.precheck',
  'history.recovery.resolve',
  ...COMPOSITE_OPERATION_IDS
] as AccessOperationId[])

/** Only this main-process service touches repositories; CLI/MCP are transport clients. */
export class LocalAccessService {
  readonly dataStoreId: string
  private readonly hmacKey: string
  private readonly exportRoot: string
  /**
   * 按项目互斥的写入锁（F8）：不同项目的写入可以并行，同一项目仍严格串行。
   *
   * 改造前的单一 `mutating` 标志把整个服务变成"同时只能有一个写操作"，于是给项目 B
   * 导入媒体会被项目 A 的一次保存挡住（RESOURCE_BUSY），多画布批量作业只能串行。
   * 锁键规则：
   * - 输入里有 projectId 的写操作 → 锁该项目；
   * - 没有 projectId 的写操作（技能安装、包导入导出、资源库全局写入）→ 全局锁，
   *   语义与改造前一致（全局存储在项目之间是共享事实，不能并行改）；
   * - GLOBAL_LOCK_OPERATIONS（如 project.open）→ 全局锁，因为它改的是应用级活动画布。
   */
  private readonly mutationLocks = new Set<string>()
  private static readonly GLOBAL_MUTATION_LOCK = '*'

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
    // 崩溃遗留的执行中发布请求按 unknown 语义结算：不自动重发，等外部重新申请与授权。
    recoverAbandonedPublishRequests()
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
    let mutationLock: string | undefined
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
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const path = issue?.path.join('.') ?? 'request'
        throw new AccessFailure(
          'INVALID_INPUT',
          'validate',
          `${path}: ${issue?.message ?? 'invalid'}`.slice(0, 200)
        )
      }
      const request = parsed.data
      if (request.expectedDataStoreId !== this.dataStoreId)
        throw new AccessFailure('INSTANCE_MISMATCH', 'connect')
      if (!Object.hasOwn(ACCESS_OPERATIONS, request.operationId))
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'validate')
      const operationId = request.operationId as AccessOperationId
      const spec = ACCESS_OPERATIONS[operationId]
      const checked = spec.input.safeParse(request.input)
      if (!checked.success) {
        // 带上是哪个字段、为什么不行（zod message 不含具体值，不会泄漏业务数据）。
        const issue = checked.error.issues[0]
        const path = issue?.path.join('.') ?? 'input'
        throw new AccessFailure(
          'INVALID_INPUT',
          'validate',
          `${path}: ${issue?.message ?? 'invalid'}`.slice(0, 200)
        )
      }
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
        mutationLock =
          id && !GLOBAL_LOCK_OPERATIONS.has(operationId)
            ? id
            : LocalAccessService.GLOBAL_MUTATION_LOCK
        this.acquireMutationLock(mutationLock)
        ownsMutation = true
      }
      // run.cancel 是对在途任务的控制操作，豁免占用检查（否则取消不了自己要停的任务）。
      // history.recovery.resolve 同理：它是"解决恢复副本"的操作，本身必须能在副本存在时执行；
      // 其他写操作（含 project.delete/export/其他 history 写）仍照旧被恢复副本阻断。
      // flow.command.reconcile / flow.command.abort 同理：目标就是结算/放弃一条
      // pending/unknown 的既有命令，若按占用拒绝就永远无法处理；账本仍只按已保存事实
      // 推进（reconcile）或只放弃从未准入的外部命令（abort），不伪造成功。
      // F8：flowAgent.run/pause/stop 的作用对象就是账本里的那条 Agent 任务——run 要启动/继续
      // 它、pause/stop 要控制它；若按"存在活动任务"拒绝，就永远无法操作自己刚创建的任务。
      // C4：humanTask.submit 同理——专家执行 human-task 停等（waitKind=human）的目的就是
      // 让人提交结果；pending 写入不占执行权（执行器按 expectedRevision 权威消费），
      // 与 GUI 提交按钮同一语义，若按占用拒绝则人工等待永远无法解锁。
      if (
        id &&
        spec.effect !== 'read' &&
        operationId !== 'run.cancel' &&
        operationId !== 'history.recovery.resolve' &&
        operationId !== 'flow.command.reconcile' &&
        operationId !== 'flow.command.abort' &&
        operationId !== 'flowAgent.run' &&
        operationId !== 'flowAgent.pause' &&
        operationId !== 'flowAgent.stop' &&
        operationId !== 'humanTask.submit'
      )
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
        if (input.mode === 'single' && Array.isArray(input.inputs) && input.inputs.length)
          throw new AccessFailure(
            'INVALID_INPUT',
            'precheck',
            'temporary inputs require subgraph mode'
          )
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
            confirmPaidRerun: input.confirmPaidRerun === true,
            inputs: input.inputs as
              import('@shared/agent-access/run-ops').WorkflowInput[] | undefined
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
      } else if (operationId === 'composite.execute') {
        // headless 节点流执行：不依赖项目/画布。解析已发布 manifest → 合成作用域 →
        // 渲染层隔离 editor 异步运行；终态与输出经台账（composite.run.get）回填。
        if (!this.options.desktop)
          throw new AccessFailure(
            'DESKTOP_UNAVAILABLE',
            'desktop-ownership',
            'headless execute requires the desktop host running'
          )
        const capabilityId = String(input.capabilityId ?? '')
        const capability = getCompositeCapability(capabilityId)
        if (!capability) throw new AccessFailure('NOT_FOUND', 'read', 'capability')
        const version = typeof input.version === 'string' ? input.version : capability.latestVersion
        if (!version) throw new AccessFailure('NOT_FOUND', 'read', 'published-version')
        const record = getCompositeVersion(capabilityId, version)
        if (!record) throw new AccessFailure('NOT_FOUND', 'read', 'published-version')
        const validation = validateCompositeManifest(record.manifest)
        if (!validation.ok)
          throw new AccessFailure('STORAGE_INCONSISTENT', 'read', 'manifest-invalid')
        const runId = randomUUID()
        const headlessScope = `headless-${runId}`
        const resolvedInputs: Array<{ portId: string; value: unknown }> = []
        const rawInputs =
          (input.inputs as
            Array<{ portId: string; value: { kind: string; mediaId?: string } }> | undefined) ?? []
        for (const entry of rawInputs) {
          if (entry.value?.kind === 'media') {
            const asset = getMediaAsset(String(entry.value.mediaId ?? ''))
            if (!asset)
              throw new AccessFailure('NOT_FOUND', 'precheck', `media:${entry.value.mediaId}`)
            resolvedInputs.push({
              portId: entry.portId,
              value: {
                kind: asset.kind,
                mediaId: asset.id,
                mediaPath: asset.path,
                mime: asset.mime
              }
            })
          } else {
            resolvedInputs.push({ portId: entry.portId, value: entry.value })
          }
        }
        try {
          await this.options.desktop.run({
            action: 'execute-composite-headless',
            projectId: headlessScope,
            compositeManifest: record.manifest,
            compositeInputs: resolvedInputs,
            ownRunId: runId,
            // W4 受控重试：公开输入值随运行创建原子落盘（握手 fire-and-forget，事后 UPDATE 会竞态）。
            compositeInputValues: Object.fromEntries(
              resolvedInputs.map((entry) => [entry.portId, entry.value])
            )
          })
        } catch (error) {
          if (error instanceof DesktopAccessError && !error.unknownOutcome)
            throw new AccessFailure(error.code, 'execute-handshake', error.detail)
          throw error
        }
        result = { runId, capabilityId, version, status: 'running' }
      } else if (operationId === 'composite.execute.wait') {
        const runId = String(input.runId ?? '')
        const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 30000
        const deadline = Date.now() + timeoutMs
        let record = getCompositeRun(runId)?.run
        while (record && record.status === 'running' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          record = getCompositeRun(runId)?.run
        }
        if (!record) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
        result = {
          runId,
          status: record.status,
          ...(record.outputValues ? { outputs: record.outputValues } : {}),
          ...(record.errorMessage ? { reason: record.errorMessage } : {}),
          // W4：人工补交/重试链事实如实暴露（不伪造自动成功）。
          ...(record.manualSubmission ? { manualSubmission: true } : {}),
          ...(record.retryOf ? { retryOf: record.retryOf } : {}),
          ...(record.failurePhase
            ? {
                failure: {
                  code: record.errorCode ?? 'FAILED',
                  phase: record.failurePhase,
                  // W4 失败定位：填充结构化失败节点/端口（schema 早已允许，此前从不填）。
                  ...(record.failureNodeId ? { nodeId: record.failureNodeId } : {}),
                  ...(record.failurePortId ? { portId: record.failurePortId } : {})
                }
              }
            : {})
        }
      } else if (operationId === 'composite.run.retry') {
        result = await this.executeCompositeRunRetry(input)
      } else if (operationId === 'composite.run.resubmit') {
        result = this.executeCompositeRunResubmit(input)
      } else if (operationId === 'composite.run.submitHuman') {
        result = this.executeCompositeSubmitHuman(input)
      } else if (operationId === 'composite.run.resume') {
        result = await this.executeCompositeRunResume(input)
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
              await this.options.desktop.run({
                action: 'cancel-run',
                projectId: id,
                taskId: row.id
              })
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
        result = await this.executeGraphPatch(id!, active, input, () => {
          metadataCommitted = true
        })
      } else if (operationId === 'graph.layout') {
        result = await this.executeGraphLayout(id!, active, input, () => {
          metadataCommitted = true
        })
      } else if (
        operationId === 'director.publish.prepare' ||
        operationId === 'director.publish.status' ||
        operationId === 'director.publish.continue'
      ) {
        // F6 收尾：manual-publish 的等待/继续协议。发布必须由人在 GUI 授权；
        // node.execute 对 director 永远只读最近一次一致的发布记录，不能偷渡发布。
        if (operationId === 'director.publish.status') {
          const row = getPublishRequest(input.publishRequestId as string)
          if (!row || row.project_id !== id) throw new AccessFailure('NOT_FOUND', 'publish-read')
          const artifact = PublishArtifactSchema.safeParse({
            mediaId: row.media_id ?? '',
            mediaPath: row.media_path ?? '',
            mime: row.media_mime ?? ''
          })
          result = {
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
        } else if (id !== active || !this.options.desktop) {
          // 发布与授权都发生在权威宿主上：没有打开的桌面画布就没有可授权对象。
          throw new AccessFailure(
            'ACTIVE_PROJECT_REQUIRED',
            'desktop-ownership',
            'project.open the target canvas first, then retry director.publish'
          )
        } else if (operationId === 'director.publish.prepare') {
          const file = projects.openProject(id)
          if (!file) throw new AccessFailure('NOT_FOUND', 'read')
          if (file.meta.graphVersion !== input.expectedGraphVersion)
            throw new AccessFailure('REVISION_CONFLICT', 'precheck')
          const node = file.nodes.find((candidate) => candidate.id === input.nodeId)
          if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'precheck')
          // 只有 manual-publish 的导演台需要这条协议；普通节点直接 node.execute。
          if (node.type !== 'director')
            throw new AccessFailure(
              'DIRECTOR_NODE_REQUIRED',
              'precheck',
              String(node.type).slice(0, 40)
            )
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
          // 授权经交互式通道交给 GUI：人看到的是同一条请求，点"允许"才成立。
          // 外部无法构造这一步——它没有 renderer 回复通道。
          void this.options.desktop
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
          result = {
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
        } else {
          const row = getPublishRequest(input.publishRequestId as string)
          if (!row || row.project_id !== id) throw new AccessFailure('NOT_FOUND', 'publish-request')
          const existing = PublishArtifactSchema.safeParse({
            mediaId: row.media_id ?? '',
            mediaPath: row.media_path ?? '',
            mime: row.media_mime ?? ''
          })
          if (row.status === 'completed') {
            // 重放原回执：不重新渲染、不产生第二份产物。
            if (!existing.success) throw new AccessFailure('STORAGE_INCONSISTENT', 'publish-verify')
            result = {
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
          } else if (row.status === 'denied') {
            throw new AccessFailure(
              'PUBLISH_DENIED',
              'publish-admission',
              'the user denied this publish request'
            )
          } else if (row.status === 'expired') {
            throw new AccessFailure(
              'PUBLISH_AUTHORIZATION_EXPIRED',
              'publish-admission',
              'authorization window elapsed; prepare a new request'
            )
          } else if (row.status === 'failed') {
            throw new AccessFailure('PUBLISH_FAILED', 'publish-admission', row.error ?? undefined)
          } else if (row.status === 'executing') {
            throw new AccessFailure('RESOURCE_BUSY', 'publish-admission')
          } else if (row.status !== 'authorized') {
            throw new AccessFailure(
              'PUBLISH_NOT_AUTHORIZED',
              'publish-admission',
              'a human must authorize this publish request in the GUI first'
            )
          } else {
            const file = projects.openProject(id)
            if (!file) throw new AccessFailure('NOT_FOUND', 'read')
            // 授权绑定的是申请时的画布状态：工程变过就必须重新申请，不能拿旧授权发布新内容。
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
              const reply = await this.options.desktop.run(
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
                  if (this.options.activeProjectId() !== id)
                    throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
                  this.assertNoActiveTasks(id)
                  const admitted = projects.openProject(id)
                  if (!admitted || admitted.meta.graphVersion !== version)
                    throw new AccessFailure('REVISION_CONFLICT', 'publish-admission')
                  // 从此点起宿主可能已经写入正式发布记录：失败按 unknown 核对。
                  metadataCommitted = true
                  return admitted.meta
                },
                // 导演台发布要真实渲染/编码（WebM 可达十几秒），不能用 10 秒编辑窗口。
                60000
              )
              const published = PublishHostResultSchema.safeParse(reply.result)
              if (!published.success)
                throw new AccessFailure(
                  'STORAGE_INCONSISTENT',
                  'publish-verify',
                  'host result invalid'
                )
              // 保存屏障之后核对：正式发布记录必须真的落到持久化数据里。
              // 注意运行事实在 tldraw 快照的 shape meta 里（与 output.get 同一投影来源），
              // 不在 project.json 的节点字段上——真实桌面验收发现此处最初读错了存储。
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
              result = {
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
              // 已有正式写入的失败按 unknown 保留原样，绝不表述成"没发生过"。
              if (metadataCommitted) {
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
                      const meta = projects.renameProjectAtVersion(
                        id!,
                        input.name as string,
                        version
                      )
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
      } else if (F7_DISPATCH_OPERATIONS.has(operationId)) {
        // F7：节点库/历史操作需要 agent.access 的 trace/span 与占用回调；业务实现只有一份，
        // 在 node-library-ops.ts / history-ops.ts（不新增外部专用执行路径）。
        const f7Context = {
          activeProjectId: this.options.activeProjectId,
          diagnostics: { traceId: base.traceId, spanId }
        }
        result = operationId.startsWith('composite.')
          ? operationId === 'composite.upgrade.apply'
            ? await this.applyCompositeUpgrade(input, () => {
                metadataCommitted = true
              })
            : await runCompositeOperation(operationId, input, {
                diagnostics: f7Context.diagnostics
              })
          : operationId.startsWith('history.')
            ? runHistoryOperation(operationId, input, {
                ...f7Context,
                isTaskOccupied: (projectId) => this.taskOccupied(projectId),
                issueImpactToken: (projectId, graphVersion, facts, expiresAt) =>
                  this.impactToken(projectId, graphVersion, facts, expiresAt)
              })
            : await runNodeLibraryOperation(operationId, input, {
                ...f7Context,
                desktop: this.options.desktop
              })
      } else if (
        FLOW_AGENT_OPERATION_IDS.has(operationId) ||
        FLOW_ASSET_OPERATION_IDS.has(operationId)
      ) {
        // F8（一）：Flow 观察与固定资产操作复用 desktop-host / asset-store 的同一实现
        // （flow-agents-ops.ts / flow-assets-ops.ts），不新增外部专用执行路径。
        const flowContext = {
          activeProjectId: this.options.activeProjectId,
          desktop: this.options.desktop,
          requestId: request.requestId,
          ...(key ? { idempotencyKey: key } : {}),
          diagnostics: { traceId: base.traceId, spanId }
        }
        result = FLOW_AGENT_OPERATION_IDS.has(operationId)
          ? await runFlowAgentOperation(operationId, input, flowContext)
          : await runFlowAssetOperation(operationId, input, flowContext)
      } else if (FLOW_AGENT_RUN_OPERATION_IDS.has(operationId)) {
        // F8（第二批）：Agent 运行控制只经由启动时创建的那一个宿主实例（flow-bridge 窄接口），
        // 外部不新建宿主、不自造运行身份；start/continue 先走与 IPC 入口相同的模型工具调用预检。
        result = await runFlowAgentRunOperation(operationId, input, {
          activeProjectId: this.options.activeProjectId
        })
      } else if (operationId === 'flowStateMachine.submitEvent') {
        // C3：状态机人工事件——与 GUI 提交事件按钮同一 meta.stateMachinePending 写入，
        // 经渲染器权威动作（修订核对 + 保存屏障）；迁移合法性仍由运行时的同一执行器校验。
        result = await this.executeStateMachineEvent(id!, active, input)
      } else if (operationId === 'flowStateMachine.get') {
        result = this.readStateMachine(id!, input)
      } else if (operationId === 'humanTask.submit') {
        // C4：人工任务结果——与 GUI 提交结果按钮同一 meta.humanTaskPending 写入，
        // 经渲染器权威动作（修订核对 + 保存屏障）；完成状态仍由运行时同一执行器校验。
        result = await this.executeHumanTaskSubmit(id!, active, input)
      } else if (operationId === 'humanTask.get') {
        result = this.readHumanTask(id!, input)
      } else if (FLOW_AGENT_BUILD_OPERATION_IDS.has(operationId)) {
        // F8（收官）：建图预览/提交与模型审核同样只经 flow-bridge 发布的同一 builder/review
        // 宿主；propose/review 先走与 IPC 相同的模型能力预检，commit 走渲染器权威动作
        // commitFlowBuild（authorize/confirm + 单撤销步 + 保存屏障）并由 main 核对落盘事实。
        result = await runFlowAgentBuildOperation(operationId, input, {
          activeProjectId: this.options.activeProjectId,
          desktop: this.options.desktop,
          diagnostics: { traceId: base.traceId, spanId }
        })
      } else if (isFlowCommandOperation(operationId)) {
        // F8（二/收官）：Flow 命令账本协作（flow-commands-ops.ts）。读/结算类只操作既有命令；
        // 派发/放弃经共享权威端口复用 registerFlowCommandsIpc 的同一账本会话，
        // 外部命令以 principal='external' 入库，运行身份全部由 main 生成。
        result = await runFlowCommandOperation(operationId, input, {
          traceId: base.traceId,
          spanId,
          activeProjectId: () => this.options.activeProjectId(),
          desktop: this.options.desktop
        })
      } else if (isSettingsOperation(operationId)) {
        // F9（二）：模型目录/绑定与环境状态读取直接复用 GUI 同一 main 服务
        // （SqliteModelHost、ModelRuntime.resolveForExecution、媒体/推理环境探测）；
        // 全部只读，不发供应商请求、不写凭据，不落 execute 的普通分支。
        result = await runSettingsOperation(operationId, input)
      } else if (MODEL_ADMIN_OPERATION_IDS.has(operationId)) {
        // F9（四）：模型连接与受控凭据写入复用 SqliteModelHost（GUI 模型设置同一实现）。
        // 明文密钥只在本进程内用于写入/计算指纹，不回传、不进日志；模型验证与发现
        // 需要供应商请求，未在本批开放，因此外部也无法"自行验证"。
        result = await runModelAdminOperation(operationId, input)
      } else if (MEDIA_ASSET_OPERATION_IDS.has(operationId)) {
        // F7 收尾：产物生成来源只读（不返回提示词正文）+ 素材批量导出到受控目录（逐项回执）。
        result = await runMediaAssetOperation(operationId, input, { exportRoot: this.exportRoot })
      } else if (LIBRARY_CAPTURE_OPERATION_IDS.has(operationId)) {
        // F7 收尾：资源捕获（画布→资源库）复用 library.repo 同一服务，
        // 外部只传受控 ID；节点/媒体的项目归属由实现逐个校验。
        result = runLibraryCaptureOperation(operationId, input)
      } else if (PROVIDER_OPERATION_IDS.has(operationId)) {
        // F9 收尾：供应商目录只读投影（复用 GUI 模型设置同一来源，字段白名单去敏，
        // 不返回地址/鉴权头/密钥材料）。
        result = await runProviderOperation(operationId, input)
      } else if (PROVIDER_NETWORK_OPERATION_IDS.has(operationId)) {
        // F9：供应商连通性测试与模型真实验证。默认不执行——必须显式 confirmNetwork=true
        // （validate 还需 confirmCost=true），否则拒绝且不发任何请求（用户已授权此边界）。
        result = await runProviderNetworkOperation(operationId, input)
      } else if (WEB_SEARCH_OPERATION_IDS.has(operationId)) {
        // C2：受控联网搜索外部 op。默认不执行——必须显式 confirmNetwork=true 与
        // confirmCost=true，否则拒绝且不发任何请求；密钥由 main 从设备密钥库读取。
        result = await runWebSearchOperation(operationId, input)
      } else if (PROVIDER_ADMIN_OPERATION_IDS.has(operationId)) {
        // F9 收尾：供应商管理与凭据包导入（导入需人在 GUI 确认）。
        result = await runProviderAdminOperation(operationId, input, {
          exportRoot: this.exportRoot,
          activeProjectId: this.options.activeProjectId,
          desktop: this.options.desktop
        })
      } else if (KEY_PACKAGE_OPERATION_IDS.has(operationId)) {
        // F9：凭据包导出/预览侧（用户已批准"导出与预览开放、导入需人工确认"）。
        // 复用 keys-bridge 发布的同一个 KeyPackageService；回执不返回包正文。
        result = await runKeyPackageOperation(operationId, input, { exportRoot: this.exportRoot })
      } else if (CANVAS_HISTORY_OPERATION_IDS.has(operationId)) {
        // F2：撤销/重做与关闭项目必须由权威宿主执行（历史栈在 editor 里；关画布要先保存）。
        result = await runCanvasHistoryOperation(operationId, input, {
          activeProjectId: this.options.activeProjectId,
          desktop: this.options.desktop,
          clearLastProject: () => setSetting('lastProjectId', '')
        })
      } else if (
        operationId === 'diagnostics.query' ||
        operationId === 'diagnostics.exportBundle' ||
        operationId === 'diagnostics.exportNodeRun' ||
        operationId === 'project.nodeVisibility.get' ||
        operationId === 'project.nodeVisibility.set'
      ) {
        // F9（三）：诊断查询复用 main 的 DiagnosticsService.query（GUI 运行中心同一读取路径
        // 与同一份已脱敏存储）；节点可见集读/写走 projects.repo 的正式读/保存机制。
        // 全部实现只有一份（diagnostics-ops.ts / project-settings-ops.ts），不建外部专用执行器。
        const f9ReadContext = {
          activeProjectId: this.options.activeProjectId,
          diagnostics: this.options.diagnostics
        }
        result = operationId.startsWith('diagnostics.')
          ? await runDiagnosticsOperation(operationId, input, {
              diagnostics: f9ReadContext.diagnostics,
              exportRoot: this.exportRoot,
              activeProjectId: this.options.activeProjectId,
              ...(this.options.desktop ? { desktop: this.options.desktop } : {})
            })
          : runProjectSettingsOperation(operationId, input, f9ReadContext)
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
          ? new AccessFailure(
              error.code,
              'desktop-handshake',
              error.detail,
              error.currentGraphVersion
            )
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
        ...(known?.detail ? { detail: known.detail } : {}),
        // 版本冲突：把当前版本结构化回传，客户端可直接用它重试（不必解析 detail 文本）。
        ...(known?.currentGraphVersion !== undefined
          ? { currentGraphVersion: known.currentGraphVersion }
          : error instanceof DesktopAccessError && error.currentGraphVersion !== undefined
            ? { currentGraphVersion: error.currentGraphVersion }
            : {})
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
      // 异常路径也必须释放：否则一次失败的写操作会把该项目的后续写入永久堵死。
      if (ownsMutation && mutationLock) this.releaseMutationLock(mutationLock)
    }
  }

  private acquireMutationLock(lockKey: string): void {
    const global = LocalAccessService.GLOBAL_MUTATION_LOCK
    if (lockKey === global) {
      // 全局写入要求没有其他写入在飞：保持改造前的独占语义。
      if (this.mutationLocks.size > 0)
        throw new AccessFailure('RESOURCE_BUSY', 'operation-occupancy')
    } else if (this.mutationLocks.has(global) || this.mutationLocks.has(lockKey)) {
      // 同一项目仍严格串行；全局写入在飞时也不允许项目写入插入。
      throw new AccessFailure('RESOURCE_BUSY', 'operation-occupancy')
    }
    this.mutationLocks.add(lockKey)
  }

  private releaseMutationLock(lockKey: string): void {
    this.mutationLocks.delete(lockKey)
  }

  private finish(key: string, response: AccessResponse): void {
    getDb()
      .prepare('UPDATE local_agent_operations SET status=?,receipt_json=? WHERE idempotency_key=?')
      .run(response.status, JSON.stringify(response), key)
  }

  /** external_runs 行 → run.get / run.wait 的 node-run DTO。 */
  private externalRunDto(
    row: {
      id: string
      project_id: string
      mode: string
      node_ids: string
      status: string
      error: string | null
      created_at: number
      updated_at: number
    },
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

  /**
   * W3 实例升级：与 GUI 同一份 previewCompositeUpgrade 预检；阻断则拒绝且原实例不变。
   * 目标必须是已发布快照（摘要核对），通过后复用 graph.patch 的同一权威应用路径，
   * 不另建画布编辑路径。
   */
  private async applyCompositeUpgrade(
    input: Record<string, unknown>,
    markCommitted: () => void
  ): Promise<unknown> {
    const projectId = String(input.projectId ?? '')
    const nodeId = String(input.nodeId ?? '')
    const preview = previewCompositeUpgrade(projectId, nodeId, input.nextManifest)
    if (!preview.ok) {
      const detail =
        (preview.impact?.breaking ?? [])
          .map((item) => item.portId)
          .slice(0, 8)
          .join(',') || 'invalid-next-manifest'
      throw new AccessFailure('UPGRADE_BLOCKED', 'precheck', detail)
    }
    const next = preview.nextManifest
    const record = getCompositeVersion(next.capabilityId, next.version)
    if (!record) throw new AccessFailure('NOT_FOUND', 'precheck', 'published-version')
    const hash = await compositeContentHash(next)
    if (hash !== record.contentHash)
      throw new AccessFailure('INVALID_INPUT', 'precheck', 'next-manifest-not-published-snapshot')
    const patch = (await this.executeGraphPatch(
      projectId,
      this.options.activeProjectId(),
      {
        projectId,
        expectedGraphVersion: input.expectedGraphVersion,
        ops: [
          {
            action: 'node.update',
            nodeId,
            config: {
              capabilityId: next.capabilityId,
              version: next.version,
              contentHash: record.contentHash
            }
          }
        ]
      },
      markCommitted
    )) as { graphVersion: number }
    return {
      projectId,
      nodeId,
      previousVersion: preview.previousVersion,
      version: next.version,
      graphVersion: patch.graphVersion
    }
  }

  /** F2 画布编辑的权威应用：dispatch 与 composite.upgrade.apply 共用同一条准入/应用/核对路径。 */
  private async executeGraphPatch(
    id: string,
    activeId: string | null | undefined,
    input: Record<string, unknown>,
    markCommitted: () => void
  ): Promise<unknown> {
    // F2 画布编辑走权威宿主：未打开的项目返回明确等待动作，不另建 headless 编辑路径。
    if (id !== activeId || !this.options.desktop)
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
      const mediaRef =
        op.action === 'node.create' || op.action === 'node.update' ? op.media : undefined
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
    // chat.patch 由权威宿主的独立分支整体应用；与几何 op 混批时宿主只应用会话
    // 分支会静默丢弃其余 op，因此这里在准入前明确拒绝（failed，不留半张图）。
    const patchOps = input.ops as GraphPatchOp[]
    const chatOpCount = patchOps.filter((op) => op.action === 'chat.patch').length
    if (chatOpCount > 0 && chatOpCount !== patchOps.length)
      throw new AccessFailure(
        'MIXED_PATCH_UNSUPPORTED',
        'precheck',
        'chat.patch must be submitted in its own graph.patch batch'
      )
    for (const op of patchOps) {
      if (op.action !== 'chat.patch') continue
      const chatNode = current.nodes.find((candidate) => candidate.id === op.nodeId)
      if (!chatNode || chatNode.type !== 'chat')
        throw new AccessFailure('CHAT_NODE_REQUIRED', 'precheck', op.nodeId.slice(0, 60))
      for (const chatOp of op.ops) {
        if (chatOp.action !== 'chat.message.append' || !chatOp.message.images) continue
        for (const image of chatOp.message.images) {
          const asset = listMedia(id).find((candidate) => candidate.id === image.mediaId)
          if (!asset) throw new AccessFailure('MEDIA_NOT_FOUND', 'precheck', image.mediaId)
          chatMediaResolutions[image.mediaId] = {
            mediaId: asset.id,
            mediaPath: asset.path,
            mediaMime: asset.mime,
            ...(asset.name ? { name: asset.name.slice(0, 200) } : {})
          }
        }
      }
    }
    // W3：composite 固定版本引用由存储拥有者预解析（外部 op 不带大快照）。
    const compositeResolutions: CompositeResolutionMap = {}
    for (const [opIndex, op] of patchOps.entries()) {
      if (op.action !== 'node.create' && op.action !== 'node.update') continue
      const cfg = op.config as Record<string, unknown> | undefined
      if (
        !cfg ||
        cfg.manifest ||
        typeof cfg.capabilityId !== 'string' ||
        typeof cfg.version !== 'string'
      )
        continue
      const isComposite =
        op.action === 'node.create'
          ? op.nodeType === 'composite'
          : current.nodes.find((node) => node.id === op.nodeId)?.type === 'composite'
      if (!isComposite)
        throw new AccessFailure('INVALID_INPUT', 'precheck', 'composite-ref-on-non-composite')
      const record = getCompositeVersion(cfg.capabilityId, cfg.version)
      if (!record) throw new AccessFailure('NOT_FOUND', 'precheck', 'published-version')
      if (typeof cfg.contentHash === 'string' && cfg.contentHash !== record.contentHash)
        throw new AccessFailure('INVALID_INPUT', 'precheck', 'composite-content-hash-mismatch')
      const key =
        op.action === 'node.create'
          ? op.ref
            ? `ref:${op.ref}`
            : `index:${opIndex}`
          : `node:${op.nodeId}`
      compositeResolutions[key] = { manifest: record.manifest, contentHash: record.contentHash }
    }
    const patchResult = await this.options.desktop.run(
      {
        action: 'graph-patch',
        projectId: id,
        ops: input.ops as GraphPatchOp[],
        expectedGraphVersion: input.expectedGraphVersion as number,
        ...(input.autoLayout ? { autoLayout: true } : {}),
        ...(Object.keys(mediaResolutions).length ? { mediaResolutions } : {}),
        ...(Object.keys(chatMediaResolutions).length
          ? { mediaResolutions: chatMediaResolutions }
          : {}),
        ...(Object.keys(compositeResolutions).length ? { compositeResolutions } : {})
      },
      (version) => {
        if (this.options.activeProjectId() !== id)
          throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
        this.assertNoActiveTasks(id)
        const admitted = projects.openProject(id)
        if (!admitted || admitted.meta.graphVersion !== version)
          throw new AccessFailure('REVISION_CONFLICT', 'patch-admission')
        // From this admission onward the renderer may have persisted a mutation.
        markCommitted()
        return admitted.meta
      }
    )
    // main 读取并核对：回执中的每个创建节点必须真实落盘，数量必须与保存结果一致。
    const savedFile = projects.openProject(id)
    if (!savedFile || savedFile.meta.graphVersion !== patchResult.graphVersion)
      throw new AccessFailure('REVISION_CONFLICT', 'patch-verify')
    const payload = (patchResult.result ?? {}) as {
      created?: Array<{ ref?: string; nodeId?: string }>
      groups?: Array<{ ref?: string; groupId?: string }>
      counts?: Partial<
        Record<
          'nodeCreated' | 'nodeUpdated' | 'nodeDeleted' | 'edgeCreated' | 'edgeDeleted',
          number
        >
      >
      layout?: { mode?: string; moved?: number }
    }
    const createdNodes = (payload.created ?? []).filter(
      (c): c is { ref?: string; nodeId: string } => typeof c.nodeId === 'string'
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
    return {
      projectId: id,
      graphVersion: patchResult.graphVersion,
      saved: true,
      created: createdNodes.map((c) => ({ ...(c.ref ? { ref: c.ref } : {}), nodeId: c.nodeId })),
      // group 形状只存在于画布快照里、不在节点表中，main 侧无法核对也不需要核对；
      // 但必须回传给外部，否则组合之后拿不到 groupId 就无法解组（group.delete 不可达）。
      groups: (payload.groups ?? []).filter(
        (group): group is { ref?: string; groupId: string } =>
          typeof (group as { groupId?: unknown }).groupId === 'string'
      ),
      applied: counts,
      // L2：autoLayout 启用时回传智能整理结果（模式与移动节点数）。
      ...(payload.layout &&
      (payload.layout.mode === 'flow' ||
        payload.layout.mode === 'lanes' ||
        payload.layout.mode === 'grid')
        ? { layout: { mode: payload.layout.mode, moved: payload.layout.moved ?? 0 } }
        : {})
    }
  }

  /**
   * L2 智能整理：与 graph.patch 同一权威宿主握手（版本核对 → 准入 → 原子应用 →
   * 保存屏障 → 落盘核对）。布局算法在 renderer 侧与 GUI 按钮共用 layoutGraph，
   * main 只做准入与事实核对，不另算一份坐标（避免三入口分叉）。
   */
  private async executeGraphLayout(
    id: string,
    activeId: string | null | undefined,
    input: Record<string, unknown>,
    markCommitted: () => void
  ): Promise<unknown> {
    if (id !== activeId || !this.options.desktop)
      throw new AccessFailure(
        'ACTIVE_PROJECT_REQUIRED',
        'desktop-ownership',
        'project.open the target canvas first, then retry graph.layout'
      )
    const current = projects.openProject(id)
    if (!current) throw new AccessFailure('NOT_FOUND', 'read')
    const nodeIds = input.nodeIds as string[] | undefined
    if (nodeIds) {
      const known = new Set(current.nodes.map((node) => node.id))
      const missing = nodeIds.filter((nodeId) => !known.has(nodeId))
      if (missing.length > 0)
        throw new AccessFailure('NODE_NOT_FOUND', 'precheck', missing[0]!.slice(0, 60))
    }
    const layoutResult = await this.options.desktop.run(
      {
        action: 'graph-layout',
        projectId: id,
        layoutMode: (input.mode as 'auto' | 'flow' | 'lanes' | 'grid' | undefined) ?? 'auto',
        ...(nodeIds ? { nodeIds } : {}),
        expectedGraphVersion: input.expectedGraphVersion as number
      },
      (version) => {
        if (this.options.activeProjectId() !== id)
          throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
        this.assertNoActiveTasks(id)
        const admitted = projects.openProject(id)
        if (!admitted || admitted.meta.graphVersion !== version)
          throw new AccessFailure('REVISION_CONFLICT', 'layout-admission')
        markCommitted()
        return admitted.meta
      }
    )
    const savedFile = projects.openProject(id)
    if (!savedFile || savedFile.meta.graphVersion !== layoutResult.graphVersion)
      throw new AccessFailure('REVISION_CONFLICT', 'layout-verify')
    const payload = (layoutResult.result ?? {}) as { mode?: string; moved?: number }
    const mode =
      payload.mode === 'flow' || payload.mode === 'lanes' || payload.mode === 'grid'
        ? payload.mode
        : 'grid'
    return {
      projectId: id,
      graphVersion: layoutResult.graphVersion,
      saved: true,
      mode,
      moved: payload.moved ?? 0
    }
  }

  /**
   * C3：状态机人工事件提交。渲染器权威动作核对实例修订并写 meta.stateMachinePending
   * （与 GUI 按钮同一写入）；main 核对落盘事实。事件迁移合法性由运行时执行器校验，
   * 外部不能直接改状态——满足"模型文字不能直接赋予成功状态"的协同门槛。
   */
  private async executeStateMachineEvent(
    id: string,
    activeId: string | null | undefined,
    input: Record<string, unknown>
  ): Promise<unknown> {
    if (id !== activeId || !this.options.desktop)
      throw new AccessFailure(
        'ACTIVE_PROJECT_REQUIRED',
        'desktop-ownership',
        'project.open the target canvas first, then retry flowStateMachine.submitEvent'
      )
    const current = projects.openProject(id)
    if (!current) throw new AccessFailure('NOT_FOUND', 'read')
    const nodeId = input.nodeId as string
    const node = current.nodes.find((item) => item.id === nodeId)
    if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'precheck', nodeId.slice(0, 60))
    if (node.type !== 'state-machine')
      throw new AccessFailure('INVALID_INPUT', 'precheck', 'state-machine-node-required')
    const reply = await this.options.desktop.run(
      {
        action: 'state-machine-event',
        projectId: id,
        nodeId,
        stateMachineEvent: input.event as string,
        stateMachineExpectedRevision: input.expectedRevision as number,
        ...(typeof input.eventId === 'string' ? { stateMachineEventId: input.eventId } : {})
      },
      (version) => {
        if (this.options.activeProjectId() !== id)
          throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
        const admitted = projects.openProject(id)
        if (!admitted || admitted.meta.graphVersion !== version)
          throw new AccessFailure('REVISION_CONFLICT', 'event-admission')
        return admitted.meta
      },
      30000
    )
    const saved = projects.openProject(id)
    if (!saved) throw new AccessFailure('REVISION_CONFLICT', 'event-verify')
    const payload = (reply.result ?? {}) as {
      revision?: number
      eventId?: string
      event?: string
    }
    // 落盘核对：待处理事件必须真实写入目标节点 meta。
    const shape = (
      saved.tldrawSnapshot as { store: Record<string, { meta?: Record<string, unknown> }> }
    ).store[nodeId]
    const pendingRaw = shape?.meta?.stateMachinePending
    const pending =
      typeof pendingRaw === 'string'
        ? (JSON.parse(pendingRaw) as {
            eventId?: string
            event?: string
            expectedRevision?: number
          })
        : null
    if (
      !pending ||
      pending.event !== (input.event as string) ||
      pending.expectedRevision !== (input.expectedRevision as number) ||
      (payload.eventId !== undefined && pending.eventId !== payload.eventId)
    )
      throw new AccessFailure('STORAGE_INCONSISTENT', 'event-verify')
    return {
      projectId: id,
      nodeId,
      graphVersion: saved.meta.graphVersion,
      revision: payload.revision ?? (input.expectedRevision as number),
      eventId: pending.eventId ?? '',
      event: pending.event ?? (input.event as string),
      pending: true
    }
  }

  /** C3：状态机只读视图——当前阶段/修订/合法出边事件/待处理提交（持久化事实）。 */
  private readStateMachine(id: string, input: Record<string, unknown>): unknown {
    const file = projects.openProject(id)
    if (!file) throw new AccessFailure('NOT_FOUND', 'read')
    const nodeId = input.nodeId as string
    const node = file.nodes.find((item) => item.id === nodeId)
    if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'read', nodeId.slice(0, 60))
    if (node.type !== 'state-machine')
      throw new AccessFailure('INVALID_INPUT', 'read', 'state-machine-node-required')
    const shape = (
      file.tldrawSnapshot as {
        store: Record<string, { props?: { config?: string }; meta?: Record<string, unknown> }>
      }
    ).store[nodeId]
    let config: {
      initialState?: string
      transitions?: Array<{ from: string; event: string; to: string }>
    }
    try {
      config = JSON.parse(shape?.props?.config || '{}')
    } catch {
      throw new AccessFailure('INVALID_INPUT', 'read', 'state-machine-config-invalid')
    }
    const instance = parseStateMachineInstance(shape?.meta?.stateMachine)
    const state = instance?.state ?? String(config.initialState ?? '')
    const revision = instance?.revision ?? 1
    const legalEvents = [
      ...new Set(
        (Array.isArray(config.transitions) ? config.transitions : [])
          .filter((transition) => transition.from === state)
          .map((transition) => transition.event)
      )
    ]
    const pending = parseStateMachinePending(shape?.meta?.stateMachinePending)
    return {
      projectId: id,
      nodeId,
      state,
      revision,
      legalEvents,
      pending: pending
        ? {
            eventId: pending.eventId,
            event: pending.event,
            expectedRevision: pending.expectedRevision
          }
        : null
    }
  }

  /**
   * C4：人工任务结果提交。渲染器权威动作核对实例修订并写 meta.humanTaskPending
   * （与 GUI 按钮同一写入）；main 核对落盘事实。完成状态由运行时执行器校验，
   * 外部不能直接改完成状态——满足「模型文字不能直接赋予成功状态」的协同门槛。
   */
  /** W4 受控重试：仅 failed/interrupted 的 headless 运行可按原固定版本与原公开输入复跑；
   * 同一根运行重试上限 3 次；输入未记录（M32 前的旧运行）明确拒绝，不伪造输入。 */
  private async executeCompositeRunRetry(input: Record<string, unknown>): Promise<unknown> {
    if (!this.options.desktop)
      throw new AccessFailure(
        'DESKTOP_UNAVAILABLE',
        'desktop-ownership',
        'retry requires the desktop host running'
      )
    const runId = String(input.runId ?? '')
    const existing = getCompositeRun(runId)?.run
    if (!existing) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
    if (existing.status !== 'failed' && existing.status !== 'interrupted')
      throw new AccessFailure('RUN_NOT_RETRYABLE', 'precheck', `status:${existing.status}`)
    const rootRunId = existing.retryOf ?? existing.id
    const retriesUsed = countCompositeRetries(rootRunId)
    if (retriesUsed >= 3)
      throw new AccessFailure('RETRY_LIMIT_EXCEEDED', 'precheck', 'max 3 retries per root run')
    const record = getCompositeVersion(existing.capabilityId, existing.capabilityVersion)
    if (!record) throw new AccessFailure('VERSION_NOT_PUBLISHED', 'precheck', 'published-version')
    const validation = validateCompositeManifest(record.manifest)
    if (!validation.ok) throw new AccessFailure('STORAGE_INCONSISTENT', 'read', 'manifest-invalid')
    if (!existing.inputValues)
      throw new AccessFailure('INPUTS_NOT_RECORDED', 'precheck', 'run predates input persistence')
    // 媒体输入按 mediaId 重新解析（资产可能已清理）；非媒体值按原样复跑。
    const resolvedInputs: Array<{ portId: string; value: unknown }> = []
    for (const [portId, raw] of Object.entries(existing.inputValues)) {
      const value = raw as { kind?: string; mediaId?: string }
      if (value?.kind === 'media' || (value && 'mediaPath' in (value as object))) {
        const asset = getMediaAsset(String(value.mediaId ?? ''))
        if (!asset) throw new AccessFailure('NOT_FOUND', 'precheck', `media:${value.mediaId}`)
        resolvedInputs.push({
          portId,
          value: { kind: asset.kind, mediaId: asset.id, mediaPath: asset.path, mime: asset.mime }
        })
      } else {
        resolvedInputs.push({ portId, value: raw })
      }
    }
    const newRunId = randomUUID()
    try {
      await this.options.desktop.run({
        action: 'execute-composite-headless',
        projectId: `headless-${newRunId}`,
        compositeManifest: record.manifest,
        compositeInputs: resolvedInputs,
        ownRunId: newRunId,
        compositeInputValues: Object.fromEntries(
          resolvedInputs.map((entry) => [entry.portId, entry.value])
        ),
        compositeRetryOf: rootRunId
      })
    } catch (error) {
      if (error instanceof DesktopAccessError && !error.unknownOutcome)
        throw new AccessFailure(error.code, 'execute-handshake', error.detail)
      throw error
    }
    return {
      runId: newRunId,
      retryOf: rootRunId,
      capabilityId: existing.capabilityId,
      version: existing.capabilityVersion,
      status: 'running',
      retriesUsed: retriesUsed + 1
    }
  }

  /** AF-07：向等待人工的节点流提交某内部人工任务结果（满足开放人工等待）。 */
  private executeCompositeSubmitHuman(input: Record<string, unknown>): unknown {
    const runId = String(input.runId ?? '')
    const nodeId = String(input.nodeId ?? '')
    const existing = getCompositeRun(runId)?.run
    if (!existing) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
    if (existing.status !== 'waiting-input')
      throw new AccessFailure('RUN_NOT_WAITING', 'precheck', `status:${existing.status}`)
    const wait = getOpenCompositeRunWait(runId)
    if (!wait || wait.stepKey !== nodeId)
      throw new AccessFailure('HUMAN_WAIT_NOT_FOUND', 'precheck', `node:${nodeId}`)
    const satisfied = satisfyCompositeRunWait({
      requestId: wait.requestId,
      revision: wait.revision,
      value: input.value,
      submittedBy: 'external'
    })
    if (!satisfied.ok)
      throw new AccessFailure(satisfied.reason ?? 'HUMAN_WAIT_REJECTED', 'precheck', 'wait')
    return { runId, nodeId, satisfied: true }
  }

  /** AF-07：续跑等待人工的节点流——消费已满足提交、跳过已完成步骤（保护已付费任务）。 */
  private async executeCompositeRunResume(input: Record<string, unknown>): Promise<unknown> {
    if (!this.options.desktop)
      throw new AccessFailure(
        'DESKTOP_UNAVAILABLE',
        'desktop-ownership',
        'resume requires the desktop host running'
      )
    const runId = String(input.runId ?? '')
    const existing = getCompositeRun(runId)?.run
    if (!existing) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
    if (existing.status !== 'waiting-input')
      throw new AccessFailure('RUN_NOT_WAITING', 'precheck', `status:${existing.status}`)
    const record = getCompositeVersion(existing.capabilityId, existing.capabilityVersion)
    if (!record) throw new AccessFailure('VERSION_NOT_PUBLISHED', 'precheck', 'published-version')
    const validation = validateCompositeManifest(record.manifest)
    if (!validation.ok) throw new AccessFailure('STORAGE_INCONSISTENT', 'read', 'manifest-invalid')
    // 已完成步骤（completed）跳过重跑；其输出回放供下游消费。
    const steps = getCompositeRun(runId)?.steps ?? []
    const completedSteps = steps.filter((s) => s.status === 'completed').map((s) => s.stepKey)
    const stepOutputs = getCompositeStepOutputs(runId)
    // 已满足的人工等待 → 提交值（按节点），续跑消费为正式输出。
    const humanSubmissions = getSatisfiedHumanSubmissions(runId)
    const resolvedInputs: Array<{ portId: string; value: unknown }> = []
    for (const [portId, raw] of Object.entries(existing.inputValues ?? {})) {
      const value = raw as { kind?: string; mediaId?: string }
      if (value?.kind === 'media' || (value && 'mediaPath' in (value as object))) {
        const asset = getMediaAsset(String(value.mediaId ?? ''))
        if (!asset) throw new AccessFailure('NOT_FOUND', 'precheck', `media:${value.mediaId}`)
        resolvedInputs.push({
          portId,
          value: { kind: asset.kind, mediaId: asset.id, mediaPath: asset.path, mime: asset.mime }
        })
      } else {
        resolvedInputs.push({ portId, value: raw })
      }
    }
    try {
      await this.options.desktop.run({
        action: 'execute-composite-headless',
        projectId: `headless-${runId}`,
        compositeManifest: record.manifest,
        compositeInputs: resolvedInputs,
        ownRunId: runId,
        compositeResumeRunId: runId,
        compositeHumanSubmissions: humanSubmissions,
        compositeCompletedSteps: completedSteps,
        compositeStepOutputs: stepOutputs
      })
    } catch (error) {
      if (error instanceof DesktopAccessError && !error.unknownOutcome)
        throw new AccessFailure(error.code, 'execute-handshake', error.detail)
      throw error
    }
    return {
      runId,
      capabilityId: existing.capabilityId,
      version: existing.capabilityVersion,
      status: 'running'
    }
  }

  /** W4 人工补交：仅 failed/interrupted 可补交；须一次性补齐全部公开输出端口，
   * 类型与端口声明兼容；补交后 completed 但 manualSubmission=true 如实标记。 */
  private executeCompositeRunResubmit(input: Record<string, unknown>): unknown {
    const runId = String(input.runId ?? '')
    const existing = getCompositeRun(runId)?.run
    if (!existing) throw new AccessFailure('NOT_FOUND', 'read', 'composite-run')
    if (existing.status !== 'failed' && existing.status !== 'interrupted')
      throw new AccessFailure('RUN_NOT_RESUBMITTABLE', 'precheck', `status:${existing.status}`)
    const record = getCompositeVersion(existing.capabilityId, existing.capabilityVersion)
    if (!record) throw new AccessFailure('VERSION_NOT_PUBLISHED', 'precheck', 'published-version')
    const outputs = (input.outputs ?? []) as Array<{
      portId: string
      value: { kind: 'text' | 'markdown' | 'json'; text?: string; data?: unknown }
    }>
    const declared = record.manifest.outputs
    const submittedIds = outputs.map((entry) => entry.portId)
    if (
      new Set(submittedIds).size !== submittedIds.length ||
      submittedIds.length !== declared.length ||
      declared.some((port) => !submittedIds.includes(port.id))
    )
      throw new AccessFailure(
        'OUTPUT_PORTS_MISMATCH',
        'precheck',
        'all public outputs required exactly once'
      )
    const outputValues: Record<string, unknown> = {}
    for (const entry of outputs) {
      const port = declared.find((item) => item.id === entry.portId)!
      const kind = entry.value.kind
      const compatible =
        port.type === 'any' || port.type === kind || (port.type === 'text' && kind === 'markdown')
      if (!compatible)
        throw new AccessFailure('OUTPUT_TYPE_INVALID', 'precheck', `${entry.portId}:${port.type}`)
      outputValues[entry.portId] = entry.value
    }
    const changed = resubmitCompositeRun({
      runId,
      outputPorts: declared.map((port) => ({
        portId: port.id,
        kind: outputValues[port.id] ? (outputValues[port.id] as { kind: string }).kind : 'text'
      })),
      outputValues
    })
    if (!changed) throw new AccessFailure('RUN_NOT_RESUBMITTABLE', 'precheck', 'state-race')
    return { runId, status: 'completed', manualSubmission: true, outputPorts: submittedIds }
  }

  private async executeHumanTaskSubmit(
    id: string,
    activeId: string | null | undefined,
    input: Record<string, unknown>
  ): Promise<unknown> {
    if (id !== activeId || !this.options.desktop)
      throw new AccessFailure(
        'ACTIVE_PROJECT_REQUIRED',
        'desktop-ownership',
        'project.open the target canvas first, then retry humanTask.submit'
      )
    const current = projects.openProject(id)
    if (!current) throw new AccessFailure('NOT_FOUND', 'read')
    const nodeId = input.nodeId as string
    const node = current.nodes.find((item) => item.id === nodeId)
    if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'precheck', nodeId.slice(0, 60))
    if (node.type !== 'human-task')
      throw new AccessFailure('INVALID_INPUT', 'precheck', 'human-task-node-required')
    const value = input.value as { kind: 'text'; text: string } | { kind: 'json'; data: unknown }
    const reply = await this.options.desktop.run(
      {
        action: 'human-task-submit',
        projectId: id,
        nodeId,
        humanTaskExpectedRevision: input.expectedRevision as number,
        humanTaskValue: value,
        ...(typeof input.submissionId === 'string'
          ? { humanTaskSubmissionId: input.submissionId }
          : {})
      },
      (version) => {
        if (this.options.activeProjectId() !== id)
          throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
        const admitted = projects.openProject(id)
        if (!admitted || admitted.meta.graphVersion !== version)
          throw new AccessFailure('REVISION_CONFLICT', 'human-task-admission')
        return admitted.meta
      },
      30000
    )
    const saved = projects.openProject(id)
    if (!saved) throw new AccessFailure('REVISION_CONFLICT', 'human-task-verify')
    const payload = (reply.result ?? {}) as { revision?: number; submissionId?: string }
    const shape = (
      saved.tldrawSnapshot as { store: Record<string, { meta?: Record<string, unknown> }> }
    ).store[nodeId]
    const pendingRaw = shape?.meta?.humanTaskPending
    const pending =
      typeof pendingRaw === 'string' && pendingRaw.trim()
        ? (JSON.parse(pendingRaw) as { submissionId?: string; expectedRevision?: number })
        : null
    if (
      !pending ||
      pending.expectedRevision !== (input.expectedRevision as number) ||
      (payload.submissionId !== undefined && pending.submissionId !== payload.submissionId)
    )
      throw new AccessFailure('STORAGE_INCONSISTENT', 'human-task-verify')
    return {
      projectId: id,
      nodeId,
      graphVersion: saved.meta.graphVersion,
      revision: payload.revision ?? (input.expectedRevision as number),
      submissionId: pending.submissionId ?? '',
      pending: true
    }
  }

  /** C4：人工任务只读视图——当前状态/修订/已交付结果/待处理提交（持久化事实）。 */
  private readHumanTask(id: string, input: Record<string, unknown>): unknown {
    const file = projects.openProject(id)
    if (!file) throw new AccessFailure('NOT_FOUND', 'read')
    const nodeId = input.nodeId as string
    const node = file.nodes.find((item) => item.id === nodeId)
    if (!node) throw new AccessFailure('NODE_NOT_FOUND', 'read', nodeId.slice(0, 60))
    if (node.type !== 'human-task')
      throw new AccessFailure('INVALID_INPUT', 'read', 'human-task-node-required')
    const shape = (
      file.tldrawSnapshot as {
        store: Record<string, { props?: { config?: string }; meta?: Record<string, unknown> }>
      }
    ).store[nodeId]
    const config = HumanTaskNodeConfigSchema.safeParse(
      (() => {
        try {
          return JSON.parse(shape?.props?.config || '{}')
        } catch {
          return null
        }
      })()
    )
    const outputType = config.success ? config.data.outputType : 'text'
    const instance = HumanTaskInstanceSchema.safeParse(
      (() => {
        try {
          return JSON.parse(String(shape?.meta?.humanTask ?? ''))
        } catch {
          return null
        }
      })()
    )
    const status = instance.success ? instance.data.status : 'pending'
    const revision = instance.success ? instance.data.revision : 1
    const result =
      instance.success && instance.data.status === 'completed'
        ? (instance.data.result ?? null)
        : null
    const pending = HumanTaskPendingSchema.safeParse(
      (() => {
        try {
          return JSON.parse(String(shape?.meta?.humanTaskPending ?? ''))
        } catch {
          return null
        }
      })()
    )
    return {
      projectId: id,
      nodeId,
      status,
      revision,
      outputType,
      result,
      pending: pending.success
        ? {
            submissionId: pending.data.submissionId,
            expectedRevision: pending.data.expectedRevision
          }
        : null
    }
  }

  private async execute(
    operation: AccessOperationId,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const id = input.projectId as string
    switch (operation) {
      case 'media.getRecipe':
      case 'media.batchExport':
        // F7 收尾：在 dispatch 分组分支委托 media-assets-ops 执行（需要受控导出目录），
        // 不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
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
        // 一次查出本项目"有生成谱系"的媒体，避免 Agent 逐条再调 getRecipe 试探。
        const withRecipe = new Set(mediaIdsWithRecipe(id))
        return {
          projectId: id,
          total: all.length,
          items: all
            .slice(input.offset as number, (input.offset as number) + (input.limit as number))
            .map((asset) => ({
              id: asset.id,
              mediaId: asset.id,
              kind: asset.kind,
              mime: asset.mime,
              path: asset.path,
              sizeBytes: asset.sizeBytes,
              name: (asset.name ?? '').slice(0, 200),
              hasRecipe: withRecipe.has(asset.id)
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
        if (!asset)
          throw new AccessFailure('MEDIA_NOT_FOUND', 'read', String(input.mediaId).slice(0, 40))
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
      case 'node.runPlan': {
        if (id !== this.options.activeProjectId() || !this.options.desktop)
          throw new AccessFailure('ACTIVE_PROJECT_REQUIRED', 'workflow-preflight')
        const plan = await this.options.desktop.run({
          action: 'workflow-run-plan',
          projectId: id,
          nodeIds: input.nodeIds as string[]
        })
        return { ...(plan.result as object), graphVersion: plan.graphVersion }
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
      case 'director.publish.prepare':
      case 'director.publish.status':
      case 'director.publish.continue':
        // 发布授权协议在 dispatch 里按桌面握手处理；走到这里说明宿主前置条件不成立。
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
      case 'node.library.compose':
      case 'node.library.update':
      case 'node.library.delete':
      case 'node.library.get':
      case 'node.library.search':
      case 'node.library.insert':
      case 'history.list':
      case 'history.snapshot.create':
      case 'history.snapshot.delete':
      case 'history.restore.precheck':
      case 'history.restore':
      case 'history.recovery.precheck':
      case 'history.recovery.resolve':
        // F7：这些操作在 dispatch 分支带 trace/span 与占用回调执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
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
      case 'diagnostics.query':
      case 'diagnostics.exportBundle':
      case 'diagnostics.exportNodeRun':
      case 'workspace.palettePreferences.get':
      case 'workspace.palettePreferences.save':
      case 'project.nodeVisibility.get':
      case 'project.nodeVisibility.set':
        // F9：在 dispatch 分组分支里执行（需要 trace/span 与装配层依赖），不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
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
          // 机器可读的错误码目录：Agent 可以据此分支，而不是靠猜文本。
          errorCatalog: ACCESS_ERROR_CATALOG,
          limitations: [
            'DESKTOP_HANDSHAKE_REQUIRED',
            'EXPORT_DIRECTORY_ONLY',
            // 导演台是 manual-publish：外部只能申请，必须由人在 GUI 授权后继续。
            'DIRECTOR_PUBLISH_REQUIRES_HUMAN_AUTHORIZATION'
          ]
        }
      case 'node.type.list':
        // F9：逐节点逐动作矩阵（N1–N8）——不再一律报 planned，状态与证据可审计。
        return { nodes: nodeAccessDirectory(), summary: nodeAccessDirectorySummary() }
      case 'node.type.get': {
        // N1：不创建实例即可查询类型契约（端口/初始配置/执行方式/输出真值来源）。
        // 数据来自生成快照，快照由 test/node-contracts-export.test.ts 做漂移门禁。
        const contract = nodeContract(input.typeId as string)
        if (!contract) throw new AccessFailure('UNSUPPORTED_CONTRACT', 'node-type-read')
        return contract
      }
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
      // F7 包传输：业务实现在 ./transfer-ops（复用 GUI 同一导入导出服务）；
      // 外部入口只负责受控导出目录边界、提交后核对与 sha256/字节回执。
      case 'project.import': {
        const outcome = importProjectPackage(input, this.exportRoot)
        if (!outcome.ok) throw new AccessFailure(outcome.code, outcome.phase, outcome.detail)
        return outcome.data
      }
      case 'project.importStructure': {
        const outcome = importStructurePackage(input, this.exportRoot)
        if (!outcome.ok) throw new AccessFailure(outcome.code, outcome.phase, outcome.detail)
        return outcome.data
      }
      case 'library.import': {
        const outcome = importLibraryPackage(input, this.exportRoot)
        if (!outcome.ok) throw new AccessFailure(outcome.code, outcome.phase, outcome.detail)
        return outcome.data
      }
      case 'library.export': {
        const outcome = exportLibraryPackage(input, this.exportRoot)
        if (!outcome.ok) throw new AccessFailure(outcome.code, outcome.phase, outcome.detail)
        return outcome.data
      }
      case 'project.exportStructure': {
        // 缺画布快照时先经权威宿主做一次保存屏障（外部不再依赖"先人工打开保存一次"）。
        const outcome = await exportStructurePackage(input, this.exportRoot, this.options.desktop)
        if (!outcome.ok) throw new AccessFailure(outcome.code, outcome.phase, outcome.detail)
        return outcome.data
      }
      // F7 资源库族：业务实现在 ./library-ops（复用 GUI 同一 store 服务）；
      // 物化走与 graph.patch 相同的权威宿主握手，不新造桌面通道。
      case 'library.resource.list':
      case 'library.resource.get':
      case 'library.resource.preview_files':
      case 'library.resource.create':
      case 'library.resource.publish':
      case 'library.resource.delete':
      case 'library.resource.delete_many':
      case 'library.resource.archive':
      case 'library.resource.set_folder':
      case 'library.resource.set_collections':
      case 'library.folder.list':
      case 'library.folder.create':
      case 'library.folder.rename':
      case 'library.folder.delete':
      case 'library.collection.list':
      case 'library.collection.create':
      case 'library.category.list':
      case 'library.category.save':
      case 'library.resource.materialize':
      case 'library.materialization.discard': {
        const outcome = await runLibraryOperation(operation, input, {
          desktop: this.options.desktop,
          activeProjectId: () => this.options.activeProjectId()
        })
        if (!outcome.ok) throw new AccessFailure(outcome.code, outcome.phase, outcome.detail)
        return outcome.data
      }
      case 'library.captureProjectMedia':
      case 'library.captureProjectNodes':
        // F7 收尾：资源捕获在 dispatch 分组分支委托 library-capture-ops 执行，不落在这里。
        // 注意：必须放在 library 组的**之后**，否则会打断上面 case 组的 fall-through，
        // 让整族操作都落进这个 throw（曾经真的踩过）。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'graph.patch':
        // graph.patch 在 dispatch 中经权威宿主握手执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'flowAgent.inspect':
      case 'flowStage.context.preview':
      case 'flowStage.rework':
      case 'flowDefinition.publish':
      case 'flowDefinition.list':
      case 'flowDefinition.get':
      case 'flowDefinition.diff':
      case 'flowAgent.catalog':
      case 'flowAgent.collaboration':
      case 'flowAgent.cooperate':
      case 'flowAgent.run':
      case 'flowAgent.pause':
      case 'flowAgent.stop':
      case 'flowAgent.build.inspect':
      case 'flowAgent.build.propose':
      case 'flowAgent.build.commit':
      case 'flowAgent.review':
      case 'flowAsset.submit':
      case 'flowAsset.list':
      case 'flowAsset.read':
        // F8：Flow 观察/运行控制/固定资产在 dispatch 分组分支委托 flow-*-ops 执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'flow.command.lookup':
      case 'flow.command.availability':
      case 'flow.command.reconcile':
      case 'flow.command.check':
      case 'flow.command.dispatch':
      case 'flow.command.abort':
        // F8（二/收官）：命令账本协作在 dispatch 分组分支委托 flow-commands-ops 执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'model.connection.list':
      case 'model.definition.list':
      case 'model.binding.list':
      case 'model.binding.resolve':
      case 'environment.local':
      case 'environment.videoEngine.status':
      case 'environment.videoEngine.install':
        // F9（二/四）：模型目录、环境状态读取与视频引擎安装启动在 dispatch 分组分支委托
        // settings-ops 执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'model.connection.save':
      case 'model.credential.status':
      case 'model.connection.delete':
      case 'model.definition.save':
      case 'model.definition.delete':
      case 'model.definition.deleteMany':
      case 'model.binding.save':
        // F9（四）：模型连接与受控凭据写入委托 model-admin-ops 执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'node.execute':
      case 'run.cancel':
        // 同上：执行与取消需要权威宿主握手，在 dispatch 分支处理。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'canvas.history':
      case 'project.close':
        // F2：撤销/重做与关闭项目需要权威宿主（历史栈在 editor 里），在 dispatch 分支处理。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'provider.list':
      case 'provider.listExecutable':
      case 'provider.exportableConnections':
        // F9 收尾：供应商目录只读投影在 dispatch 分组分支执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'provider.testConnection':
      case 'model.validate':
      case 'model.discover':
      case 'model.validateAgentToolCalling':
        // F9：需要显式确认才联网，在 dispatch 分组分支执行。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'provider.package.export':
      case 'provider.package.seal':
      case 'provider.package.preview':
      case 'provider.save':
      case 'provider.delete':
      case 'provider.probe':
      case 'provider.package.import':
      case 'provider.package.importProviders':
      case 'dreamina.logout':
      case 'dreamina.login.start':
      case 'dreamina.login.check':
        // F9：凭据包导出/预览在 dispatch 分组分支执行（需要受控导出目录与共享服务实例）。
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
        const readData = parseChatShared(
          chatNode.content.kind === 'text' ? chatNode.content.text : ''
        )
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
            active: conversation.id === (readData.activeConversationId ?? conversations[0]?.id)
          }))
        }
      }
      case 'chat.messages': {
        const file = projects.openProject(id)
        if (!file) throw new AccessFailure('NOT_FOUND', 'read')
        const chatNode = file.nodes.find((candidate) => candidate.id === input.nodeId)
        if (!chatNode) throw new AccessFailure('NODE_NOT_FOUND', 'read')
        if (chatNode.type !== 'chat') throw new AccessFailure('CHAT_NODE_REQUIRED', 'read')
        const msgData = parseChatShared(
          chatNode.content.kind === 'text' ? chatNode.content.text : ''
        )
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
    return unhandledOperation(operation as never)
  }
}
