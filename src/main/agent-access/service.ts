import { FlowSkillStore } from '../agent-flow/skill-store'
import { accessSkillAgent, chatNodeAgent, installAccessSkill, skillSummary } from './skills'
import { listWorkflowTemplates, saveWorkflowTemplate } from '../store/workspace-state.repo'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
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
  operationSpec,
  type AccessOperationId,
  type AccessResponse
} from '../../shared/agent-access/registry'
import { toGraphView } from '../../shared/agent-access/graph-ops'
import {
  GraphVersionConflictError,
  GraphWriteInProgressError
} from '../../shared/graph-snapshot-sync'
import { newTraceId, newSpanId } from '../../shared/observability'
import { getDb, getSetting, setSetting } from '../store/db'
import * as projects from '../store/projects.repo'
import { deleteMedia, importMedia, listMedia } from '../store/media.repo'
import { listArtifactRecipes } from '../store/artifact-recipes.repo'
import { exportProject } from '../store/transfer'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { ACCESS_ERROR_CATALOG } from '../../shared/agent-access/metadata'
import { assertLicenseActive } from '../security/license/gate'
import { DesktopAccessError, type AccessDesktop } from './desktop'
import { AccessFailure } from './access-failure'
import {
  applyCompositeUpgradeOp,
  confirmGraphPatchOp,
  discardGraphPatchOp,
  executeGraphLayoutOp,
  executeGraphPatchOp,
  proposeGraphPatchOp
} from './graph-patch-ops'
import {
  executeCompositeHeadlessOp,
  executeCompositeRunResubmitOp,
  executeCompositeRunResumeOp,
  executeCompositeRunRetryOp,
  executeCompositeSubmitHumanOp,
  waitCompositeHeadlessOp
} from './composite-run-ops'
import {
  executeHumanTaskSubmitOp,
  executeStateMachineEventOp,
  readHumanTaskOp,
  readStateMachineOp
} from './flow-state-human-ops'
import { runDirectorPublishOperation } from './director-publish-ops'
import {
  assertProjectHasNoActiveTasks,
  buildImpactToken,
  isProjectTaskOccupied,
  runProjectDelete,
  runProjectDeletePrecheck
} from './project-delete-ops'
import { runNodeLibraryOperation } from './node-library-ops'
import { runCompositeOperation } from './composite-ops'
import { COMPOSITE_OPERATION_IDS } from '../../shared/agent-access/ops/composite'
import { runHistoryOperation } from './history-ops'
import { FLOW_AGENT_OPERATION_IDS, runFlowAgentOperation } from './flow-agents-ops'
import { FLOW_AGENT_RUN_OPERATION_IDS, runFlowAgentRunOperation } from './flow-agent-run-ops'
import { FLOW_AGENT_BUILD_OPERATION_IDS, runFlowAgentBuildOperation } from './flow-agent-build-ops'
import { nodeContract } from '../../shared/agent-access/node-contracts'
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
import { recoverAbandonedPublishRequests } from './publish'
import {
  exportLibraryPackage,
  exportStructurePackage,
  importLibraryPackage,
  importProjectPackage,
  importStructurePackage
} from './transfer-ops'
import { runLibraryOperation } from './library-ops'

export { AccessFailure } from './access-failure'

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
  'node.library.replace',
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
    const parsed = AccessRequestSchema.safeParse(raw)
    const base: AccessResponse = {
      apiVersion: 1,
      requestId: parsed.success ? parsed.data.requestId : 'invalid',
      operationId: parsed.success ? parsed.data.operationId : 'invalid',
      traceId: newTraceId(),
      status: 'failed'
    }
    // 授权守卫：授权失效后立即停止响应外部操作，但必须返回稳定错误对象。
    try {
      assertLicenseActive('agent.access.dispatch')
    } catch {
      return {
        ...base,
        status: 'failed',
        error: { code: 'AUTH_FAILED', phase: 'authorization', retryable: false }
      }
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
      const spec = operationSpec(operationId)
      if (request.operationVersion !== (spec.operationVersion ?? 1))
        throw new AccessFailure('UNSUPPORTED_OPERATION_VERSION', 'validate')
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
          .update(JSON.stringify({ operationId, version: spec.operationVersion ?? 1, input: checked.data }))
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
        // cooperate 的作用对象就是既有 waiting 任务；宿主仍核对 task/revision/waitKind。
        operationId !== 'flowAgent.cooperate' &&
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
        if (executeFile.meta.graphVersion !== input.expectedGraphVersion)
          throw new AccessFailure(
            'REVISION_CONFLICT',
            'execute-admission',
            'expectedGraphVersion is stale',
            executeFile.meta.graphVersion
          )
        if (input.mode === 'single' && (input.nodeIds as string[]).length !== 1)
          throw new AccessFailure('INVALID_INPUT', 'precheck', 'single mode requires exactly one nodeId')
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
            expectedGraphVersion: input.expectedGraphVersion as number,
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
        result = await executeCompositeHeadlessOp(this.options, input)
      } else if (operationId === 'composite.execute.wait') {
        result = await waitCompositeHeadlessOp(input)
      } else if (operationId === 'composite.run.retry') {
        result = await executeCompositeRunRetryOp(this.options, input)
      } else if (operationId === 'composite.run.resubmit') {
        result = await executeCompositeRunResubmitOp(this.options, input, {
          requestId: request.requestId,
          traceId: base.traceId,
          spanId
        })
      } else if (operationId === 'composite.run.submitHuman') {
        result = await executeCompositeSubmitHumanOp(this.options, input, {
          requestId: request.requestId,
          traceId: base.traceId,
          spanId
        })
      } else if (operationId === 'composite.run.resume') {
        result = await executeCompositeRunResumeOp(this.options, input)
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
        result = await executeGraphPatchOp(this.options, id!, active, input, () => {
          metadataCommitted = true
        })
      } else if (operationId === 'graph.patch.propose') {
        result = proposeGraphPatchOp(this.options, id!, active, input)
      } else if (operationId === 'graph.patch.confirm') {
        result = await confirmGraphPatchOp(
          this.options,
          id!,
          active,
          input,
          { requestId: request.requestId, traceId: base.traceId, spanId },
          () => {
            metadataCommitted = true
          }
        )
      } else if (operationId === 'graph.patch.discard') {
        result = discardGraphPatchOp(id!, input)
      } else if (operationId === 'graph.layout') {
        result = await executeGraphLayoutOp(this.options, id!, active, input, () => {
          metadataCommitted = true
        })
      } else if (
        operationId === 'director.publish.prepare' ||
        operationId === 'director.publish.status' ||
        operationId === 'director.publish.continue'
      ) {
        result = await runDirectorPublishOperation(
          this.options,
          operationId,
          id!,
          active,
          input,
          () => {
            metadataCommitted = true
          },
          () => metadataCommitted
        )
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
                  buildImpactToken(this.dataStoreId, this.hmacKey, projectId, graphVersion, facts, expiresAt)
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
          clientId: request.clientId ?? 'cli',
          ...(key ? { idempotencyKey: key } : {}),
          diagnostics: { requestId: request.requestId, traceId: base.traceId, spanId }
        }
        result = FLOW_AGENT_OPERATION_IDS.has(operationId)
          ? await runFlowAgentOperation(operationId, input, flowContext)
          : await runFlowAssetOperation(operationId, input, flowContext)
      } else if (FLOW_AGENT_RUN_OPERATION_IDS.has(operationId)) {
        // F8（第二批）：Agent 运行控制只经由启动时创建的那一个宿主实例（flow-bridge 窄接口），
        // 外部不新建宿主、不自造运行身份；start/continue 先走与 IPC 入口相同的模型工具调用预检。
        result = await runFlowAgentRunOperation(operationId, input, {
          activeProjectId: this.options.activeProjectId,
          desktop: this.options.desktop,
          clientId: request.clientId,
          diagnostics: { requestId: request.requestId, traceId: base.traceId, spanId }
        })
      } else if (operationId === 'flowStateMachine.submitEvent') {
        result = await executeStateMachineEventOp(this.options, id!, active, input, {
          requestId: request.requestId,
          traceId: base.traceId,
          spanId
        })
      } else if (operationId === 'flowStateMachine.get') {
        result = readStateMachineOp(id!, input)
      } else if (operationId === 'humanTask.submit') {
        result = await executeHumanTaskSubmitOp(this.options, id!, active, input, {
          requestId: request.requestId,
          traceId: base.traceId,
          spanId
        })
      } else if (operationId === 'humanTask.get') {
        result = readHumanTaskOp(id!, input)
      } else if (FLOW_AGENT_BUILD_OPERATION_IDS.has(operationId)) {
        // F8（收官）：建图预览/提交与模型审核同样只经 flow-bridge 发布的同一 builder/review
        // 宿主；propose/review 先走与 IPC 相同的模型能力预检，commit 走渲染器权威动作
        // commitFlowBuild（authorize/confirm + 单撤销步 + 保存屏障）并由 main 核对落盘事实。
        result = await runFlowAgentBuildOperation(operationId, input, {
          activeProjectId: this.options.activeProjectId,
          desktop: this.options.desktop,
          diagnostics: { requestId: request.requestId, traceId: base.traceId, spanId }
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
    assertProjectHasNoActiveTasks(id)
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
    return isProjectTaskOccupied(id)
  }

  private deletePrecheck(id: string): unknown {
    return runProjectDeletePrecheck(id, {
      dataStoreId: this.dataStoreId,
      hmacKey: this.hmacKey,
      activeProjectId: this.options.activeProjectId
    })
  }

  private executeDelete(id: string, token: string | undefined): unknown {
    return runProjectDelete(id, token, {
      dataStoreId: this.dataStoreId,
      hmacKey: this.hmacKey,
      activeProjectId: this.options.activeProjectId
    })
  }

  private async applyCompositeUpgrade(
    input: Record<string, unknown>,
    markCommitted: () => void
  ): Promise<unknown> {
    return applyCompositeUpgradeOp(this.options, input, markCommitted)
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
        // F4：外部 Agent 只能从受控暂存/导出目录导入；GUI 文件选择器仍走 IPC 的可信路径。
        // 文本/文档正文永不进入外部响应或幂等账本。
        if (!projects.getProject(id)) throw new AccessFailure('NOT_FOUND', 'read')
        const outcome = await importMedia(id, input.filePath as string, {
          allowedRoots: [this.exportRoot],
          allowAnyPath: false,
          includeTextContent: false
        })
        if (!outcome.ok) {
          if (outcome.code === 'PATH_NOT_ALLOWED')
            throw new AccessFailure(
              'PATH_NOT_ALLOWED',
              'media-import',
              'filePath must reside inside the controlled agent-exports directory under dataDirectory'
            )
          if (outcome.code === 'INPUT_NOT_FOUND')
            throw new AccessFailure('INPUT_NOT_FOUND', 'media-import')
          throw new AccessFailure('MEDIA_IMPORT_FAILED', 'media-import', outcome.reason.slice(0, 120))
        }
        const asset = outcome.asset
        return {
          projectId: id,
          mediaId: asset.id,
          kind: asset.kind,
          mime: asset.mime,
          path: asset.path,
          sizeBytes: asset.sizeBytes,
          name: (input.name as string | undefined) ?? asset.name ?? ''
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
      case 'node.library.replace':
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
          (file) => {
            const sourceGraphVersion = file.meta.graphVersion
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
                sourceGraphVersion,
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
      case 'graph.patch.propose':
      case 'graph.patch.confirm':
      case 'graph.patch.discard':
        // graph.patch 族在 dispatch 中经权威宿主握手执行，不落在这里。
        throw new AccessFailure('UNSUPPORTED_OPERATION', 'dispatch')
      case 'flowAgent.inspect':
      case 'flowStage.context.preview':
      case 'flowStage.rework':
      case 'flowStage.reworkPreview':
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
