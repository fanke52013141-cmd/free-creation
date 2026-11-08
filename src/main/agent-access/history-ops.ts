// F7 历史与恢复：外部操作复用 GUI 历史坞/恢复副本的同一服务与存储规则。
//
// 关键口径（见 docs/local-agent-access/25-node-library-history-delivery.md）：
// - 快照仍存 `history_snapshots`（workspace-state.repo）；本包新增的 `graph_json`
//   列保存"该快照对应的已持久化图数据"，外部恢复只读这一列，不往 tldraw 快照里
//   塞业务键。
// - 恢复走三段协议（precheck → 短期 HMAC 令牌 → 执行），与 project.delete 同构；
//   令牌绑定实例、项目、当前 graphVersion、快照/副本身份与影响摘要。
// - 恢复只在项目"未在桌面画布打开"时执行：打开时权威内容属于桌面宿主，main 直接
//   改文件会被下一次画布保存覆盖。打开中的项目返回 RESOURCE_BUSY/desktop-ownership。
// - 恢复前先落"恢复前检查点"快照（与 GUI 历史坞的检查点同一保存服务）；落盘走
//   projects.saveProject（写锁 + tmp/fsync/.bak 轮转 + DB 版本推进），失败不留半恢复状态。
import { timingSafeEqual } from 'node:crypto'
import { DesktopAccessError } from './desktop'
import { listMedia } from '../store/media.repo'
import * as projects from '../store/projects.repo'
import {
  deleteHistorySnapshot,
  listHistorySnapshotSummaries,
  readHistorySnapshot,
  saveHistorySnapshot,
  type HistorySnapshotGraph
} from '../store/workspace-state.repo'
import { syncGraphSnapshot } from '../../shared/graph-snapshot-sync'
import { GraphVersionConflictError, GraphWriteInProgressError } from '../../shared/graph-snapshot-sync'
import { emitDomainEvent } from '../diagnostics/ipc-domain-events'

/** 单次恢复接受的最大图规模（与画布结构导入同一口径，防止任意大 JSON 直写项目文件）。 */
const MAX_RESTORE_NODES = 20_000
const MAX_RESTORE_EDGES = 100_000
const MAX_RESTORE_GROUPS = 10_000
/** 短期确认令牌有效期，与 project.delete 的影响令牌一致。 */
const IMPACT_TOKEN_TTL_MS = 600_000

export interface HistoryOperationContext {
  activeProjectId: () => string | null
  /** 与 dispatch 的 assertNoActiveTasks 同一占用判定（service 私有查询经回调注入）。 */
  isTaskOccupied: (projectId: string) => boolean
  /** service 的 impactToken HMAC（实例 + 目标 + 权威修订 + 影响摘要 + 过期）；本模块不持有密钥。 */
  issueImpactToken: (
    projectId: string,
    graphVersion: number,
    facts: unknown,
    expiresAt: number
  ) => string
  /** agent.access 的 trace/span，供 project.restore.* 事件关联；不新增事件类型。 */
  diagnostics?: { traceId: string; spanId: string }
}

/** 生效前失败：明确报错，项目文件未动（service 映射为 failed + 稳定错误码）。 */
function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

/** 正式保存失败的安全映射：锁占用/版本冲突发生在写入前，其余按恢复失败如实报错。 */
function saveFailure(error: unknown, detail: string): never {
  if (error instanceof DesktopAccessError) throw error
  if (error instanceof GraphWriteInProgressError) refuse('RESOURCE_BUSY', 'storage')
  if (error instanceof GraphVersionConflictError) refuse('REVISION_CONFLICT', 'storage')
  refuse('RESTORE_FAILED', detail)
}

/** 生效后失败：可能已改过正式内容，保守按 unknown 由调用方核对。 */
function unknownFailure(code: string, detail?: string): never {
  throw new DesktopAccessError(code, true, detail)
}

function graphImpact(graph: HistorySnapshotGraph): {
  nodeCount: number
  edgeCount: number
  groupCount: number
} {
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    groupCount: graph.groups.length
  }
}

function currentGraph(file: {
  nodes: unknown[]
  edges: unknown[]
  groups: unknown[]
}): HistorySnapshotGraph {
  return { nodes: file.nodes, edges: file.edges, groups: file.groups }
}

function assertGraphShape(graph: HistorySnapshotGraph): void {
  if (
    graph.nodes.length > MAX_RESTORE_NODES ||
    graph.edges.length > MAX_RESTORE_EDGES ||
    graph.groups.length > MAX_RESTORE_GROUPS
  )
    refuse('SNAPSHOT_TOO_LARGE', 'graph-limit')
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object') refuse('SNAPSHOT_INVALID', 'node')
    const record = node as { id?: unknown; type?: unknown }
    if (typeof record.id !== 'string' || typeof record.type !== 'string')
      refuse('SNAPSHOT_INVALID', 'node')
  }
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== 'object') refuse('SNAPSHOT_INVALID', 'edge')
    const record = edge as { id?: unknown; from?: unknown; to?: unknown }
    if (typeof record.id !== 'string' || !record.from || !record.to)
      refuse('SNAPSHOT_INVALID', 'edge')
  }
}

/** 快照声明的媒体可用性：按图数据 content.mediaId 统计（配置内嵌引用不在此枚举）。 */
function mediaImpact(
  projectId: string,
  graph: HistorySnapshotGraph
): { required: number; available: number; missing: number } {
  const required = new Set<string>()
  for (const node of graph.nodes) {
    const content = (node as { content?: { kind?: unknown; mediaId?: unknown } }).content
    if (content?.kind === 'media' && typeof content.mediaId === 'string' && content.mediaId)
      required.add(content.mediaId)
  }
  const available = new Set(listMedia(projectId).map((asset) => asset.id))
  let found = 0
  for (const mediaId of required) if (available.has(mediaId)) found += 1
  return { required: required.size, available: found, missing: required.size - found }
}

interface RestoreFacts {
  snapshotId: string
  current: ReturnType<typeof graphImpact>
  target: ReturnType<typeof graphImpact>
  media: { required: number; available: number; missing: number }
}

interface RecoveryFacts {
  decision: 'use' | 'discard'
  copyGraphVersion: number
  copyNodeCount: number
  copyUpdatedAt: number
}

/** 令牌格式与 project.delete 的 impactToken 相同：`<expiresAt>.<hmac-hex>`。 */
function verifyImpactToken(
  token: string | undefined,
  expectedFor: (expiresAt: number) => string,
  admissionPhase: string
): void {
  if (!token) refuse('IMPACT_CONFIRM_REQUIRED', admissionPhase)
  const [rawExpiry, supplied] = token.split('.')
  const expiresAt = Number(rawExpiry)
  if (!rawExpiry || !supplied || !Number.isInteger(expiresAt) || Date.now() > expiresAt)
    refuse('IMPACT_TOKEN_INVALID', admissionPhase)
  const expected = expectedFor(expiresAt).split('.')[1] ?? ''
  let signature: Buffer
  try {
    signature = Buffer.from(supplied, 'hex')
  } catch {
    refuse('IMPACT_TOKEN_INVALID', admissionPhase)
  }
  const reference = Buffer.from(expected, 'hex')
  if (
    signature.length === 0 ||
    signature.length !== reference.length ||
    !timingSafeEqual(signature, reference)
  )
    refuse('IMPACT_TOKEN_INVALID', admissionPhase)
}

function restoreDiagnostics(
  context: HistoryOperationContext,
  projectId: string
): { traceId?: string; spanId?: string; projectId: string; correlationMissing?: boolean } {
  return {
    ...(context.diagnostics?.traceId ? { traceId: context.diagnostics.traceId } : {}),
    ...(context.diagnostics?.spanId ? { spanId: context.diagnostics.spanId } : {}),
    projectId,
    ...(context.diagnostics?.traceId ? {} : { correlationMissing: true })
  }
}

function restoreStage(
  context: HistoryOperationContext,
  projectId: string,
  event: 'started' | 'checkpoint_created' | 'completed' | 'failed' | 'cancelled',
  message: string,
  status?: 'success' | 'failed' | 'cancelled'
): void {
  emitDomainEvent(`project.restore.${event}`, message, {
    context: restoreDiagnostics(context, projectId),
    ...(status ? { status } : {})
  })
}

function requireOpenProject(projectId: string): NonNullable<ReturnType<typeof projects.openProject>> {
  const file = projects.openProject(projectId)
  if (!file) refuse('NOT_FOUND', 'read')
  return file
}

/** 列表：项目隔离 + 分页；不加载快照正文。 */
function listHistory(input: Record<string, unknown>): unknown {
  const projectId = input.projectId as string
  if (!projects.getProject(projectId)) refuse('NOT_FOUND', 'read')
  const all = listHistorySnapshotSummaries(projectId)
  const offset = input.offset as number
  const limit = input.limit as number
  return {
    projectId,
    total: all.length,
    items: all.slice(offset, offset + limit).map((item) => ({
      snapshotId: item.id,
      label: item.label.slice(0, 200),
      createdAt: item.timestamp,
      nodeCount: item.nodeCount,
      restorable: item.restorable
    }))
  }
}

function createSnapshot(input: Record<string, unknown>): unknown {
  const projectId = input.projectId as string
  const file = requireOpenProject(projectId)
  const expected = input.expectedGraphVersion as number
  if (file.meta.graphVersion !== expected)
    throw new GraphVersionConflictError(expected, file.meta.graphVersion)
  const graph = currentGraph(file)
  // 无 tldraw 快照的项目（外部建图、从未在画布打开）用共享图→快照同步生成可加载快照，
  // 保证 GUI 也能恢复这一版；图数据本身仍按持久化事实保存。
  const snapshot =
    file.tldrawSnapshot !== undefined
      ? file.tldrawSnapshot
      : syncGraphSnapshot(undefined, {
          nodes: graph.nodes as never,
          edges: graph.edges as never,
          groups: graph.groups as never
        }).snapshot
  const entry = saveHistorySnapshot(
    {
      projectId,
      label: typeof input.label === 'string' ? input.label : '',
      nodeCount: file.nodes.length,
      snapshot
    },
    { graph }
  )
  return {
    projectId,
    snapshotId: entry.id,
    label: entry.label,
    createdAt: entry.timestamp,
    nodeCount: entry.nodeCount,
    graphVersion: file.meta.graphVersion,
    restorable: true as const
  }
}

function deleteSnapshot(input: Record<string, unknown>): unknown {
  const projectId = input.projectId as string
  const snapshotId = input.snapshotId as string
  if (!projects.getProject(projectId)) refuse('NOT_FOUND', 'read')
  if (!deleteHistorySnapshot(projectId, snapshotId)) refuse('NOT_FOUND', 'snapshot-read')
  return { projectId, snapshotId, deleted: true as const }
}

function restorePrecheck(
  input: Record<string, unknown>,
  context: HistoryOperationContext
): unknown {
  const projectId = input.projectId as string
  const snapshotId = input.snapshotId as string
  const file = requireOpenProject(projectId)
  const detail = readHistorySnapshot(projectId, snapshotId)
  if (!detail) refuse('NOT_FOUND', 'snapshot-read')
  const graph = detail.graph
  const target = graph
    ? graphImpact(graph)
    : { nodeCount: detail.nodeCount, edgeCount: 0, groupCount: 0 }
  const media = graph
    ? mediaImpact(projectId, graph)
    : { required: 0, available: 0, missing: 0 }
  const blockers: Array<
    'ACTIVE_PROJECT' | 'RECOVERY_COPY' | 'TASK_OCCUPANCY' | 'SNAPSHOT_WITHOUT_GRAPH'
  > = []
  if (context.activeProjectId() === projectId) blockers.push('ACTIVE_PROJECT')
  if (projects.hasRecoveryCopy(projectId)) blockers.push('RECOVERY_COPY')
  if (context.isTaskOccupied(projectId)) blockers.push('TASK_OCCUPANCY')
  if (!graph) blockers.push('SNAPSHOT_WITHOUT_GRAPH')
  const facts: RestoreFacts = {
    snapshotId,
    current: graphImpact(currentGraph(file)),
    target,
    media
  }
  const base = {
    projectId,
    graphVersion: file.meta.graphVersion,
    snapshotId,
    current: facts.current,
    target: facts.target,
    media: facts.media,
    blockers
  }
  if (blockers.length) return base
  const expiresAt = Date.now() + IMPACT_TOKEN_TTL_MS
  return {
    ...base,
    impactToken: context.issueImpactToken(
      projectId,
      file.meta.graphVersion,
      facts,
      expiresAt
    ),
    expiresAt
  }
}

/** 恢复执行：令牌 → 占用复核 → 检查点 → 正式保存 → 重读核对（失败补偿回原图）。 */
function restoreSnapshot(input: Record<string, unknown>, context: HistoryOperationContext): unknown {
  const projectId = input.projectId as string
  const snapshotId = input.snapshotId as string
  if (context.activeProjectId() === projectId)
    refuse('RESOURCE_BUSY', 'desktop-ownership')
  const file = requireOpenProject(projectId)
  const detail = readHistorySnapshot(projectId, snapshotId)
  if (!detail) refuse('NOT_FOUND', 'snapshot-read')
  const graph = detail.graph
  if (!graph) refuse('SNAPSHOT_WITHOUT_GRAPH', 'snapshot-read')
  assertGraphShape(graph)
  if (projects.hasRecoveryCopy(projectId))
    refuse('RESOURCE_BUSY', 'recovery-ownership')
  if (context.isTaskOccupied(projectId)) refuse('RESOURCE_BUSY', 'task-occupancy')
  const before = currentGraph(file)
  const facts: RestoreFacts = {
    snapshotId,
    current: graphImpact(before),
    target: graphImpact(graph),
    media: mediaImpact(projectId, graph)
  }
  verifyImpactToken(
    input.impactToken as string | undefined,
    (expiresAt) =>
      context.issueImpactToken(projectId, file.meta.graphVersion, facts, expiresAt),
    'restore-admission'
  )
  restoreStage(context, projectId, 'started', '历史版本恢复开始')
  // 恢复前检查点：与 GUI 历史坞同一保存服务，回执里给出 ID 供用户/Agent 回退。
  let checkpoint
  try {
    checkpoint = saveHistorySnapshot(
      {
        projectId,
        label: `恢复前检查点 · ${new Date().toLocaleTimeString('zh-CN')}`,
        nodeCount: before.nodes.length,
        snapshot:
          file.tldrawSnapshot !== undefined
            ? file.tldrawSnapshot
            : syncGraphSnapshot(undefined, {
                nodes: before.nodes as never,
                edges: before.edges as never,
                groups: before.groups as never
              }).snapshot
      },
      { graph: before }
    )
  } catch {
    restoreStage(context, projectId, 'failed', '恢复前检查点保存失败', 'failed')
    refuse('RESTORE_CHECKPOINT_FAILED', 'checkpoint')
  }
  restoreStage(context, projectId, 'checkpoint_created', '恢复前检查点已保存')
  let savedVersion: number
  try {
    const saved = projects.saveProject({
      id: projectId,
      graph: {
        nodes: graph.nodes,
        edges: graph.edges,
        groups: graph.groups
      },
      tldrawSnapshot: detail.snapshot,
      expectedGraphVersion: file.meta.graphVersion
    })
    if (!saved) refuse('NOT_FOUND', 'read')
    savedVersion = saved.graphVersion
  } catch (error) {
    restoreStage(context, projectId, 'failed', '历史版本恢复落盘失败', 'failed')
    saveFailure(error, 'restore-save')
  }
  // 重读持久化数据核对：图数据与目标快照逐字段一致才算恢复完成。
  const after = projects.openProject(projectId)
  const consistent =
    after !== null &&
    after.meta.graphVersion === savedVersion &&
    JSON.stringify(currentGraph(after)) === JSON.stringify(graph)
  if (!consistent) {
    // 复核失败：立刻用检查点内容补偿回原图，不留"半恢复"项目。
    let rollback: { graphVersion: number } | null = null
    try {
      rollback = projects.saveProject({
        id: projectId,
        graph: { nodes: before.nodes, edges: before.edges, groups: before.groups },
        ...(file.tldrawSnapshot !== undefined ? { tldrawSnapshot: file.tldrawSnapshot } : {}),
        expectedGraphVersion: savedVersion
      })
    } catch {
      rollback = null
    }
    restoreStage(
      context,
      projectId,
      'failed',
      rollback ? '历史版本恢复核对失败，已回退' : '历史版本恢复核对与回退均失败',
      'failed'
    )
    // 回退成功 = 项目已回到原图，可如实报失败（未留下半恢复状态）；
    // 回退失败 = 结果不可判定，按 unknown 交回调用方核对。
    if (rollback) refuse('RESTORE_ROLLED_BACK', 'restore-verify')
    unknownFailure('RESTORE_VERIFICATION_FAILED', 'restore-verify')
  }
  restoreStage(context, projectId, 'completed', '历史版本恢复完成', 'success')
  return {
    projectId,
    snapshotId,
    restored: true as const,
    graphVersion: savedVersion,
    previousGraphVersion: file.meta.graphVersion,
    checkpointSnapshotId: checkpoint.id,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length
  }
}

function recoveryPrecheck(
  input: Record<string, unknown>,
  context: HistoryOperationContext
): unknown {
  const projectId = input.projectId as string
  const file = requireOpenProject(projectId)
  const copy = projects.readRecoveryCopy(projectId)
  const blockers: Array<'ACTIVE_PROJECT' | 'TASK_OCCUPANCY'> = []
  if (context.activeProjectId() === projectId) blockers.push('ACTIVE_PROJECT')
  if (context.isTaskOccupied(projectId)) blockers.push('TASK_OCCUPANCY')
  const base = {
    projectId,
    graphVersion: file.meta.graphVersion,
    exists: copy !== null,
    copyGraphVersion: copy?.meta.graphVersion ?? null,
    copyNodeCount: copy ? copy.nodes.length : null,
    copyUpdatedAt: copy?.meta.updatedAt ?? null,
    blockers
  }
  if (!copy || blockers.length) return base
  // 未指定裁决时只返回事实：预检不该强迫调用方先做决定。
  if (input.decision !== 'use' && input.decision !== 'discard')
    return { ...base, requiresDecision: true }
  const facts: RecoveryFacts = {
    decision: input.decision as 'use' | 'discard',
    copyGraphVersion: copy.meta.graphVersion,
    copyNodeCount: copy.nodes.length,
    copyUpdatedAt: copy.meta.updatedAt
  }
  const expiresAt = Date.now() + IMPACT_TOKEN_TTL_MS
  return {
    ...base,
    impactToken: context.issueImpactToken(projectId, file.meta.graphVersion, facts, expiresAt),
    expiresAt
  }
}

/** 恢复副本裁决：use=正式落盘（恢复副本语义，版本推进、旧版进 .bak）；discard=丢弃副本。 */
function resolveRecovery(
  input: Record<string, unknown>,
  context: HistoryOperationContext
): unknown {
  const projectId = input.projectId as string
  const decision = input.decision as 'use' | 'discard'
  if (context.activeProjectId() === projectId)
    refuse('RESOURCE_BUSY', 'desktop-ownership')
  const file = requireOpenProject(projectId)
  const copy = projects.readRecoveryCopy(projectId)
  if (!copy) refuse('NOT_FOUND', 'recovery-copy')
  if (context.isTaskOccupied(projectId)) refuse('RESOURCE_BUSY', 'task-occupancy')
  const facts: RecoveryFacts = {
    decision,
    copyGraphVersion: copy.meta.graphVersion,
    copyNodeCount: copy.nodes.length,
    copyUpdatedAt: copy.meta.updatedAt
  }
  verifyImpactToken(
    input.impactToken as string | undefined,
    (expiresAt) => context.issueImpactToken(projectId, file.meta.graphVersion, facts, expiresAt),
    'recovery-admission'
  )
  if (decision === 'use') {
    restoreStage(context, projectId, 'started', '恢复副本落盘开始')
    let restored: ReturnType<typeof projects.restoreRecoveryCopy>
    try {
      restored = projects.restoreRecoveryCopy(projectId)
    } catch (error) {
      restoreStage(context, projectId, 'failed', '恢复副本落盘失败', 'failed')
      saveFailure(error, 'recovery-apply')
    }
    if (!restored) {
      restoreStage(context, projectId, 'failed', '恢复副本内容不可用', 'failed')
      refuse('RESTORE_FAILED', 'recovery-apply')
    }
    restoreStage(context, projectId, 'completed', '恢复副本已落盘', 'success')
    return {
      projectId,
      decision,
      resolved: true as const,
      graphVersion: restored.meta.graphVersion,
      recoveryCopyRemoved: !projects.hasRecoveryCopy(projectId)
    }
  }
  const removed = projects.discardRecoveryCopy(projectId)
  if (!removed) refuse('RESTORE_FAILED', 'recovery-discard')
  // 丢弃副本 = 用户选择保留磁盘版本，等同取消这次恢复（复用已登记事件）。
  restoreStage(context, projectId, 'cancelled', '恢复副本已丢弃，保留磁盘版本', 'cancelled')
  return {
    projectId,
    decision,
    resolved: true as const,
    graphVersion: projects.getProject(projectId)?.graphVersion ?? file.meta.graphVersion,
    recoveryCopyRemoved: true as const
  }
}

/** history.* 的统一入口；operation 由 dispatch 传入，未知分支由类型系统兜底。 */
export function runHistoryOperation(
  operation: string,
  input: Record<string, unknown>,
  context: HistoryOperationContext
): unknown {
  switch (operation) {
    case 'history.list':
      return listHistory(input)
    case 'history.snapshot.create':
      return createSnapshot(input)
    case 'history.snapshot.delete':
      return deleteSnapshot(input)
    case 'history.restore.precheck':
      return restorePrecheck(input, context)
    case 'history.restore':
      return restoreSnapshot(input, context)
    case 'history.recovery.precheck':
      return recoveryPrecheck(input, context)
    case 'history.recovery.resolve':
      return resolveRecovery(input, context)
    default:
      throw new DesktopAccessError('UNSUPPORTED_OPERATION', false, 'history-dispatch')
  }
}
