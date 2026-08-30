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
import type { NodeCardShape, NodeCardProps } from '../canvas/NodeCardShape'
import { buildOutputPackets, collectContractInputs, type ContractOutputs } from './contracts'
import type { NodeExecutionContext, NodeExecutionResult, SubflowRequest } from './executor-types'
import { getNodeType } from '../nodes/registry'
import { projectNodeOutputs } from '../nodes/nodeValues'
import { toast } from '../stores/toast'
import { useEngineStore } from './store'
import {
  appendNodeRunHistory,
  inputSources,
  readNodeRunRecord,
  type NodeRunRecord,
  type NodeRunStatus
} from './runRecord'

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

function setExec(editor: Editor, id: TLShapeId, status: ExecStatus): void {
  editor.updateShape({ id, type: 'node-card', props: { exec: status } })
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

function finishRunRecord(
  editor: Editor,
  id: TLShapeId,
  record: NodeRunRecord,
  status: Exclude<NodeRunStatus, 'running'>,
  detail: Pick<NodeRunRecord, 'outputPorts' | 'error'> = {}
): void {
  const finishedAt = Date.now()
  const finalRecord: NodeRunRecord = {
    ...record,
    status,
    finishedAt,
    durationMs: finishedAt - record.startedAt,
    ...detail
  }
  const current = editor.getShape<NodeCardShape>(id)
  editor.updateShape({
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
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>
): Promise<NodeExecutionResult> {
  const spec = getNodeType(node.type)
  if (!spec?.executor) return { status: 'failed', reason: `未实现节点类型：${node.type}` }

  const id = shape.id
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
    waitForResume: () => waitForResume(ctx.token),
    outgoing,
    updateProps: (patch) => {
      ctx.editor.updateShape({ id, type: 'node-card', props: patch })
    },
    updateResult: (result) => {
      const current = ctx.editor.getShape<NodeCardShape>(id)
      ctx.editor.updateShape({
        id,
        type: 'node-card',
        meta: {
          ...(current?.meta ?? {}),
          nodeResult: result ?? undefined
        }
      })
    },
    runSubflow,
    restoreSubflowInputs: (request) => restoreSubflowStaticInputs(ctx, request)
  }
  return spec.executor(nodeCtx)
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
  return collectContractInputs(node, ctx.graph.edges, ctx.outputs, {
    ignoreEdgeIds: controlEdges.map((edge) => edge.id),
    injections: [
      {
        portId: injection.targetPortId,
        packet: {
          type: 'json',
          value: { kind: 'json', data: injection.item },
          schema: { id: 'json.any', version: 1 },
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

  const record: NodeRunRecord = {
    runId: ctx.runId,
    status: 'running',
    startedAt: Date.now(),
    inputs: {}
  }
  setExec(editor, shapeId, 'running')
  writeRunRecord(editor, shapeId, record)
  try {
    const collected = collectNodeInputs(ctx, node, injection)
    record.inputs = inputSources(collected.value)
    writeRunRecord(editor, shapeId, record)
    if (collected.errors.length > 0) {
      throw new Error(`输入契约校验失败：${collected.errors.join('；')}`)
    }
    // 本次执行接管该节点的输出；失败或跳过时不能让本轮继续消费上一次结果。
    ctx.outputs.delete(node.id)
    const result = await invokeExecutor(ctx, node, shape, collected.value, runSubflow)
    const latest = editor.getShape<NodeCardShape>(shapeId)
    if (ctx.token.cancelled) {
      setExec(editor, shapeId, 'cancelled')
      finishRunRecord(editor, shapeId, record, 'cancelled')
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
        useEngineStore
          .getState()
          .addError(node.title || node.type, `输出契约校验失败：${projected.errors.join('；')}`, {
            nodeId: node.id,
            phase: 'output'
          })
        finishRunRecord(editor, shapeId, record, 'failed', {
          error: { phase: 'output', reason: `输出契约校验失败：${projected.errors.join('；')}` }
        })
        return { status: 'failed', reason: '输出契约校验失败' }
      }
      ctx.outputs.set(node.id, projected.value)
      setExec(editor, shapeId, 'success')
      finishRunRecord(editor, shapeId, record, 'success', {
        outputPorts: Object.keys(projected.value)
      })
      return { status: 'done' }
    }
    if (result.status === 'failed') {
      setExec(editor, shapeId, 'failed')
      useEngineStore.getState().addError(node.title || node.type, result.reason ?? '执行失败', {
        nodeId: node.id,
        phase: 'execution'
      })
      finishRunRecord(editor, shapeId, record, 'failed', {
        error: { phase: 'execution', reason: result.reason ?? '执行失败' }
      })
    } else {
      setExec(editor, shapeId, 'idle')
      finishRunRecord(editor, shapeId, record, 'skipped', {
        error: result.reason ? { phase: 'execution', reason: result.reason } : undefined
      })
    }
    return result
  } catch (error) {
    if (ctx.token.cancelled) {
      setExec(editor, shapeId, 'cancelled')
      finishRunRecord(editor, shapeId, record, 'cancelled')
    } else {
      const reason = error instanceof Error ? error.message : String(error)
      const phase: 'input' | 'execution' = reason.includes('输入契约') ? 'input' : 'execution'
      setExec(editor, shapeId, 'failed')
      useEngineStore.getState().addError(node.title || node.type, reason, {
        nodeId: node.id,
        phase
      })
      finishRunRecord(editor, shapeId, record, 'failed', { error: { phase, reason } })
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
        ...(hasResult ? { meta: { ...(shape.meta ?? {}), nodeResult: undefined } } : {})
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
 */
async function runSubflowForIterate(
  ctx: WorkflowContext,
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>,
  request: SubflowRequest
): Promise<Record<string, ContractOutputs>> {
  // 每一项切换到独立 runId。循环体卡片虽然复用，但运行记录和媒体结果不能复用
  // 工作流级 runId，否则 nodeRunHistory 会按相同 runId 去重，资产也无法精确定位。
  const itemCtx: WorkflowContext = request.itemRunId ? { ...ctx, runId: request.itemRunId } : ctx
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
  if (failureReason) throw new Error(failureReason)
  return results
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
    const lastRun = readNodeRunRecord(shape.meta?.nodeRun)
    if (lastRun && lastRun.status !== 'success') continue
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
  if (store.phase !== 'idle') return { status: 'skipped', reason: '已有任务正在运行' }

  const graph = deriveGraph(editor)
  const node = graph.nodes.find((item) => item.id === nodeId)
  if (!node) return { status: 'skipped', reason: '节点不存在或尚未保存到画布' }

  const token = createRunControl()
  registerRunControls(token)
  store.beginRun(1)
  const ctx: WorkflowContext = {
    editor,
    projectId,
    providers,
    token,
    graph,
    outputs: new Map<string, ContractOutputs>(),
    subflowBaseInputs: new Map(),
    runId: crypto.randomUUID()
  }
  seedPersistedOutputs(ctx)
  const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
    runSubflowForIterate(ctx, runSubflow, request)

  store.setCurrent(node.title || node.type)
  const result = await executeNodeOnce(ctx, node, runSubflow)
  store.nodeDone()
  useEngineStore.getState().endRun()
  clearRunControls()
  markUndoPoint(editor, 'node-manual-run')

  if (result.status === 'done') toast(`${node.title || node.type} 已完成`)
  else if (result.status === 'failed') toast(`${node.title || node.type} 执行失败`)
  else if (result.reason) toast(result.reason)
  return result
}

export async function runWorkflow(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[]
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase !== 'idle') return
  const graph = deriveGraph(editor)
  if (graph.nodes.length === 0) return toast('画布上没有节点')
  const order = topoSort(graph)
  if (!order) return toast('工作流存在循环连线，无法执行')

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
    runId: crypto.randomUUID()
  }

  const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
    runSubflowForIterate(ctx, runSubflow, request)

  for (const node of executableOrder) {
    await waitForResume(token)
    if (token.cancelled) break
    store.setCurrent(node.title || node.type)
    await executeNodeOnce(ctx, node, runSubflow)
    store.nodeDone()
  }

  const after = useEngineStore.getState()
  after.endRun()
  clearRunControls()
  if (token.cancelled) toast('工作流已停止')
  else if (after.errors.length > 0) toast(`工作流完成，${after.errors.length} 个节点失败`)
  else toast('工作流执行完成')
  markUndoPoint(editor, 'workflow-run')
}

/**
 * 运行选中节点及其全部上游依赖。它通过图边求闭包，而不是按节点类型猜测步骤；
 * 因而每一条执行路径仍可由 portId 和 nodeRun.inputs 回溯。
 */
export async function runWorkflowToNode(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  targetNodeId: TLShapeId
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase !== 'idle') return
  const fullGraph = deriveGraph(editor)
  if (!fullGraph.nodes.some((node) => node.id === targetNodeId)) return toast('目标节点不存在')

  const required = new Set<string>([targetNodeId])
  const pending: string[] = [targetNodeId]
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
    runId: crypto.randomUUID()
  }
  const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
    runSubflowForIterate(ctx, runSubflow, request)

  for (const node of executableOrder) {
    await waitForResume(token)
    if (token.cancelled) break
    store.setCurrent(node.title || node.type)
    await executeNodeOnce(ctx, node, runSubflow)
    store.nodeDone()
  }

  const after = useEngineStore.getState()
  after.endRun()
  clearRunControls()
  if (token.cancelled) toast('子图运行已停止')
  else if (after.errors.length > 0) toast(`子图完成，${after.errors.length} 个节点失败`)
  else toast(`已运行 ${executableOrder.length} 个节点至目标节点`)
  markUndoPoint(editor, 'workflow-run-subgraph')
}
