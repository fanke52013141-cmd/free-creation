// 工作流执行编排层（契约规范 P3 / 路线图 R1 / R4）。
//
// 这里只保留运行器：拓扑排序 → 收集输入 → 契约校验 → 按节点执行器执行
// → 读取 shape 投影输出 → 输出契约校验 → 登记。节点专属执行逻辑已迁移到
// engine/executors/* 下各节点自注册的执行器；新增普通节点无需改动本文件。
//
// 运行器对每个节点注入统一的 runSubflow 钩子（循环控制节点用它驱动下游循环体
// 子流程逐项执行；非循环节点不会调用它），保持「运行器零节点特判」。
//
// 节点卡片内的手动生成与全局运行共用同一输出投影（nodes/nodeValues.ts），
// 因此执行器只需把运行结果写回 shape props / meta，投影交给运行器统一处理。
import type { Editor, TLShapeId } from 'tldraw'
import type { CanvasEdge, CanvasNode, ExecStatus, ProviderSummary } from '@shared/types'
import { deriveGraph } from '../canvas/graph'
import { markUndoPoint } from '../canvas/history'
import { materializeArtifact } from '../canvas/artifact-materializer'
import type { NodeCardShape, NodeCardProps } from '../canvas/NodeCardShape'
import {
  buildOutputPackets,
  collectContractInputs,
  type ContractInputInjection,
  type ContractOutputs
} from './contracts'
import type { NodeExecutionContext, NodeExecutionResult, SubflowRequest } from './executor-types'
import type { NodeMetaPatch } from '@shared/engine/executor-types'
import { iterationItemValue } from '@shared/engine/inputs'
import { rendererGateway } from './rendererGateway'
import { operationPatchViolation } from '@shared/engine/node-invariants'
import { fingerprintNodeInputs } from './resultFreshness'
import { recipeParams } from '@shared/artifact-recipe'
import { recipeGateway } from './recipeGateway'
import { runCodeTransform } from './codeRuntime'
import { getNodeType } from '../nodes/registry'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'
import { toast } from '../stores/toast'
import { useConfirmStore } from '../stores/confirm'
import { deriveRunPlan, formatRunPlan } from './run-plan'
import { useEngineStore } from './store'
import {
  appendNodeRunHistory,
  appendNodeRunTrace,
  inputSources,
  readNodeRunRecord,
  type NodeRunRecord,
  type NodeRunPhase,
  type NodeRunStatus
} from './runRecord'
import { redactDiagnosticText } from '@shared/diagnostics'
import {
  DiagnosticsProducer,
  newNodeExecutionId,
  newProducerId,
  newSpanId,
  newTraceId,
  type DiagnosticsStatus
} from '@shared/observability'
import { emitDiagnosticsEvent } from './diagnosticsReporter'
import { captureRunWorkload } from './run-workload'

interface RunControl {
  cancelled: boolean
  paused: boolean
  resumeWaiters: Array<() => void>
}

interface WorkflowContext {
  editor: Editor
  projectId: string
  providers: ProviderSummary[]
  token: RunControl
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }
  /** 运行期累积的输出登记：nodeId -> 端口输出数据包。 */
  outputs: Map<string, ContractOutputs>
  /**
   * 循环体首次进入时冻结的用户输入。执行器可以把解析后的值写回 props.text，
   * 但每个 item 必须从同一份正文/固定配置重新计算，不能继承上一项的替换结果。
   */
  subflowBaseInputs: Map<string, Pick<NodeCardProps, 'text' | 'config'>>
  runId: string
  /** L01 根 trace：一次用户操作/工作流的关联根（runWorkflow 等入口生成）。 */
  traceId: string
  /** 工作流级 span；节点事件的 parentSpanId 指向它。 */
  workflowSpanId: string
  /** 迭代子流程当前批次（runSubflowForIterate 填写），随节点事件携带 batchId/itemId。 */
  batch?: { batchId: string; itemId?: string }
  /** 独立生图任务不写入前台视频工作流的进度和错误汇总。 */
  isolated?: boolean
}

const isolatedImageRuns = new Set<TLShapeId>()
const nodeTests = new Set<TLShapeId>()

// L01：renderer 进程唯一的诊断事件生产者。sequence 按生产者递增；
// sessionId/receivedAt/eventId 由 main 入口补齐，这里不伪造会话信息。
const diagnosticsProducer = new DiagnosticsProducer({
  process: 'renderer',
  producerId: newProducerId('renderer')
})

export function canRunImageWhileVideo(editor: Editor): boolean {
  const { phase, currentNodeId } = useEngineStore.getState()
  if (phase !== 'running' || !currentNodeId) return false
  const current = editor.getShape<NodeCardShape>(currentNodeId as TLShapeId)
  return (
    current?.type === 'node-card' &&
    (current.props.nodeType === 'video-depth' || current.props.nodeType === 'video-clay')
  )
}

function reportRunError(
  ctx: WorkflowContext,
  label: string,
  reason: string,
  detail: { nodeId?: string; phase?: 'input' | 'execution' | 'output' }
): void {
  if (!ctx.isolated) useEngineStore.getState().addError(label, reason, detail)
}

/** L01：工作流级结构化事件（开始/唯一终态由调度入口拥有，节点级由执行器拥有）。 */
function emitWorkflowEvent(
  event: string,
  message: string,
  scope: Pick<WorkflowContext, 'traceId' | 'workflowSpanId' | 'runId' | 'projectId'>,
  options: {
    status?: 'success' | 'failed' | 'cancelled'
    attributes?: Record<string, unknown>
  } = {}
): void {
  emitDiagnosticsEvent(
    diagnosticsProducer.build(
      event,
      undefined,
      message,
      {
        traceId: scope.traceId,
        spanId: scope.workflowSpanId,
        runId: scope.runId,
        projectId: scope.projectId
      },
      options
    )
  )
}

function createRunControl(): RunControl {
  return { cancelled: false, paused: false, resumeWaiters: [] }
}

function releasePause(control: RunControl): void {
  const waiters = control.resumeWaiters.splice(0)
  for (const resolve of waiters) resolve()
}

function waitForResume(control: RunControl): Promise<void> {
  if (!control.paused || control.cancelled) return Promise.resolve()
  return new Promise((resolve) => control.resumeWaiters.push(resolve))
}

/** 把一次运行的协作式暂停/继续/停止入口注册到顶栏状态。 */
function registerRunControls(control: RunControl): void {
  const store = useEngineStore.getState()
  store.setStop(() => {
    control.cancelled = true
    control.paused = false
    releasePause(control)
    useEngineStore.getState().setStopping()
  })
  store.setPause(() => {
    if (control.cancelled || control.paused) return
    control.paused = true
    useEngineStore.getState().setPaused()
  })
  store.setResume(() => {
    if (control.cancelled || !control.paused) return
    control.paused = false
    releasePause(control)
    useEngineStore.getState().setRunning()
  })
}

function clearRunControls(): void {
  const store = useEngineStore.getState()
  store.setStop(null)
  store.setPause(null)
  store.setResume(null)
}

/**
 * 右侧「节点测试」使用的临时输入。它们不会写入画布，也不会伪造一条连线；
 * 仍然会经过与工作流完全相同的输入/输出契约校验和节点执行器。
 */
export type NodeTestInputs = Record<string, readonly NodeValue[]>

export interface NodeTestResult {
  status: NodeExecutionResult['status']
  reason?: string
  outputs: ContractOutputs
}

/**
 * 在隔离的 shape 副本上执行一个节点。
 *
 * 用途是让用户在尚未连线时验证一个节点的输入与输出。生成类执行器仍可能创建真实
 * 媒体资产（测试结果可预览），但测试绝不改写原节点 props、运行记录或画布连线。
 * 迭代节点依赖真实下游子流程，因此明确要求在画布中以工作流方式运行。
 */
export async function runNodeTest(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  nodeId: TLShapeId,
  testInputs: NodeTestInputs
): Promise<NodeTestResult> {
  if (useEngineStore.getState().phase !== 'idle' || isolatedImageRuns.size || nodeTests.size)
    return { status: 'skipped', reason: '已有任务正在运行', outputs: {} }
  nodeTests.add(nodeId)
  try {
    const graph = deriveGraph(editor)
    const node = graph.nodes.find((item) => item.id === nodeId)
    const shape = editor.getShape<NodeCardShape>(nodeId)
    const spec = node ? getNodeType(node.type) : null
    if (!node || !shape || !spec?.executor) {
      return { status: 'skipped', reason: '节点不存在或未实现执行器', outputs: {} }
    }
    if (node.type === 'iterate') {
      return { status: 'skipped', reason: '循环节点需要真实下游流程，请在画布中运行', outputs: {} }
    }

    const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const injections: ContractInputInjection[] = Object.entries(testInputs).flatMap(
      ([portId, values]) =>
        values.map((value, index) => ({
          portId,
          packet: {
            type: value.kind,
            value,
            source: { nodeId: '__node_test__', portId: `${portId}.${index + 1}`, runId },
            createdAt: Date.now()
          }
        }))
    )
    const collected = collectContractInputs(node, [], new Map(), { injections })
    if (collected.errors.length > 0) {
      return {
        status: 'failed',
        reason: `输入契约校验失败：${collected.errors.join('；')}`,
        outputs: {}
      }
    }

    let testShape: NodeCardShape = {
      ...shape,
      props: { ...shape.props },
      meta: { ...(shape.meta ?? {}) }
    }
    const token: RunControl = createRunControl()
    const context: NodeExecutionContext = {
      node,
      shape: testShape,
      inputs: collected.value,
      projectId,
      runId,
      providers,
      signal: token,
      gateway: rendererGateway,
      runCode: (source, args) => runCodeTransform(source, args),
      outgoing: graph.edges
        .filter((edge) => edge.from.nodeId === node.id)
        .map((edge) => ({
          nodeId: edge.to.nodeId,
          fromPortId: edge.from.portId,
          toPortId: edge.to.portId
        })),
      updateProps: (patch) => {
        testShape = { ...testShape, props: { ...testShape.props, ...patch } }
      },
      updateResult: (result) => {
        testShape = {
          ...testShape,
          meta: mergeShapeMeta(testShape.meta, { nodeResult: result })
        }
      },
      updateMeta: (patch) => {
        testShape = { ...testShape, meta: mergeShapeMeta(testShape.meta, patch) }
      },
      runSubflow: async () => {
        throw new Error('节点测试不执行下游子流程')
      }
    }
    try {
      const result = await spec.executor(context)
      if (result.status !== 'done') return { ...result, outputs: {} }
      const outputShape: NodeCardShape = {
        ...testShape,
        meta: {
          ...(testShape.meta ?? {}),
          nodeRun: { runId, status: 'success', startedAt: Date.now() }
        }
      }
      const output = buildOutputPackets(node, projectNodeOutputs(outputShape), runId)
      if (output.errors.length > 0) {
        return {
          status: 'failed',
          reason: `输出契约校验失败：${output.errors.join('；')}`,
          outputs: {}
        }
      }
      return { status: 'done', outputs: output.value }
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        outputs: {}
      }
    }
  } finally {
    nodeTests.delete(nodeId)
  }
}

function topoSort(graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }): CanvasNode[] | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]))
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.from.nodeId) || !byId.has(edge.to.nodeId)) continue
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1)
    const next = adjacency.get(edge.from.nodeId) ?? []
    next.push(edge.to.nodeId)
    adjacency.set(edge.from.nodeId, next)
  }
  // 用索引指针代替 queue.shift()：shift 是 O(n) 出队，会让整体复杂度退化到 O(n²)。
  // 用 head 游标在数组上前进，出队变为 O(1)，整体降到 O(V+E)。
  const queue: string[] = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
  const ordered: string[] = []
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    ordered.push(id)
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return ordered.length === graph.nodes.length ? ordered.map((id) => byId.get(id)!) : null
}

/**
 * 展开由 iterate.out-item 标记的循环体。
 *
 * 这是端口语义，而不是节点类型猜测：out-item 的目标是循环体入口；其后由真实
 * 数据连线到达的节点都属于同一次 item 运行。来自同一迭代节点 out-items 的目标
 * 则是循环结束后的汇总消费者，不能被纳入循环体。
 */
function expandIterationBody(
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  rootIds: readonly string[],
  iterationNodeId?: string
): string[] {
  const finalConsumers = new Set(
    iterationNodeId
      ? graph.edges
          .filter(
            (edge) => edge.from.nodeId === iterationNodeId && edge.from.portId === 'out-items'
          )
          .map((edge) => edge.to.nodeId)
      : []
  )
  const included = new Set(rootIds)
  const pending = [...rootIds]
  while (pending.length > 0) {
    const nodeId = pending.pop()!
    for (const edge of graph.edges) {
      if (edge.from.nodeId !== nodeId || finalConsumers.has(edge.to.nodeId)) continue
      if (!included.has(edge.to.nodeId)) {
        included.add(edge.to.nodeId)
        pending.push(edge.to.nodeId)
      }
    }
  }
  const ordered = topoSort(graph) ?? graph.nodes
  return ordered.filter((node) => included.has(node.id)).map((node) => node.id)
}

/** 当前图中会由 iterate.out-item 驱动、因此不能再被主工作流重复执行的节点集合。 */
function iterationBodyNodeIds(graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }): Set<string> {
  const body = new Set<string>()
  const iterateIds = new Set(
    graph.edges.filter((edge) => edge.from.portId === 'out-item').map((edge) => edge.from.nodeId)
  )
  for (const iterationNodeId of iterateIds) {
    const roots = graph.edges
      .filter((edge) => edge.from.nodeId === iterationNodeId && edge.from.portId === 'out-item')
      .map((edge) => edge.to.nodeId)
    for (const nodeId of expandIterationBody(graph, roots, iterationNodeId)) body.add(nodeId)
  }
  return body
}

/**
 * 循环体指纹（R-08）：对循环体内每个节点的 type / 固定配置 / 正文做稳定序列化
 * 哈希。循环体可达性只有 renderer 的图数据算得出来（shared 侧 ctx 不携带循环体
 * 节点），因此只能在这里计算并经 NodeExecutionContext 注入 iterate 执行器，
 * 供 resume 前检测「循环体已修改」；仅用于变更检测，不参与数据拓扑。
 */
function iterationBodyFingerprint(
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  iterationNodeId: string
): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const roots = graph.edges
    .filter((edge) => edge.from.nodeId === iterationNodeId && edge.from.portId === 'out-item')
    .map((edge) => edge.to.nodeId)
  const descriptions = expandIterationBody(graph, roots, iterationNodeId).map((nodeId) => {
    const node = byId.get(nodeId)
    return {
      type: node?.type ?? '',
      config: typeof node?.params.config === 'string' ? node.params.config : '',
      text: node?.content.kind === 'text' ? node.content.text : ''
    }
  })
  // descriptions 的键序固定、节点序来自确定性拓扑排序，JSON.stringify 即稳定。
  let hash = 0x811c9dc5
  for (const char of JSON.stringify(descriptions)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function setExec(editor: Editor, id: TLShapeId, status: ExecStatus): void {
  editor.updateShape({ id, type: 'node-card', props: { exec: status } })
}

/**
 * shape.meta 只能是 JSON 值：tldraw 的 schema 校验会把显式的 `undefined` 整个拒掉
 * （`ValidationError: At shape(type = node-card).meta: Expected json serializable
 * value, got undefined`），而这条更新是运行成功那一刻发出的，于是配音 / 语音克隆
 * 这类「本次没有副产物」的执行会把画布直接炸掉——资产已经落库，卡片却永远不显示。
 * 统一在这里收口：补丁里值为 undefined 或 null 的键按「删除该键」处理，正好对上
 * `updateResult(null)` 文档写的清空语义。
 */
export function mergeShapeMeta(
  current: Record<string, unknown> | NodeMetaPatch | undefined,
  patch: Record<string, unknown> | NodeMetaPatch | undefined
): NodeCardShape['meta'] {
  const next: Record<string, unknown> = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined || value === null) delete next[key]
    else next[key] = value
  }
  return next as NodeCardShape['meta']
}

function writeRunRecord(editor: Editor, id: TLShapeId, record: NodeRunRecord): void {
  const current = editor.getShape<NodeCardShape>(id)
  editor.updateShape({
    id,
    type: 'node-card',
    // tldraw meta 只接受 JSON 值；序列化同时确保审计记录不会带入不可持久化对象。
    meta: { ...(current?.meta ?? {}), nodeRun: JSON.parse(JSON.stringify(record)) }
  })
}

function nodeDiagnosticRedactions(shape: NodeCardShape | undefined): string[] {
  if (!shape) return []
  let config: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(shape.props.config || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>
    }
  } catch {
    // A malformed config should not prevent the actual run from being diagnosed.
  }
  return [
    shape.props.text,
    ...Object.entries(config)
      .filter(([key, value]) => /text|prompt|voice.?id/i.test(key) && typeof value === 'string')
      .map(([, value]) => value as string)
  ].filter((value): value is string => typeof value === 'string' && value.length >= 3)
}

/** 节点终态的稳定错误分类：契约类失败归 INPUT_INVALID，能力缺失归 CAPABILITY_UNAVAILABLE，其余不猜语义留给网关边界。 */
function nodeTerminalError(
  phase: NodeRunPhase | undefined
):
  | { code: 'INPUT_INVALID'; category: 'input'; retryable: false }
  | { code: 'CAPABILITY_UNAVAILABLE'; category: 'capability'; retryable: false }
  | { code: 'UNKNOWN'; category: 'unknown'; retryable: false } {
  if (phase === 'input' || phase === 'output') {
    return { code: 'INPUT_INVALID', category: 'input', retryable: false }
  }
  if (phase === 'capability') {
    return { code: 'CAPABILITY_UNAVAILABLE', category: 'capability', retryable: false }
  }
  return { code: 'UNKNOWN', category: 'unknown', retryable: false }
}

function finishRunRecord(
  ctx: WorkflowContext,
  node: CanvasNode,
  id: TLShapeId,
  record: NodeRunRecord,
  status: Exclude<NodeRunStatus, 'running'>,
  detail: Pick<NodeRunRecord, 'outputPorts' | 'error'> = {}
): void {
  const current = ctx.editor.getShape<NodeCardShape>(id)
  const privateValues = nodeDiagnosticRedactions(current)
  const finishedAt = Date.now()
  const finalRecord: NodeRunRecord = {
    ...record,
    status,
    finishedAt,
    durationMs: finishedAt - record.startedAt,
    ...detail,
    ...(detail.error
      ? {
          error: {
            ...detail.error,
            reason: redactDiagnosticText(detail.error.reason, 500, privateValues)
          }
        }
      : {})
  }
  ctx.editor.updateShape({
    id,
    type: 'node-card',
    meta: {
      ...(current?.meta ?? {}),
      nodeRun: JSON.parse(JSON.stringify(finalRecord)),
      nodeRunHistory: JSON.parse(
        JSON.stringify(appendNodeRunHistory(current?.meta?.nodeRunHistory, finalRecord))
      )
    }
  })
  // L01：唯一终态结构化事件由公共执行器拥有；各功能执行器不重复发终态。
  const terminalEvent =
    status === 'success'
      ? 'node.completed'
      : status === 'failed'
        ? 'node.failed'
        : status === 'cancelled'
          ? 'node.cancelled'
          : 'node.skipped'
  emitDiagnosticsEvent(
    diagnosticsProducer.build(
      terminalEvent,
      undefined,
      status === 'success'
        ? '节点执行完成'
        : status === 'failed'
          ? '节点执行失败'
          : status === 'cancelled'
            ? '节点执行已取消'
            : '节点执行已跳过',
      {
        traceId: ctx.traceId,
        spanId: record.nodeExecutionId,
        parentSpanId: ctx.workflowSpanId,
        runId: record.runId,
        nodeExecutionId: record.nodeExecutionId,
        projectId: ctx.projectId,
        nodeId: node.id,
        nodeType: node.type,
        batchId: ctx.batch?.batchId,
        itemId: ctx.batch?.itemId
      },
      {
        status,
        durationMs: finalRecord.durationMs,
        ...(detail.error ? { normalizedError: nodeTerminalError(detail.error.phase) } : {}),
        ...(status === 'skipped' && detail.error?.reason
          ? { attributes: { reason: detail.error.reason } }
          : {}),
        privateValues
      }
    )
  )
  if (
    status === 'success' &&
    current &&
    current.props.nodeType !== 'image-gen' &&
    record.estimateFeatures
  ) {
    try {
      void window.api.workspace
        .recordGenerationTiming({
          sampleId: `${record.runId}:${id}`,
          operation: current.props.nodeType,
          providerKey: record.estimateProviderKey ?? 'default',
          modelKey: record.estimateModelKey ?? current.props.nodeType,
          ...record.estimateFeatures,
          durationMs: finalRecord.durationMs ?? 0,
          recordedAt: finishedAt
        })
        .catch(() => undefined)
    } catch {
      // Timing telemetry cannot affect a completed node run.
    }
  }
}

/** recordRunTrace 附带的结构化生命周期事件（注册表内事件名）。 */
interface TraceLifecycle {
  name: string
  status?: DiagnosticsStatus
  attributes?: Record<string, unknown>
}

/** 节点级诊断上下文：node span 复用 nodeExecutionId，父 span 为工作流级。 */
function nodeTraceContext(
  ctx: WorkflowContext,
  node: CanvasNode,
  record: NodeRunRecord
): {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  runId?: string
  nodeExecutionId?: string
  projectId?: string
  nodeId?: string
  nodeType?: string
  batchId?: string
  itemId?: string
} {
  return {
    traceId: ctx.traceId,
    spanId: record.nodeExecutionId,
    parentSpanId: ctx.workflowSpanId,
    runId: record.runId,
    nodeExecutionId: record.nodeExecutionId,
    projectId: ctx.projectId,
    nodeId: node.id,
    nodeType: node.type,
    batchId: ctx.batch?.batchId,
    itemId: ctx.batch?.itemId
  }
}

/** Persist every diagnostic event locally and mirror it to electron-log without blocking execution. */
function recordRunTrace(
  ctx: WorkflowContext,
  node: CanvasNode,
  record: NodeRunRecord,
  phase: NodeRunPhase,
  level: 'info' | 'error',
  message: string,
  lifecycle?: TraceLifecycle
): void {
  const safeMessage = redactDiagnosticText(
    message,
    500,
    nodeDiagnosticRedactions(ctx.editor.getShape<NodeCardShape>(node.id as TLShapeId))
  )
  record.trace = appendNodeRunTrace(record, phase, level, safeMessage).trace
  writeRunRecord(ctx.editor, node.id as TLShapeId, record)
  emitDiagnosticsEvent(
    diagnosticsProducer.build(
      lifecycle?.name ?? 'node.stage',
      level,
      safeMessage,
      nodeTraceContext(ctx, node, record),
      {
        ...(lifecycle?.status ? { status: lifecycle.status } : {}),
        ...(lifecycle?.attributes ? { attributes: lifecycle.attributes } : {})
      }
    )
  )
  try {
    const report = typeof window !== 'undefined' ? window.api?.reportNodeRunEvent : undefined
    if (typeof report !== 'function') return
    void report({
      projectId: ctx.projectId,
      nodeId: node.id,
      nodeType: node.type,
      runId: record.runId,
      phase,
      level,
      message: safeMessage
    }).catch(() => undefined)
  } catch {
    // Diagnostics must never interrupt the node execution path.
  }
}

/**
 * 取出节点声明中自注册的执行器并调用。执行器拿到的 NodeExecutionContext 把
 * 写回持久化状态的入口收敛为 updateProps / updateResult，运行器据此读取最新
 * shape 并统一投影输出，避免执行器各自缓存或猜测端口输出。
 */
async function invokeExecutor(
  ctx: WorkflowContext,
  node: CanvasNode,
  shape: NodeCardShape,
  inputs: NodeExecutionContext['inputs'],
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>,
  record: NodeRunRecord
): Promise<NodeExecutionResult> {
  const spec = getNodeType(node.type)
  if (!spec?.executor) return { status: 'failed', reason: `未实现节点类型：${node.type}` }

  const id = shape.id
  const recipeWrites: Array<Promise<boolean>> = []
  let submittedRecipe: { prompt: string; paramsJson: string } | undefined
  const outgoing = ctx.graph.edges
    .filter((e) => e.from.nodeId === node.id)
    .map((e) => ({ nodeId: e.to.nodeId, fromPortId: e.from.portId, toPortId: e.to.portId }))
  const nodeCtx: NodeExecutionContext = {
    node,
    shape,
    inputs,
    projectId: ctx.projectId,
    runId: ctx.runId,
    providers: ctx.providers,
    signal: ctx.token,
    diagnostics: {
      traceId: ctx.traceId,
      nodeExecutionId: record.nodeExecutionId ?? '',
      spanId: record.nodeExecutionId ?? '',
      parentSpanId: ctx.workflowSpanId,
      batchId: ctx.batch?.batchId,
      itemId: ctx.batch?.itemId
    },
    trace: (phase, level, message) => recordRunTrace(ctx, node, record, phase, level, message),
    setDiagnosticTarget: (target) => {
      record.target = target
      writeRunRecord(ctx.editor, id, record)
    },
    gateway: recipeGateway(rendererGateway, (request) => {
      submittedRecipe = request
    }),
    runCode: (source, args) => runCodeTransform(source, args),
    waitForResume: () => waitForResume(ctx.token),
    outgoing,
    updateProps: (patch) => {
      const violation = operationPatchViolation(node.type, patch)
      if (violation) throw new Error(violation)
      ctx.editor.updateShape({ id, type: 'node-card', props: patch })
    },
    updateResult: (result) => {
      const current = ctx.editor.getShape<NodeCardShape>(id)
      ctx.editor.updateShape({
        id,
        type: 'node-card',
        meta: mergeShapeMeta(current?.meta, { nodeResult: result })
      })
    },
    updateMeta: (patch) => {
      const current = ctx.editor.getShape<NodeCardShape>(id)
      ctx.editor.updateShape({
        id,
        type: 'node-card',
        meta: mergeShapeMeta(current?.meta, patch)
      })
    },
    emitArtifact: (artifact) => {
      if (typeof window.api?.saveArtifactRecipe === 'function') {
        recipeWrites.push(
          window.api
            .saveArtifactRecipe({
              projectId: ctx.projectId,
              mediaId: artifact.mediaId,
              runId: record.runId,
              producerNodeId: node.id,
              nodeType: node.type,
              contractVersion: node.contractVersion,
              fullPrompt:
                submittedRecipe?.prompt ??
                (node.content.kind === 'text' ? node.content.text : shape.props.text),
              paramsJson: submittedRecipe?.paramsJson ?? recipeParams(shape.props.config),
              modelKey: record.target?.modelId,
              providerId: record.target?.providerId,
              inputMediaIds: [
                ...new Set(
                  Array.from(inputs.values()).flatMap((packets) =>
                    packets.flatMap((packet) =>
                      'mediaId' in packet.value ? [packet.value.mediaId] : []
                    )
                  )
                )
              ],
              createdAt: Date.now()
            })
            .then(
              (saved) => saved.ok,
              () => false
            )
        )
      }
      const current = ctx.editor.getShape<NodeCardShape>(id) ?? shape
      // 同一次执行中的多个产物需要作为同一个撤销单元落到画布，保持操作可逆。
      ctx.editor.run(() => materializeArtifact(ctx.editor, current, artifact, ctx.runId))
    },
    runSubflow,
    restoreSubflowInputs: (request) => restoreSubflowStaticInputs(ctx, request)
  }
  // 只为循环节点附加循环体指纹：shared 执行器据此在 resume 前拒绝「改了循环体的
  // 续跑」。这里是指纹进入 shared 侧的唯一通道，不做其他逻辑（R-08）。
  if (node.type === 'iterate') {
    const ctxWithFingerprint = nodeCtx as NodeExecutionContext & { bodyFingerprint?: string }
    ctxWithFingerprint.bodyFingerprint = iterationBodyFingerprint(ctx.graph, node.id)
  }
  let outcome: NodeExecutionResult
  try {
    outcome = await spec.executor(nodeCtx)
  } catch (error) {
    await Promise.all(recipeWrites)
    throw error
  }
  if ((await Promise.all(recipeWrites)).some((saved) => !saved))
    throw new Error('生成来源保存失败；素材已保留，请勿重复生成')
  return outcome
}

/**
 * 收集某个节点的输入。非循环体节点只用图上真实连线收集；循环体入口则把
 * iterate.out-item 代表的当前项注入其被连接的具体输入端口。注入也走统一的
 * 契约校验，因此不会再把所有节点强行假定为 in-json。
 */
interface IterationItemInjection {
  item: Record<string, unknown>
  iterationNodeId: string
  targetPortId: string
}

function collectNodeInputs(
  ctx: WorkflowContext,
  node: CanvasNode,
  injection?: IterationItemInjection
): { value: ReturnType<typeof collectContractInputs>['value']; errors: string[] } {
  const spec = getNodeType(node.type)
  if (!spec) return { value: new Map(), errors: [`未知节点类型：${node.type}`] }
  if (!injection) return collectContractInputs(node, ctx.graph.edges, ctx.outputs)
  const controlEdges = ctx.graph.edges.filter(
    (edge) =>
      edge.from.nodeId === injection.iterationNodeId &&
      edge.from.portId === 'out-item' &&
      edge.to.nodeId === node.id &&
      edge.to.portId === injection.targetPortId
  )
  const targetType =
    node.ports.find((port) => port.dir === 'in' && port.id === injection.targetPortId)?.type ??
    getNodeType(node.type)?.ports.in.find((port) => port.id === injection.targetPortId)?.type
  const value = iterationItemValue(injection.item, targetType)
  return collectContractInputs(node, ctx.graph.edges, ctx.outputs, {
    ignoreEdgeIds: controlEdges.map((edge) => edge.id),
    injections: [
      {
        portId: injection.targetPortId,
        packet: {
          type: value.kind,
          value,
          ...(value.kind === 'json' ? { schema: { id: 'json.any', version: 1 } } : {}),
          ...(value.kind === 'camera' ? { schema: { id: 'previs.camera', version: 1 } } : {}),
          source: {
            nodeId: injection.iterationNodeId,
            portId: 'out-item',
            runId: ctx.runId
          },
          createdAt: Date.now()
        }
      }
    ]
  })
}

/**
 * 对单个节点执行一次并登记输出。返回执行状态；失败时不抛错，错误写入 store.errors。
 * 供主工作流循环和循环体子流程共用。
 */
async function executeNodeOnce(
  ctx: WorkflowContext,
  node: CanvasNode,
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>,
  injection?: IterationItemInjection
): Promise<NodeExecutionResult> {
  const { editor } = ctx
  const shapeId = node.id as TLShapeId
  const shape = editor.getShape<NodeCardShape>(shapeId)
  if (!shape) return { status: 'skipped', reason: '节点已不存在' }

  // L01：每次节点调用生成独立执行实例，与根 trace 一起写入运行记录；
  // 同节点重跑与不同迭代项因此不会混淆。
  const record: NodeRunRecord = {
    runId: ctx.runId,
    status: 'running',
    startedAt: Date.now(),
    inputs: {},
    trace: [],
    traceId: ctx.traceId,
    nodeExecutionId: newNodeExecutionId()
  }
  setExec(editor, shapeId, 'running')
  writeRunRecord(editor, shapeId, record)
  recordRunTrace(ctx, node, record, 'input', 'info', '开始收集并校验输入端口', {
    name: 'node.started'
  })
  try {
    const collected = collectNodeInputs(ctx, node, injection)
    record.inputs = inputSources(collected.value)
    record.inputFingerprint = fingerprintNodeInputs(shape, collected.value)
    recordRunTrace(
      ctx,
      node,
      record,
      'input',
      'info',
      `已收集 ${Object.keys(record.inputs).length} 个输入端口`,
      {
        name: 'node.input_validated',
        attributes: { portCount: Object.keys(record.inputs).length }
      }
    )
    if (collected.errors.length > 0) {
      throw new Error(`输入契约校验失败：${collected.errors.join('；')}`)
    }
    try {
      const workload = await captureRunWorkload(shape, collected.value, ctx.projectId)
      record.estimateFeatures = workload.features
      record.estimateProviderKey = workload.providerKey
      record.estimateModelKey = workload.modelKey
      writeRunRecord(editor, shapeId, record)
    } catch {
      // Missing metadata must not stop generation.
    }
    // 本次执行接管该节点的输出；失败或跳过时不能让本轮继续消费上一次结果。
    ctx.outputs.delete(node.id)
    recordRunTrace(ctx, node, record, 'execution', 'info', '开始调用节点执行器')
    const result = await invokeExecutor(ctx, node, shape, collected.value, runSubflow, record)
    const latest = editor.getShape<NodeCardShape>(shapeId)
    if (ctx.token.cancelled) {
      setExec(editor, shapeId, 'cancelled')
      recordRunTrace(ctx, node, record, 'execution', 'info', '运行已取消')
      finishRunRecord(ctx, node, shapeId, record, 'cancelled')
      return { status: 'skipped', reason: '已取消' }
    }
    if (result.status === 'done') {
      if (!latest) throw new Error('节点执行后已不存在')
      // 执行器刚刚把本次产物写入 shape，但 nodeRun 仍处于 running，直到输出契约也
      // 验证完成才会落为 success。输出投影必须读取这次刚完成的产物（特别是结构化
      // 节点的 meta.nodeResult），因此在内存中投影等价的 success 记录；真实记录仍
      // 只会在输出验证成功后写入，失败路径不会泄露任何输出。
      const outputShape = {
        ...latest,
        meta: { ...(latest.meta ?? {}), nodeRun: { ...record, status: 'success' as const } }
      } as unknown as NodeCardShape
      const projected = buildOutputPackets(node, projectNodeOutputs(outputShape), ctx.runId)
      if (projected.errors.length > 0) {
        setExec(editor, shapeId, 'failed')
        reportRunError(
          ctx,
          node.title || node.type,
          `输出契约校验失败：${projected.errors.join('；')}`,
          {
            nodeId: node.id,
            phase: 'output'
          }
        )
        const reason = `输出契约校验失败：${projected.errors.join('；')}`
        recordRunTrace(ctx, node, record, 'output', 'error', reason)
        finishRunRecord(ctx, node, shapeId, record, 'failed', {
          error: { phase: 'output', reason }
        })
        return { status: 'failed', reason: '输出契约校验失败' }
      }
      ctx.outputs.set(node.id, projected.value)
      setExec(editor, shapeId, 'success')
      recordRunTrace(ctx, node, record, 'output', 'info', '输出契约校验通过', {
        name: 'node.output_validated'
      })
      finishRunRecord(ctx, node, shapeId, record, 'success', {
        outputPorts: Object.keys(projected.value)
      })
      return { status: 'done' }
    }
    if (result.status === 'failed') {
      const diagnosticPhase = result.diagnosticPhase ?? 'execution'
      setExec(editor, shapeId, 'failed')
      reportRunError(ctx, node.title || node.type, result.reason ?? '执行失败', {
        nodeId: node.id,
        phase: 'execution'
      })
      recordRunTrace(ctx, node, record, diagnosticPhase, 'error', result.reason ?? '执行失败')
      finishRunRecord(ctx, node, shapeId, record, 'failed', {
        error: { phase: diagnosticPhase, reason: result.reason ?? '执行失败' }
      })
    } else {
      setExec(editor, shapeId, 'idle')
      if (result.reason) {
        recordRunTrace(
          ctx,
          node,
          record,
          result.diagnosticPhase ?? 'execution',
          result.diagnosticPhase ? 'error' : 'info',
          result.reason
        )
      }
      finishRunRecord(ctx, node, shapeId, record, 'skipped', {
        error: result.reason
          ? { phase: result.diagnosticPhase ?? 'execution', reason: result.reason }
          : undefined
      })
    }
    return result
  } catch (error) {
    if (ctx.token.cancelled) {
      setExec(editor, shapeId, 'cancelled')
      recordRunTrace(ctx, node, record, 'execution', 'info', '运行已取消')
      finishRunRecord(ctx, node, shapeId, record, 'cancelled')
    } else {
      const reason = error instanceof Error ? error.message : String(error)
      const phase: 'input' | 'execution' = reason.includes('输入契约') ? 'input' : 'execution'
      setExec(editor, shapeId, 'failed')
      reportRunError(ctx, node.title || node.type, reason, {
        nodeId: node.id,
        phase
      })
      recordRunTrace(ctx, node, record, phase, 'error', reason)
      finishRunRecord(ctx, node, shapeId, record, 'failed', { error: { phase, reason } })
    }
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 每个 item 执行迭代体前重置迭代体节点的「上次运行产物」。
 *
 * 迭代体的下游节点在画布上是单例：生成类节点（生图 / 视频 / 音频）以 mediaPath
 * 作为「已生成则复用」的短路依据；若不清空，item B 会命中 item A 留下的产物
 * 直接 done，不再为本项生成。这里清空媒体引用字段并删除输出登记，强制每项独立
 * 产出。这是迭代语义的内在要求（每项独立处理），不构成节点类型特判：重置与
 * 「复用短路 / 输出登记」相关的通用运行态字段，并恢复循环体首次运行前的正文与
 * 固定配置，对无媒体输出的节点无副作用。
 */
function resetSubflowRunState(ctx: WorkflowContext, nodeIds: string[]): void {
  const updates: Array<{
    id: TLShapeId
    type: 'node-card'
    props?: Partial<NodeCardProps>
    meta?: NodeCardShape['meta']
  }> = []
  for (const nodeId of nodeIds) {
    const shape = ctx.editor.getShape<NodeCardShape>(nodeId as TLShapeId)
    if (!shape) continue
    const baseInputs =
      ctx.subflowBaseInputs.get(nodeId) ??
      ({ text: shape.props.text, config: shape.props.config } satisfies Pick<
        NodeCardProps,
        'text' | 'config'
      >)
    ctx.subflowBaseInputs.set(nodeId, baseInputs)
    // 仅当确实存在上次运行态时才写回，避免无谓的 shape 变更触发保存。
    // meta.nodeResult 同样属于运行态：不清空会让本项失败时仍显示/复用上一项的文本或 JSON。
    const hasMedia = shape.props.mediaId || shape.props.mediaPath || shape.props.mediaMime
    const hasResult = typeof shape.meta?.nodeResult === 'string'
    const restoreInputs =
      shape.props.text !== baseInputs.text || shape.props.config !== baseInputs.config
    if (hasMedia || hasResult || restoreInputs) {
      updates.push({
        id: shape.id,
        type: 'node-card',
        props: {
          ...(restoreInputs ? baseInputs : {}),
          ...(hasMedia ? { mediaId: '', mediaPath: '', mediaMime: '' } : {})
        },
        ...(hasResult ? { meta: mergeShapeMeta(shape.meta, { nodeResult: undefined }) } : {})
      })
    }
    ctx.outputs.delete(nodeId)
  }
  if (updates.length > 0) ctx.editor.updateShapes(updates)
}

/** 循环结束后只恢复用户可编辑的静态输入，不撤销本轮媒体或运行结果。 */
function restoreSubflowStaticInputs(
  ctx: WorkflowContext,
  request: Pick<SubflowRequest, 'nodeIds' | 'iterationNodeId'>
): void {
  const updates: Array<{ id: TLShapeId; type: 'node-card'; props: Partial<NodeCardProps> }> = []
  for (const nodeId of expandIterationBody(ctx.graph, request.nodeIds, request.iterationNodeId)) {
    const base = ctx.subflowBaseInputs.get(nodeId)
    const shape = ctx.editor.getShape<NodeCardShape>(nodeId as TLShapeId)
    if (!base || !shape) continue
    if (shape.props.text !== base.text || shape.props.config !== base.config) {
      updates.push({ id: shape.id, type: 'node-card', props: base })
    }
  }
  if (updates.length > 0) ctx.editor.updateShapes(updates)
}

/**
 * 迭代体子流程执行：从请求里的入口展开循环体真实依赖，并把 item 注入每个入口的
 * 已连接端口。
 * 返回各节点的契约输出。非迭代节点不会调到这里。
 *
 * 与主流程的区别：迭代体是线性链，后续节点依赖前节点；任一节点失败（执行或输出
 * 契约）即中断并抛出错因，由迭代器的 runItem 捕获后按 onFailure 策略处理，避免
 * 错误结构悄悄进入下游、也避免「部分节点成功」被误判为该项成功。
 * 中途取消同样抛错而非返回部分输出：runItem 会把「输出非空」当作该项完成，
 * 残缺产物一旦被标 done，resume 模式会把它当完整结果复用（F08）。
 */
async function runSubflowForIterate(
  ctx: WorkflowContext,
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>,
  request: SubflowRequest
): Promise<Record<string, ContractOutputs>> {
  // 每一项切换到独立 runId。循环体卡片虽然复用，但运行记录和媒体结果不能复用
  // 工作流级 runId，否则 nodeRunHistory 会按相同 runId 去重，资产也无法精确定位。
  // L01：批次关联用稳定 batchId + itemId（有则用），不用数组位置冒充身份。
  const itemCtx: WorkflowContext = {
    ...ctx,
    ...(request.itemRunId ? { runId: request.itemRunId } : {}),
    batch: {
      batchId: `iter-${request.iterationNodeId ?? 'iterate'}-${ctx.runId}`,
      itemId: request.itemId
    }
  }
  const nodeIds = expandIterationBody(ctx.graph, request.nodeIds, request.iterationNodeId)
  // 每个 item 执行迭代体前重置迭代体节点的上次运行产物，强制每项独立产出
  resetSubflowRunState(itemCtx, nodeIds)

  const results: Record<string, ContractOutputs> = {}
  const byId = new Map(itemCtx.graph.nodes.map((n) => [n.id, n]))
  let failureReason: string | null = null
  for (const nodeId of nodeIds) {
    if (itemCtx.token.cancelled) break
    const node = byId.get(nodeId)
    if (!node) continue
    const target = request.itemTargets?.find((candidate) => candidate.nodeId === nodeId)
    const result = await executeNodeOnce(
      itemCtx,
      node,
      runSubflow,
      target
        ? {
            item: request.item,
            iterationNodeId: request.iterationNodeId ?? 'iterate',
            targetPortId: target.portId
          }
        : undefined
    )
    if (itemCtx.token.cancelled) break
    if (result.status === 'failed') {
      failureReason = result.reason ?? '迭代体节点执行失败'
      break
    }
    const latest = itemCtx.editor.getShape<NodeCardShape>(node.id as TLShapeId)
    if (result.status === 'done' && latest) {
      // done 路径下 executeNodeOnce 已校验输出契约；这里防御性再检查，不吞错误
      const projected = buildOutputPackets(node, projectNodeOutputs(latest), itemCtx.runId)
      if (projected.errors.length > 0) {
        failureReason = `迭代体节点 ${node.type} 输出契约失败：${projected.errors.join('；')}`
        break
      }
      results[node.id] = projected.value
    }
  }
  // 取消优先于失败判定：用户意图是停止，该项必须整体作废（resume 时重跑），
  // 绝不能把部分输出当成功结果交回（F08）。
  if (itemCtx.token.cancelled) throw new Error('迭代体执行已取消')
  if (failureReason) throw new Error(failureReason)
  return results
}

/**
 * 正文/资产类节点（outputSource: 'document'）的统一判定：输出即卡片当前内容，
 * 与运行状态无关，重跑也不会产生费用。seed 放行判定（与 nodeValues.projectNodeOutputs
 * 对齐）与子图运行的付费上游计数共用这一谓词，不得各写一套。
 */
function isDocumentOutputNode(nodeType: string): boolean {
  return getNodeType(nodeType)?.outputSource === 'document'
}

/**
 * 以当前卡片的已持久化内容预填输出缓存，供单节点执行读取其真实上游输入。
 * 这不会运行上游节点，也不会猜测节点类型；只使用统一输出投影与端口契约校验。
 */
function seedPersistedOutputs(ctx: WorkflowContext): void {
  for (const node of ctx.graph.nodes) {
    const shape = ctx.editor.getShape<NodeCardShape>(node.id as TLShapeId)
    if (!shape) continue
    // 有运行记录时，仅成功结果可作为手动运行的上游输入，避免失败节点遗留旧值。
    // 例外：正文/资产类节点（outputSource: 'document'）的投影只读卡片当前内容，
    // 与运行状态无关（同一谓词见 nodeValues.projectNodeOutputs），skipped / failed
    // 都不代表卡片内容失效，seeding 必须与投影层同样放行。不加这条例外的后果：
    // 用户在一个空文本节点上误点一次运行，之后它写好的正文就再也连不进下游，
    // 报「上游未产生 out-text 输出」。run 型节点的闸门行为不变。
    const lastRun = readNodeRunRecord(shape.meta?.nodeRun)
    const fromDocument = isDocumentOutputNode(node.type)
    if (lastRun && lastRun.status !== 'success' && !fromDocument) continue
    const projected = buildOutputPackets(node, projectNodeOutputs(shape), ctx.runId)
    if (projected.errors.length === 0 && Object.keys(projected.value).length > 0) {
      ctx.outputs.set(node.id, projected.value)
    }
  }
}

/**
 * 执行单个节点的统一入口。
 *
 * 卡片内“生成”必须经由本函数，而非直接调用网关：它会以当前画布中的真实连线
 * 收集上游端口值，执行同一个节点执行器，并通过同一个输出投影、状态和错误通道收尾。
 */
export async function runNodeManually(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  nodeId: TLShapeId
): Promise<NodeExecutionResult> {
  const store = useEngineStore.getState()
  const isolated =
    store.phase !== 'idle' &&
    canRunImageWhileVideo(editor) &&
    editor.getShape<NodeCardShape>(nodeId)?.props.nodeType === 'image-gen'
  if (store.phase !== 'idle' && !isolated) return { status: 'skipped', reason: '已有任务正在运行' }
  if (nodeTests.size || (store.phase === 'idle' && isolatedImageRuns.size))
    return { status: 'skipped', reason: '已有任务正在运行' }
  if (isolatedImageRuns.has(nodeId)) return { status: 'skipped', reason: '当前生图节点正在运行' }

  const graph = deriveGraph(editor)
  const node = graph.nodes.find((item) => item.id === nodeId)
  if (!node) return { status: 'skipped', reason: '节点不存在或尚未保存到画布' }

  const token = createRunControl()
  if (isolated) isolatedImageRuns.add(nodeId)
  else {
    registerRunControls(token)
    store.beginRun(1)
  }
  const ctx: WorkflowContext = {
    editor,
    projectId,
    providers,
    token,
    graph,
    outputs: new Map<string, ContractOutputs>(),
    subflowBaseInputs: new Map(),
    runId: crypto.randomUUID(),
    traceId: newTraceId(),
    workflowSpanId: newSpanId(),
    isolated
  }
  emitWorkflowEvent('workflow.started', '手动运行单个节点', ctx)
  seedPersistedOutputs(ctx)
  const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
    runSubflowForIterate(ctx, runSubflow, request)

  if (!isolated) store.setCurrent(node.title || node.type, node.id)
  let result: NodeExecutionResult
  try {
    result = await executeNodeOnce(ctx, node, runSubflow)
  } finally {
    if (isolated) isolatedImageRuns.delete(nodeId)
    else {
      store.nodeDone()
      useEngineStore.getState().endRun()
      clearRunControls()
    }
    markUndoPoint(editor, 'node-manual-run')
  }

  if (result.status === 'done') toast(`${node.title || node.type} 已完成`)
  else if (result.status === 'failed') {
    const detail = result.reason?.trim() ?? ''
    toast(`${node.title || node.type} 执行失败${detail ? `：${detail}` : ''}`)
  } else if (result.reason) toast(result.reason)
  emitWorkflowEvent(
    token.cancelled
      ? 'workflow.cancelled'
      : result.status === 'failed'
        ? 'workflow.failed'
        : result.status === 'done'
          ? 'workflow.completed'
          : 'workflow.cancelled',
    result.reason ? `单节点运行结束：${result.status}` : '单节点运行结束',
    ctx,
    {
      status: token.cancelled
        ? 'cancelled'
        : result.status === 'failed'
          ? 'failed'
          : result.status === 'done'
            ? 'success'
            : 'cancelled'
    }
  )
  return result
}

export async function runWorkflow(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[]
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase !== 'idle' || isolatedImageRuns.size > 0 || nodeTests.size > 0) return
  useEngineStore.setState({ phase: 'starting' })
  try {
    const graph = deriveGraph(editor)
    if (graph.nodes.length === 0) return toast('画布上没有节点')
    const order = topoSort(graph)
    if (!order) return toast('工作流存在循环连线，无法执行')

    // T07（F07）：全图运行前明确范围与规模。确认弹窗仅在涉及生成模型时出现——
    // 费用提示是弹窗存在的意义；纯本地转换的画布直接运行，也避免测试环境挂起。
    const planBodies = iterationBodyNodeIds(graph)
    const plan = deriveRunPlan(
      graph.nodes.filter((node) => !planBodies.has(node.id)),
      undefined
    )
    if (plan.willGenerate.length > 0) {
      const proceed = await useConfirmStore.getState().confirm({
        title: '运行整个画布',
        message: formatRunPlan(plan),
        confirmText: '开始运行'
      })
      if (!proceed) return
    }

    const token = createRunControl()
    registerRunControls(token)
    const iterationBodies = iterationBodyNodeIds(graph)
    const executableOrder = order.filter((node) => !iterationBodies.has(node.id))
    store.beginRun(executableOrder.length)
    const ctx: WorkflowContext = {
      editor,
      projectId,
      providers,
      token,
      graph,
      outputs: new Map<string, ContractOutputs>(),
      subflowBaseInputs: new Map(),
      runId: crypto.randomUUID(),
      traceId: newTraceId(),
      workflowSpanId: newSpanId()
    }
    emitWorkflowEvent('workflow.started', '工作流开始执行', ctx, {
      attributes: { itemCount: executableOrder.length }
    })

    const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
      runSubflowForIterate(ctx, runSubflow, request)

    for (const node of executableOrder) {
      await waitForResume(token)
      if (token.cancelled) break
      store.setCurrent(node.title || node.type, node.id)
      await executeNodeOnce(ctx, node, runSubflow)
      store.nodeDone()
    }

    const after = useEngineStore.getState()
    after.endRun()
    clearRunControls()
    if (token.cancelled) {
      toast('工作流已停止')
      emitWorkflowEvent('workflow.cancelled', '工作流已停止', ctx, { status: 'cancelled' })
    } else if (after.errors.length > 0) {
      toast(`工作流完成，${after.errors.length} 个节点失败`)
      emitWorkflowEvent('workflow.failed', '工作流完成，部分节点失败', ctx, {
        status: 'failed',
        attributes: { failedCount: after.errors.length }
      })
    } else {
      toast('工作流执行完成')
      emitWorkflowEvent('workflow.completed', '工作流执行完成', ctx, { status: 'success' })
    }
    markUndoPoint(editor, 'workflow-run')
  } finally {
    useEngineStore.getState().endRun()
    clearRunControls()
  }
}

/**
 * 运行指定目标节点及其全部上游依赖。它通过真实图边求闭包，不会猜测步骤、
 * 不会碰画布中未选中的并行分支；用于框选一段流程后的局部运行。
 */
export async function runWorkflowForNodes(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  targetNodeIds: TLShapeId[]
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase !== 'idle' || isolatedImageRuns.size > 0 || nodeTests.size > 0) return
  useEngineStore.setState({ phase: 'starting' })
  try {
    const fullGraph = deriveGraph(editor)
    const targets = [...new Set(targetNodeIds)].filter((id) =>
      fullGraph.nodes.some((node) => node.id === id)
    )
    if (targets.length === 0) return toast('所选节点不存在或尚未保存到画布')

    const required = new Set<string>(targets)
    const pending: string[] = [...targets]
    while (pending.length > 0) {
      const nodeId = pending.pop()!
      for (const edge of fullGraph.edges) {
        if (edge.to.nodeId === nodeId && !required.has(edge.from.nodeId)) {
          required.add(edge.from.nodeId)
          pending.push(edge.from.nodeId)
        }
      }
    }
    const graph = {
      nodes: fullGraph.nodes.filter((node) => required.has(node.id)),
      edges: fullGraph.edges.filter(
        (edge) => required.has(edge.from.nodeId) && required.has(edge.to.nodeId)
      )
    }
    const order = topoSort(graph)
    if (!order) return toast('所选子图存在循环连线，无法执行')

    const iterationBodies = iterationBodyNodeIds(graph)
    // R-03：子图运行对整条依赖闭包全量重跑，`outputs` 从空 Map 开始，没有任何
    // 「已成功则复用」闸门，跨轮必然重复执行付费生成类上游。这里在 beginRun 之前
    // 把 targets 之外将被重新执行的「运行型」上游节点（非 document/asset 类，
    // 复用 isDocumentOutputNode 判定）数出来；N>0 必须经用户确认，取消则直接
    // 返回，不进入 beginRun。全图 runWorkflow 保持原行为不加闸。
    const targetIds = new Set<string>(targets)
    const nodeById = new Map(fullGraph.nodes.map((node) => [node.id, node]))
    const rerunPaidUpstream = [...required].filter((nodeId) => {
      if (targetIds.has(nodeId)) return false
      // 循环体成员由循环节点逐项驱动，不单独计入，避免与循环节点双重计数。
      if (iterationBodies.has(nodeId)) return false
      const node = nodeById.get(nodeId)
      return node !== undefined && !isDocumentOutputNode(node.type)
    })
    if (rerunPaidUpstream.length > 0) {
      // T07（F07）：确认清单带节点名（最多列 6 个，余量计数），不再只给笼统计数。
      const names = rerunPaidUpstream
        .map((nodeId) => nodeById.get(nodeId)?.title || nodeId.slice(-4))
        .slice(0, 6)
        .map((title) => `「${title}」`)
      const more =
        rerunPaidUpstream.length > names.length ? ` 等 ${rerunPaidUpstream.length} 个节点` : ''
      const proceed = await useConfirmStore.getState().confirm({
        title: '将重新执行上游节点',
        message: `所选流程将一并重新执行 ${names.join('、')}${more}（生成类节点可能产生费用）。是否继续？`,
        confirmText: '继续运行'
      })
      if (!proceed) return
    }

    const token = createRunControl()
    registerRunControls(token)
    const executableOrder = order.filter((node) => !iterationBodies.has(node.id))
    store.beginRun(executableOrder.length)
    const ctx: WorkflowContext = {
      editor,
      projectId,
      providers,
      token,
      graph,
      outputs: new Map<string, ContractOutputs>(),
      subflowBaseInputs: new Map(),
      runId: crypto.randomUUID(),
      traceId: newTraceId(),
      workflowSpanId: newSpanId()
    }
    emitWorkflowEvent('workflow.started', '子图开始执行', ctx, {
      attributes: { itemCount: executableOrder.length }
    })
    const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
      runSubflowForIterate(ctx, runSubflow, request)

    for (const node of executableOrder) {
      await waitForResume(token)
      if (token.cancelled) break
      store.setCurrent(node.title || node.type, node.id)
      await executeNodeOnce(ctx, node, runSubflow)
      store.nodeDone()
    }

    const after = useEngineStore.getState()
    after.endRun()
    clearRunControls()
    if (token.cancelled) {
      toast('子图运行已停止')
      emitWorkflowEvent('workflow.cancelled', '子图运行已停止', ctx, { status: 'cancelled' })
    } else if (after.errors.length > 0) {
      toast(`子图完成，${after.errors.length} 个节点失败`)
      emitWorkflowEvent('workflow.failed', '子图完成，部分节点失败', ctx, {
        status: 'failed',
        attributes: { failedCount: after.errors.length }
      })
    } else {
      toast(`已运行所选流程（${executableOrder.length} 个节点）`)
      emitWorkflowEvent('workflow.completed', '子图执行完成', ctx, {
        status: 'success',
        attributes: { itemCount: executableOrder.length }
      })
    }
    markUndoPoint(editor, 'workflow-run-subgraph')
  } finally {
    useEngineStore.getState().endRun()
    clearRunControls()
  }
}

/** 向后兼容右侧详情面板的“运行至此节点”动作。 */
export async function runWorkflowToNode(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  targetNodeId: TLShapeId
): Promise<void> {
  await runWorkflowForNodes(editor, projectId, providers, [targetNodeId])
}
