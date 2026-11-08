// F8（一）flowAgents 族：把 GUI「Agent Flow 面板」的**观察**动作开放给外部 CLI/MCP。
//
// 设计口径（详见 docs/local-agent-access/28-flow-agents-delivery.md）：
// - 业务实现只有一份：复用 `FlowAgentDesktopHost`（GUI 面板调用的同一类）与
//   `FlowTaskStore` / `FlowCommandLedger` / 技能库；本模块不新增执行器，也不直写图或账本。
// - 外部主体必须可区分：本族只读。`inspect` 在"任务正在运行/待启动"这一状态下**不会**
//   调用会写账本的宿主方法——GUI 宿主在那里把任务判为 `AGENT_SESSION_LOST`，那是桌面
//   宿主本地运行上下文的事实；外部进程内的第二个宿主没有该上下文，判定必然是错的。
//   因此该状态只返回账本事实并标记 `ownership: 'ledger-only'`，绝不改写任务状态。
// - 依赖边界：本族需要"项目已在桌面画布打开"（与 GUI 同一前置条件）。模型端口与命令
//   交付通道属于桌面执行宿主，本模块不伪造：未登记的操作在需要它们时就不会走到这里。
import type Database from 'better-sqlite3'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import type { FlowAgentView } from '../../shared/agent-flow/desktop-tasks'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { supportsSampledVideoReview } from '../../shared/agent-flow/video-review'
import { supportsReviewAudioInput } from '../../shared/agent-flow/media-review'
import { FlowAgentDesktopHost } from '../agent-flow/desktop-host'
import { FlowCommandLedger } from '../agent-flow/command-ledger'
import { getDb } from '../store/db'
import { openProject } from '../store/projects.repo'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { DesktopAccessError } from './desktop'

/** 本族已开放的操作；service.ts 只按这个集合做一次分组委托。 */
export const FLOW_AGENT_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'flowAgent.inspect',
  'flowAgent.catalog',
  'flowAgent.collaboration'
] as AccessOperationId[])

export interface FlowAgentOperationContext {
  activeProjectId: () => string | null
  /** agent.access 的 trace/span，供 dispatch 生命周期事件与后续核对关联。 */
  diagnostics: { traceId: string; spanId: string }
}

type HostDesktop = ConstructorParameters<typeof FlowAgentDesktopHost>[2]
type HostModel = ConstructorParameters<typeof FlowAgentDesktopHost>[3]

/** 生效前失败：明确报错、无副作用（service 映射为 failed + 稳定错误码）。 */
function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

function fail(error: unknown): never {
  if (error instanceof DesktopAccessError) throw error
  if (error instanceof AgentRuntimeError) throw new DesktopAccessError(error.code, false, error.phase)
  throw error
}

interface TaskRow {
  task_id: string
  state: FlowAgentView['state']
  wait_kind: 'human' | 'reconcile' | null
  wait_revision: number
  decisions: number
  tools: number
  code: string | null
  parent: string | null
  coordinator: string | null
}

/** 与 `FlowAgentDesktopHost.latest()` 同一查询，另取两个决定"会话存活判定"的字段。 */
function latestTask(projectId: string, nodeId: string): TaskRow | undefined {
  return getDb()
    .prepare(
      `SELECT task_id, state, wait_kind, wait_revision, decisions, tools, code,
              json_extract(snapshot_json,'$.parentTaskId') AS parent,
              json_extract(snapshot_json,'$.coordinatorTaskId') AS coordinator
         FROM flow_agent_tasks
        WHERE project_id=? AND agent_node_id=?
        ORDER BY rowid DESC LIMIT 1`
    )
    .get(projectId, nodeId) as TaskRow | undefined
}

/**
 * 只读观察宿主。它是 GUI 面板同一个类，但只用于读取路径：
 * - `ledger` 是真实命令账本（读取路径不会调用；构造它不需要桌面通道）；
 * - `deliver` 明确不可用——本族没有任何派发命令的操作，绝不模拟桌面交付；
 * - 模型端口同样明确不可用——运行/审核属于桌面执行宿主，本族不登记。
 */
let cached: { db: Database.Database; host: FlowAgentDesktopHost } | undefined
let activeResolver: (projectId: string) => boolean = () => false
function flowHost(activeProjectId: () => string | null): FlowAgentDesktopHost {
  activeResolver = (projectId) => activeProjectId() === projectId
  const db = getDb()
  if (cached?.db === db) return cached.host
  const bridge: HostDesktop = {
    ledger: new FlowCommandLedger(db, openProject),
    isActive: (projectId) => activeResolver(projectId),
    deliver: async () => {
      throw new AgentRuntimeError('FLOW_DESKTOP_UNAVAILABLE', 'dispatch')
    }
  }
  const model: HostModel = async () => {
    throw new AgentRuntimeError('FLOW_MODEL_PORT_UNAVAILABLE', 'model-capability')
  }
  const host = new FlowAgentDesktopHost(db, openProject, bridge, model)
  cached = { db, host }
  return host
}

/** `FlowAgentView` → 严格输出 DTO（字段白名单，避免把内部对象直接外泄）。 */
function taskDto(view: FlowAgentView): Record<string, unknown> {
  return {
    taskId: view.taskId,
    state: view.state,
    waitKind: view.waitKind,
    waitRevision: view.waitRevision,
    decisions: view.decisions,
    tools: view.tools,
    ...(view.code ? { code: view.code } : {}),
    ...(view.prepared !== undefined ? { prepared: view.prepared } : {}),
    ...(view.phase ? { phase: view.phase } : {}),
    ...(view.recovery
      ? { recovery: { reasons: view.recovery.reasons, canRestore: view.recovery.canRestore } }
      : {}),
    ...(view.reviewFeedback
      ? {
          reviewFeedback: {
            reviewNodeId: view.reviewFeedback.reviewNodeId,
            reviewId: view.reviewFeedback.reviewId,
            feedback: view.reviewFeedback.feedback,
            round: view.reviewFeedback.round,
            state: view.reviewFeedback.state,
            subjects: view.reviewFeedback.subjects
          }
        }
      : {})
  }
}

function projectFile(projectId: string): NonNullable<ReturnType<typeof openProject>> {
  const file = openProject(projectId)
  if (!file) refuse('NOT_FOUND', 'read')
  return file
}

/**
 * 观察 Flow 任务。
 *
 * 关键：预检与宿主调用在**同一个同步块**内完成，中间没有 await——
 * 因此"预检看到的状态"与"宿主读取的状态"不会漂移，不会出现外部把运行中任务
 * 误判为丢失的竞态。预检命中宿主会写账本的分支时直接返回账本事实。
 */
function inspectFlowAgent(input: Record<string, unknown>, context: FlowAgentOperationContext): unknown {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const file = projectFile(projectId)
  if (context.activeProjectId() !== projectId)
    refuse(
      'FLOW_PROJECT_INACTIVE',
      'inspect: project.open the target canvas first (GUI admission requires the saved desktop canvas)'
    )
  const latest = latestTask(projectId, nodeId)
  const liveOwned =
    !!latest &&
    (latest.state === 'running' ||
      (latest.state === 'ready' && !latest.parent && !latest.coordinator))
  if (liveOwned && latest) {
    // 不调用 host.inspect：见文件头的会话存活判定说明。
    return {
      projectId,
      nodeId,
      graphVersion: file.meta.graphVersion,
      ownership: 'ledger-only',
      task: {
        taskId: latest.task_id,
        state: latest.state,
        waitKind: latest.wait_kind,
        waitRevision: latest.wait_revision,
        decisions: latest.decisions,
        tools: latest.tools,
        ...(latest.code ? { code: latest.code } : {}),
        prepared: latest.state === 'ready' && !!(latest.parent || latest.coordinator)
      }
    }
  }
  const view = flowHost(context.activeProjectId).inspect({ projectId, nodeId })
  return {
    projectId,
    nodeId,
    graphVersion: file.meta.graphVersion,
    ownership: 'desktop-host',
    task: view ? taskDto(view) : null
  }
}

/** 读取能力目录（模型/工具/技能摘要），与 GUI 目录同一投影、同一前置条件。 */
function catalogFlowAgent(input: Record<string, unknown>, context: FlowAgentOperationContext): unknown {
  const projectId = input.projectId as string
  const file = projectFile(projectId)
  const models = new SqliteModelHost(getDb())
    .listModels()
    .filter(
      (model) =>
        model.enabled &&
        model.capabilities.some((capability) => capability.operation === 'text.generate')
    )
    .map((model) => ({
      id: model.id,
      name: model.name,
      imageInput: supportsSampledVideoReview(model),
      audioInput: supportsReviewAudioInput(model)
    }))
  // nodeId 对目录投影无意义（宿主只按项目判定打开状态）；传空串保持与 GUI 同一调用形态。
  const catalog = flowHost(context.activeProjectId).catalog({ projectId, nodeId: '' }, models)
  return {
    projectId,
    graphVersion: file.meta.graphVersion,
    models: catalog.models,
    tools: catalog.tools,
    skills: catalog.skills
  }
}

/** 读取协作记录：只读，不写人工意见/选择，不继续任务。 */
function collaborationFlowAgent(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const file = projectFile(projectId)
  const view = flowHost(context.activeProjectId).collaboration({ projectId, nodeId })
  if (!view) refuse('AGENT_TASK_MISSING', 'collaboration: the node has no persisted Agent task yet')
  return {
    projectId,
    nodeId,
    graphVersion: file.meta.graphVersion,
    task: taskDto(view.task),
    goal: view.goal,
    revision: view.revision,
    messages: view.messages.map((message) => ({
      eventId: message.eventId,
      kind: message.kind,
      text: message.text,
      ...(message.reply !== undefined ? { reply: message.reply } : {})
    })),
    inputs: view.inputs,
    candidates: view.candidates
  }
}

/** dispatch 的分组委托入口：只分发本族操作，其余明确拒绝（防误接）。 */
export async function runFlowAgentOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): Promise<unknown> {
  try {
    switch (operationId) {
      case 'flowAgent.inspect':
        return inspectFlowAgent(input, context)
      case 'flowAgent.catalog':
        return catalogFlowAgent(input, context)
      case 'flowAgent.collaboration':
        return collaborationFlowAgent(input, context)
      default:
        refuse('UNSUPPORTED_OPERATION', 'flow-agents-dispatch')
    }
  } catch (error) {
    fail(error)
  }
}
