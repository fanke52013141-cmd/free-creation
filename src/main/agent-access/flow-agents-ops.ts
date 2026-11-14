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
import { FlowAgentCollaborationSchema } from '../../shared/agent-flow/desktop-tasks'
import { flowAgentAccessPort } from './flow-bridge'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { supportsSampledVideoReview } from '../../shared/agent-flow/video-review'
import { supportsReviewAudioInput } from '../../shared/agent-flow/media-review'
import { FlowAgentDesktopHost } from '../agent-flow/desktop-host'
import { FlowCommandLedger } from '../agent-flow/command-ledger'
import { CoordinationStore } from '../agent-flow/coordination-store'
import { FlowAssetStore } from '../agent-flow/asset-store'
import { FlowTaskStore, agentThread } from '../agent-flow/task-store'
import { FlowDefinitionStore } from '../agent-flow/definition-store'
import {
  buildContextManifest,
  contextManifestBlocking
} from '../../shared/agent-flow/context-manifest'
import type { StageDeliveryFact } from '../../shared/agent-flow/stage-contracts'
import { getDb } from '../store/db'
import { openProject } from '../store/projects.repo'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { DesktopAccessError } from './desktop'

/** 本族已开放的操作；service.ts 只按这个集合做一次分组委托。 */
export const FLOW_AGENT_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'flowAgent.inspect',
  'flowAgent.catalog',
  'flowAgent.collaboration',
  'flowAgent.cooperate',
  'flowStage.context.preview',
  'flowStage.rework',
  'flowDefinition.publish',
  'flowDefinition.list',
  'flowDefinition.get',
  'flowDefinition.diff',
  'flowRun.overview'
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
  if (error instanceof AgentRuntimeError)
    throw new DesktopAccessError(error.code, false, error.phase)
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
/** C4：协调运行只读投影——与桌面 coordinator.view 同字段口径，但零写副作用。 */
function inspectCoordinationReadOnly(projectId: string, nodeId: string): FlowAgentView | null {
  const db = getDb()
  const run = new CoordinationStore(db).latest(projectId, nodeId)
  if (!run) return null
  return {
    taskId: run.taskId,
    state: run.state,
    waitKind: run.state === 'waiting' ? 'human' : null,
    waitRevision: run.waitRevision,
    decisions: run.decisions,
    tools: run.children.length,
    code: run.code,
    recovery: run.recovery,
    phase: run.phase,
    children: run.children.map((child) => {
      const live = db
        .prepare(
          'SELECT task_id, state FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? ORDER BY rowid DESC LIMIT 1'
        )
        .get(projectId, child.nodeId) as { task_id: string; state: string } | undefined
      return {
        nodeId: child.nodeId,
        taskId: child.taskId,
        state: live?.task_id === child.taskId ? live.state : child.state
      }
    })
  }
}

function inspectFlowAgent(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const file = projectFile(projectId)
  if (context.activeProjectId() !== projectId)
    refuse(
      'FLOW_PROJECT_INACTIVE',
      'inspect: project.open the target canvas first (GUI admission requires the saved desktop canvas)'
    )
  // C4：主控/状态机节点的协调运行只读投影。桌面宿主的 coordinator.inspect 带
  // AGENT_SESSION_LOST 写副作用（running→blocked 落盘），那是桌面本地运行上下文的事实；
  // 外部读路径复用会把应用内正在运行的主控误判为会话丢失。这里直读协调台账，绝不改写。
  const node = file.nodes.find((item) => item.id === nodeId)
  let role: unknown
  try {
    role = (JSON.parse(String(node?.params.config || '{}')) as { role?: unknown }).role
  } catch {
    role = undefined
  }
  if (node?.type === 'state-machine' || (node?.type === 'agent' && role === 'coordinator')) {
    const view = inspectCoordinationReadOnly(projectId, nodeId)
    return {
      projectId,
      nodeId,
      graphVersion: file.meta.graphVersion,
      ownership: 'ledger-only',
      task: view ? taskDto(view) : null
    }
  }
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
function catalogFlowAgent(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
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
    candidates: view.candidates,
    ...(view.workingDraft !== undefined ? { workingDraft: view.workingDraft } : {})
  }
}

/**
 * 写入一次协作事件（F8 收官）。与 GUI 面板同一宿主实例、同一任务表：
 * - 事件显式标记 `actor: 'external'`，落在协作消息上，可与人工输入区分；
 * - discuss/revise 会真实调用模型，先走与 IPC 入口同一的工具调用预检（付费路径第一道闸门）；
 * - revision/waitRevision 由宿主核对，外部不能自造。
 */
async function cooperateFlowAgent(
  input: Record<string, unknown>,
  _context: FlowAgentOperationContext
): Promise<unknown> {
  void _context
  const port = flowAgentAccessPort()
  if (!port) refuse('FLOW_AGENTS_UNAVAILABLE', 'flow agent host is not running in this instance')
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const file = projectFile(projectId)
  // 用与 IPC 完全相同的 Schema 校验（含 refs 去重 superRefine）——外部不能绕过。
  const parsed = FlowAgentCollaborationSchema.safeParse({
    projectId,
    nodeId,
    taskId: input.taskId,
    waitRevision: input.waitRevision,
    revision: input.revision,
    eventId: input.eventId,
    action: input.action,
    text: input.text,
    ...(input.accepted !== undefined ? { accepted: input.accepted } : {}),
    ...(input.selectedOutputs !== undefined ? { selectedOutputs: input.selectedOutputs } : {}),
    ...(input.selectedInputs !== undefined ? { selectedInputs: input.selectedInputs } : {})
  })
  if (!parsed.success)
    refuse('AGENT_INPUT_INVALID', parsed.error.issues[0]?.path.join('.') ?? 'collaboration')
  const collaboration = parsed.data
  // 先确认该节点确实有持久化任务：否则宿主会抛非分类错误，最终被账本记成 unknown，
  // 调用方无法区分"没发生"和"不确定"。这里提前给稳定码 AGENT_TASK_MISSING。
  const existing = port.collaboration({ projectId, nodeId })
  if (!existing) refuse('AGENT_TASK_MISSING', 'cooperate: the node has no persisted Agent task yet')
  if (collaboration.action === 'discuss' || collaboration.action === 'revise')
    await port.assertAgentScopeToolCalling(collaboration.projectId, collaboration.nodeId)
  const view = (await port.cooperate({ ...collaboration, actor: 'external' })) as {
    task: Parameters<typeof taskDto>[0]
    goal: string
    revision: number
    messages: Array<{ eventId: string; kind: string; text: string; reply?: string }>
    inputs: unknown[]
    candidates: unknown[]
    workingDraft?: string
  }
  if (!view || !view.task) refuse('FLOW_AGENT_REPLY_INVALID', 'host reply missing task view')
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
    candidates: view.candidates,
    ...(view.workingDraft !== undefined ? { workingDraft: view.workingDraft } : {})
  }
}

/** AF-02：阶段输入编制预览（只读账本投影，零写副作用；与宿主 previewStageContext 同口径）。 */
function previewStageContext(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const stageKey = input.stageKey as string
  const includeBody = input.includeBody === true
  projectFile(projectId)
  if (context.activeProjectId() !== projectId)
    refuse('FLOW_PROJECT_INACTIVE', 'preview: project.open the target canvas first')
  const db = getDb()
  const run = new CoordinationStore(db).latest(projectId, nodeId)
  const empty = { projectId, nodeId, preview: null }
  if (!run || !run.config.stages) return empty
  const stage = run.config.stages.find((item) => item.stageKey === stageKey)
  if (!stage || !stage.inputs) return empty
  const assets = new FlowAssetStore(db, openProject)
  const tasks = new FlowTaskStore(db)
  const stageByNode = new Map(run.config.stages.map((item) => [item.nodeId, item]))
  const deliveries: StageDeliveryFact[] = []
  for (const child of run.children) {
    const childStage = stageByNode.get(child.nodeId)
    if (!childStage || child.state !== 'completed') continue
    const versions = assets.resolveInputs(projectId, child.outputs)
    deliveries.push({
      stageKey: childStage.stageKey,
      nodeId: child.nodeId,
      outputs: versions.map((version) => version.value),
      humanDecided: tasks.humanAccepted(
        agentThread({ projectId, agentNodeId: child.nodeId, taskId: child.taskId })
      )
    })
  }
  const manifest = buildContextManifest(stageKey, stage.inputs, deliveries)
  return {
    projectId,
    nodeId,
    preview: {
      stageKey,
      manifestHash: manifest.manifestHash,
      entries: manifest.entries.map((entry) => ({
        sourceStageKey: entry.sourceStageKey,
        path: entry.path,
        kind: entry.kind,
        bytes: entry.bytes,
        required: entry.required,
        ...(entry.purpose ? { purpose: entry.purpose } : {}),
        ...(includeBody ? { value: entry.value } : {})
      })),
      missing: manifest.missing,
      dropped: manifest.dropped,
      budget: manifest.budget,
      blocking: contextManifestBlocking(manifest)
    }
  }
}

/** AF-05：局部返工（写）——经由共享宿主端口调用同一 coordinator.reworkStage，不另建权威。 */
function reworkStage(input: Record<string, unknown>, context: FlowAgentOperationContext): unknown {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const stageKey = input.stageKey as string
  projectFile(projectId)
  if (context.activeProjectId() !== projectId)
    refuse('FLOW_PROJECT_INACTIVE', 'rework: project.open the target canvas first')
  const port = flowAgentAccessPort()
  if (!port) refuse('FLOW_AGENTS_UNAVAILABLE', 'flow agent host is not running in this instance')
  const task = port.reworkStage({ projectId, nodeId, stageKey }) as
    Parameters<typeof taskDto>[0] | null
  return { projectId, nodeId, task: task ? taskDto(task) : null }
}

/** AF-06：流程定义版本（与运行分离；只读定义快照，publish 读已保存配置）。 */
function definitionStore(): FlowDefinitionStore {
  return new FlowDefinitionStore(getDb(), openProject)
}
function assertActive(projectId: string, context: FlowAgentOperationContext, action: string): void {
  projectFile(projectId)
  if (context.activeProjectId() !== projectId)
    refuse('FLOW_PROJECT_INACTIVE', `${action}: project.open the target canvas first`)
}
function publishDefinition(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
  const projectId = input.projectId as string
  assertActive(projectId, context, 'definition.publish')
  const definition = definitionStore().publish({
    projectId,
    definitionId: input.definitionId as string,
    name: input.name as string,
    coordinatorNodeId: input.coordinatorNodeId as string
  })
  return { projectId, definition }
}
function listDefinitions(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
  const projectId = input.projectId as string
  assertActive(projectId, context, 'definition.list')
  return { projectId, definitions: definitionStore().list(projectId) }
}
function getDefinition(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
  const projectId = input.projectId as string
  assertActive(projectId, context, 'definition.get')
  const definition = definitionStore().get(
    projectId,
    input.definitionId as string,
    input.version as number | undefined
  )
  return { projectId, definition }
}
function diffDefinitions(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
  const projectId = input.projectId as string
  assertActive(projectId, context, 'definition.diff')
  const diff = definitionStore().diff(
    projectId,
    input.definitionId as string,
    input.versionA as number,
    input.versionB as number
  )
  return { projectId, definitionId: input.definitionId, diff }
}
function overviewFlowRun(
  input: Record<string, unknown>,
  context: FlowAgentOperationContext
): unknown {
  const projectId = input.projectId as string
  assertActive(projectId, context, 'flowRun.overview')
  const overview = new CoordinationStore(getDb()).overview(projectId, input.nodeId as string)
  return { projectId, overview }
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
      case 'flowAgent.cooperate':
        return cooperateFlowAgent(input, context)
      case 'flowStage.context.preview':
        return previewStageContext(input, context)
      case 'flowStage.rework':
        return reworkStage(input, context)
      case 'flowDefinition.publish':
        return publishDefinition(input, context)
      case 'flowDefinition.list':
        return listDefinitions(input, context)
      case 'flowDefinition.get':
        return getDefinition(input, context)
      case 'flowDefinition.diff':
        return diffDefinitions(input, context)
      case 'flowRun.overview':
        return overviewFlowRun(input, context)
      default:
        refuse('UNSUPPORTED_OPERATION', 'flow-agents-dispatch')
    }
  } catch (error) {
    fail(error)
  }
}
