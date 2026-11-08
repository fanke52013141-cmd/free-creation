// F8（收官）：Flow 建图预览/提交与模型审核的外部接入。
//
// 与 F8 第二批运行控制同一原则：**不另建宿主**。builder/review 宿主由
// `registerFlowAgentsIpc` 在应用启动时创建，持有模型端口、审核证据与 flow_builds /
// flow_review 账本；本模块只经由 `flow-bridge.ts` 发布的窄接口调用同一个实例。
//
// 安全与准入：
// - inspect 只读已持久化预览，不调模型、不改画布；
// - propose 先走与 IPC `flowAgents:build` 相同的模型工具调用预检；预检失败时
//   宿主一次都不会被调用（付费路径不会被偷偷触发），requestId/trace/span 由 main 生成；
// - commit 只按 buildId 提交，预览内容由 main 侧宿主提供；真正落画布是渲染器的权威动作
//   `commitFlowBuild`（authorize/confirm + 单撤销步 + 保存屏障），外部不能自带图内容；
//   提交后 main 再从持久化数据核对 committed 状态与节点真实存在，不把渲染器回执当成功；
// - review 的结论由模型产生（FlowReviewHost），外部只能提交与读取，不能改写通过/不通过；
// - 未发布端口时如实 FLOW_AGENTS_UNAVAILABLE，不降级成本地替身。
import { randomUUID } from 'node:crypto'
import { BuildRequestSchema, type BuildPreview } from '../../shared/agent-flow/builder'
import { ReviewRequestSchema } from '../../shared/agent-flow/review'
import type { ReviewDecision } from '../../shared/agent-flow/node-contracts'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { openProject } from '../store/projects.repo'
import { DesktopAccessError, type AccessDesktop } from './desktop'
import { flowAgentAccessPort, type FlowAgentAccessPort } from './flow-bridge'

/** 本模块负责的操作；service.ts 只做一次分组委托。 */
export const FLOW_AGENT_BUILD_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'flowAgent.build.inspect',
  'flowAgent.build.propose',
  'flowAgent.build.commit',
  'flowAgent.review'
] as AccessOperationId[])

export interface FlowAgentBuildContext {
  activeProjectId: () => string | null
  desktop: AccessDesktop | null | undefined
  /** agent.access 的 trace/span，用于模型请求与诊断关联。 */
  diagnostics: { traceId: string; spanId: string }
}

/** 准入前失败：明确错误码、无副作用（service 映射为 failed）。 */
function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

function fail(error: unknown): never {
  if (error instanceof DesktopAccessError) throw error
  if (error instanceof AgentRuntimeError) throw new DesktopAccessError(error.code, false, error.phase)
  throw error
}

function port(): FlowAgentAccessPort {
  const published = flowAgentAccessPort()
  // 未发布（非桌面启动阶段）如实拒绝：不 new 第二个 builder/review 宿主。
  if (!published) refuse('FLOW_AGENTS_UNAVAILABLE', 'flow agent host is not running in this instance')
  return published
}

function projectVersion(projectId: string): number {
  const file = openProject(projectId)
  if (!file) refuse('NOT_FOUND', 'read')
  return file.meta.graphVersion
}

function requireActive(context: FlowAgentBuildContext, projectId: string, operation: string): void {
  if (context.activeProjectId() !== projectId)
    refuse(
      'ACTIVE_PROJECT_REQUIRED',
      `project.open the target canvas first, then retry ${operation} (the desktop host owns the canvas)`
    )
}

/** BuildPreview → 严格输出 DTO：不返回节点正文/配置（建图内容是业务正文）。 */
function buildPreviewDto(preview: BuildPreview): Record<string, unknown> {
  return {
    buildId: preview.buildId,
    projectId: preview.projectId,
    nodeId: preview.nodeId,
    semanticRevision: preview.semanticRevision,
    state: preview.state,
    plan: {
      title: preview.plan.title,
      topology: preview.plan.topology,
      steps: preview.plan.steps.slice(0, 4).map((step) => ({
        title: step.title,
        goal: step.goal,
        mode: step.mode,
        capability: step.capability
      }))
    },
    nodes: preview.nodes.slice(0, 64).map((node) => ({
      nodeId: node.id,
      type: node.type,
      title: node.title,
      contractVersion: node.contractVersion,
      x: node.x,
      y: node.y
    })),
    edges: preview.edges.slice(0, 128).map((edge) => ({ from: edge.from, to: edge.to }))
  }
}

function reviewDecisionDto(decision: ReviewDecision): Record<string, unknown> {
  return {
    reviewId: decision.reviewId,
    cycleId: decision.cycleId,
    reviewNodeId: decision.reviewNodeId,
    reviewRevision: decision.reviewRevision,
    rulesVersion: decision.rulesVersion,
    passed: decision.passed,
    feedback: decision.feedback,
    evidenceScope: decision.evidenceScope,
    subjects: decision.subjects.slice(0, 128).map((subject) => ({
      assetId: subject.assetId,
      versionId: subject.versionId,
      sourceNodeId: subject.sourceNodeId,
      sourcePortId: subject.sourcePortId
    })),
    issues: decision.issues.slice(0, 128).map((issue) => ({
      assetId: issue.assetId,
      versionId: issue.versionId,
      feedback: issue.feedback
    }))
  }
}

/** 读取建图预览（最近一次或指定 buildId）；只读，不调模型、不改画布。 */
async function inspectBuild(
  input: Record<string, unknown>,
  context: FlowAgentBuildContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const graphVersion = projectVersion(projectId)
  requireActive(context, projectId, 'flowAgent.build.inspect')
  const host = port()
  let preview: unknown
  try {
    preview = await host.build({
      projectId,
      nodeId,
      action: 'inspect',
      ...(typeof input.buildId === 'string' ? { buildId: input.buildId } : {})
    })
  } catch (error) {
    fail(error)
  }
  return {
    projectId,
    nodeId,
    graphVersion,
    build: preview ? buildPreviewDto(preview as BuildPreview) : null
  }
}

/** 提交建图目标：与 IPC 同一模型预检 → 同一 builder 宿主生成并持久化预览。 */
async function proposeBuild(
  input: Record<string, unknown>,
  context: FlowAgentBuildContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  projectVersion(projectId)
  requireActive(context, projectId, 'flowAgent.build.propose')
  const host = port()
  // 第一道闸门与 GUI 相同：技能范围内模型必须已通过工具调用验证。
  try {
    await host.assertAgentScopeToolCalling(projectId, nodeId)
  } catch (error) {
    fail(error)
  }
  const raw = {
    projectId,
    nodeId,
    action: 'propose',
    // 运行身份由 main 生成：外部不能自造 requestId/traceId/spanId。
    requestId: randomUUID(),
    traceId: context.diagnostics.traceId,
    spanId: context.diagnostics.spanId
  }
  const parsed = BuildRequestSchema.safeParse(raw)
  if (!parsed.success) refuse('INVALID_INPUT', parsed.error.issues[0]?.path.join('.') ?? 'propose')
  let preview: unknown
  try {
    preview = await host.build(parsed.data)
  } catch (error) {
    fail(error)
  }
  if (!preview || typeof preview !== 'object')
    refuse('FLOW_AGENT_REPLY_INVALID', 'build host reply missing preview')
  const shaped = preview as BuildPreview
  // 预览必须先持久化再对外可见：读回同一条记录，而不是只信内存返回值。
  let persisted: unknown
  try {
    persisted = await host.build({
      projectId,
      nodeId,
      action: 'inspect',
      buildId: shaped.buildId
    })
  } catch (error) {
    fail(error)
  }
  if (!persisted || (persisted as BuildPreview).buildId !== shaped.buildId)
    refuse('STORAGE_INCONSISTENT', 'build preview was not persisted')
  return {
    projectId,
    nodeId,
    graphVersion: projectVersion(projectId),
    build: buildPreviewDto(persisted as BuildPreview)
  }
}

/**
 * 提交建图预览到权威画布。
 *
 * 渲染器动作 `commitFlowBuild` 与 GUI 面板完全同一份（authorize → 语义修订核对 →
 * 单撤销步应用 → 保存屏障 → confirm）。main 只按 buildId 触发，不接收外部图内容；
 * 回执丢失时按预览 committed 状态与已保存节点核对（unknown 语义由 desktop 层处理）。
 */
async function commitBuild(
  input: Record<string, unknown>,
  context: FlowAgentBuildContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const buildId = input.buildId as string
  projectVersion(projectId)
  requireActive(context, projectId, 'flowAgent.build.commit')
  // 先确认共享宿主端口已发布：未发布时与其它三个操作返回同一 FLOW_AGENTS_UNAVAILABLE。
  const host = port()
  if (!context.desktop) refuse('DESKTOP_UNAVAILABLE', 'desktop host is not available')
  let before: unknown
  try {
    before = await host.build({ projectId, nodeId, action: 'inspect', buildId })
  } catch (error) {
    fail(error)
  }
  if (!before) refuse('FLOW_BUILD_MISSING', 'no persisted build preview for this buildId')
  const preview = before as BuildPreview
  if (preview.state === 'committed') {
    // 回执丢失后的幂等核对：不重复应用画布变更，按持久化事实返回。
    const file = openProject(projectId)
    const missing = preview.nodes.filter((node) => !file?.nodes.some((item) => item.id === node.id))
    if (missing.length > 0) refuse('STORAGE_INCONSISTENT', missing[0].id)
    return {
      projectId,
      nodeId,
      graphVersion: projectVersion(projectId),
      build: buildPreviewDto(preview),
      committedNodeIds: preview.nodes.map((node) => node.id)
    }
  }
  if (preview.state !== 'preview')
    refuse('FLOW_BUILD_UNCONFIRMED', `build state is ${preview.state}`)
  let reply: { graphVersion: number; result?: unknown }
  try {
    // 30s：authorize/save/confirm 是本地动作；超时/失联按 unknown 由服务层核对，不自动重放。
    reply = await context.desktop.run(
      { action: 'flow-build', projectId, nodeId, buildId },
      undefined,
      30000
    )
  } catch (error) {
    // 预检失败（validated=true → DesktopAccessError.unknownOutcome=false）如实 failed；
    // 准入后失联 rethrow，服务层返回 unknown，不把不确定当成功。
    if (error instanceof DesktopAccessError && !error.unknownOutcome) throw error
    throw error
  }
  const payload = (reply.result ?? {}) as { buildId?: unknown }
  if (payload.buildId !== undefined && payload.buildId !== buildId)
    refuse('STORAGE_INCONSISTENT', 'desktop committed a different build')
  // 以持久化事实为准：预览已 committed，且每个建图节点真实存在。
  let after: unknown
  try {
    after = await host.build({ projectId, nodeId, action: 'inspect', buildId })
  } catch (error) {
    fail(error)
  }
  const committed = after as BuildPreview | null
  if (!committed || committed.state !== 'committed')
    refuse('STORAGE_INCONSISTENT', 'build was not marked committed in the persisted preview')
  const file = openProject(projectId)
  const missing = committed.nodes.filter((node) => !file?.nodes.some((item) => item.id === node.id))
  if (missing.length > 0) refuse('STORAGE_INCONSISTENT', missing[0].id)
  return {
    projectId,
    nodeId,
    graphVersion: projectVersion(projectId),
    build: buildPreviewDto(committed),
    committedNodeIds: committed.nodes.map((node) => node.id)
  }
}

/** 提交模型审核并读取报告：与 IPC review 同一预检 + 同一 FlowReviewHost。 */
async function reviewNode(
  input: Record<string, unknown>,
  context: FlowAgentBuildContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  projectVersion(projectId)
  requireActive(context, projectId, 'flowAgent.review')
  const host = port()
  const raw = {
    projectId,
    nodeId,
    // 审核请求身份由 main 生成：外部不能自造，也不能把模型结论改成通过。
    requestId: randomUUID(),
    traceId: context.diagnostics.traceId,
    spanId: context.diagnostics.spanId
  }
  const parsed = ReviewRequestSchema.safeParse(raw)
  if (!parsed.success) refuse('INVALID_INPUT', 'review')
  try {
    await host.assertReviewToolCalling(projectId, nodeId)
  } catch (error) {
    fail(error)
  }
  let decision: unknown
  try {
    decision = await host.review(parsed.data)
  } catch (error) {
    fail(error)
  }
  if (!decision || typeof decision !== 'object')
    refuse('FLOW_AGENT_REPLY_INVALID', 'review host reply missing decision')
  return {
    projectId,
    nodeId,
    graphVersion: projectVersion(projectId),
    decision: reviewDecisionDto(decision as ReviewDecision)
  }
}

/** dispatch 的分组委托入口：只分发本族操作，其余明确拒绝（防误接）。 */
export async function runFlowAgentBuildOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>,
  context: FlowAgentBuildContext
): Promise<unknown> {
  try {
    switch (operationId) {
      case 'flowAgent.build.inspect':
        return await inspectBuild(input, context)
      case 'flowAgent.build.propose':
        return await proposeBuild(input, context)
      case 'flowAgent.build.commit':
        return await commitBuild(input, context)
      case 'flowAgent.review':
        return await reviewNode(input, context)
      default:
        refuse('UNSUPPORTED_OPERATION', 'flow-agent-build-dispatch')
    }
  } catch (error) {
    fail(error)
  }
}
