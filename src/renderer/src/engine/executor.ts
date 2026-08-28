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
import type { CanvasEdge, CanvasNode, ExecStatus, ProviderConfig } from '@shared/types'
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

interface CancelToken {
  cancelled: boolean
}

interface WorkflowContext {
  editor: Editor
  projectId: string
  providers: ProviderConfig[]
  token: CancelToken
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }
  /** 运行期累积的输出登记：nodeId -> 端口输出数据包。 */
  outputs: Map<string, ContractOutputs>
  runId: string
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
  // 直接下游节点 id（循环体识别用）：从图边推导以本节点为起点的输出边目标。
  const downstream = ctx.graph.edges
    .filter((e) => e.from.nodeId === node.id)
    .map((e) => e.to.nodeId)
  const nodeCtx: NodeExecutionContext = {
    node,
    shape,
    inputs,
    projectId: ctx.projectId,
    providers: ctx.providers,
    signal: ctx.token,
    downstream,
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
    runSubflow
  }
  return spec.executor(nodeCtx)
}

/**
 * 收集某个节点的输入。非循环体节点用图上连边收集；循环体首节点会把 runSubflow
 * 请求里的 item 以 in-json 注入（供批处理模板读取当前项）。
 */
function collectNodeInputs(
  ctx: WorkflowContext,
  node: CanvasNode,
  item?: Record<string, unknown>
): { value: ReturnType<typeof collectContractInputs>['value']; errors: string[] } {
  const spec = getNodeType(node.type)
  if (!spec) return { value: new Map(), errors: [`未知节点类型：${node.type}`] }
  // 循环体首节点：item 作为 in-json 输入（若有该端口）
  const hasJsonPort =
    node.ports.length > 0
      ? node.ports.some((p) => p.dir === 'in' && p.id === 'in-json')
      : spec.ports.in.some((p) => p.id === 'in-json')
  if (item && hasJsonPort) {
    const inputs = new Map([
      [
        'in-json',
        [
          {
            type: 'json' as const,
            value: { kind: 'json' as const, data: item },
            source: { nodeId: 'iterate', portId: 'out-items', runId: ctx.runId },
            createdAt: Date.now()
          }
        ]
      ]
    ])
    return { value: inputs, errors: [] }
  }
  const collected = collectContractInputs(node, ctx.graph.edges, ctx.outputs)
  return collected
}

/**
 * 对单个节点执行一次并登记输出。返回执行状态；失败时不抛错，错误写入 store.errors。
 * 供主工作流循环和循环体子流程共用。
 */
async function executeNodeOnce(
  ctx: WorkflowContext,
  node: CanvasNode,
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>,
  item?: Record<string, unknown>
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
    const collected = collectNodeInputs(ctx, node, item)
    record.inputs = inputSources(collected.value)
    writeRunRecord(editor, shapeId, record)
    if (collected.errors.length > 0) {
      throw new Error(`输入契约校验失败：${collected.errors.join('；')}`)
    }
    const result = await invokeExecutor(ctx, node, shape, collected.value, runSubflow)
    const latest = editor.getShape<NodeCardShape>(shapeId)
    if (ctx.token.cancelled) {
      setExec(editor, shapeId, 'cancelled')
      finishRunRecord(editor, shapeId, record, 'cancelled')
      return { status: 'skipped', reason: '已取消' }
    }
    if (result.status === 'done') {
      if (!latest) throw new Error('节点执行后已不存在')
      const projected = buildOutputPackets(node, projectNodeOutputs(latest), ctx.runId)
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
 * 产出。这是迭代语义的内在要求（每项独立处理），不构成节点类型特判：只重置与
 * 「复用短路 / 输出登记」相关的通用运行态字段，对无媒体输出的节点无副作用。
 */
function resetSubflowRunState(ctx: WorkflowContext, nodeIds: string[]): void {
  const updates: Array<{
    id: TLShapeId
    type: 'node-card'
    props: Partial<NodeCardProps>
  }> = []
  for (const nodeId of nodeIds) {
    const shape = ctx.editor.getShape<NodeCardShape>(nodeId as TLShapeId)
    if (!shape) continue
    // 仅当确实存在上次产物时才写回，避免无谓的 shape 变更触发保存
    if (shape.props.mediaId || shape.props.mediaPath || shape.props.mediaMime) {
      updates.push({
        id: shape.id,
        type: 'node-card',
        props: { mediaId: '', mediaPath: '', mediaMime: '' }
      })
    }
    ctx.outputs.delete(nodeId)
  }
  if (updates.length > 0) ctx.editor.updateShapes(updates)
}

/**
 * 迭代体子流程执行：对请求里的迭代体节点链（nodeIds）执行一次，把 item 注入首节点。
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
  // 每个 item 执行迭代体前重置迭代体节点的上次运行产物，强制每项独立产出
  resetSubflowRunState(ctx, request.nodeIds)

  const results: Record<string, ContractOutputs> = {}
  const byId = new Map(ctx.graph.nodes.map((n) => [n.id, n]))
  let index = 0
  let failureReason: string | null = null
  for (const nodeId of request.nodeIds) {
    if (ctx.token.cancelled) break
    const node = byId.get(nodeId)
    if (!node) continue
    // 首节点注入当前 item；后续节点用正常图连边收集（此时 outputs 已包含首节点输出）
    const itemForNode = index === 0 ? (request.item ?? {}) : undefined
    const result = await executeNodeOnce(ctx, node, runSubflow, itemForNode)
    if (ctx.token.cancelled) break
    if (result.status === 'failed') {
      failureReason = result.reason ?? '迭代体节点执行失败'
      break
    }
    const latest = ctx.editor.getShape<NodeCardShape>(node.id as TLShapeId)
    if (result.status === 'done' && latest) {
      // done 路径下 executeNodeOnce 已校验输出契约；这里防御性再检查，不吞错误
      const projected = buildOutputPackets(node, projectNodeOutputs(latest), ctx.runId)
      if (projected.errors.length > 0) {
        failureReason = `迭代体节点 ${node.type} 输出契约失败：${projected.errors.join('；')}`
        break
      }
      results[node.id] = projected.value
    }
    index += 1
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
  providers: ProviderConfig[],
  nodeId: TLShapeId
): Promise<NodeExecutionResult> {
  const store = useEngineStore.getState()
  if (store.phase === 'running') return { status: 'skipped', reason: '已有任务正在运行' }

  const graph = deriveGraph(editor)
  const node = graph.nodes.find((item) => item.id === nodeId)
  if (!node) return { status: 'skipped', reason: '节点不存在或尚未保存到画布' }

  const token: CancelToken = { cancelled: false }
  useEngineStore.getState().setStop(() => {
    token.cancelled = true
    useEngineStore.getState().setStopping()
  })
  store.beginRun(1)
  const ctx: WorkflowContext = {
    editor,
    projectId,
    providers,
    token,
    graph,
    outputs: new Map<string, ContractOutputs>(),
    runId: crypto.randomUUID()
  }
  seedPersistedOutputs(ctx)
  const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
    runSubflowForIterate(ctx, runSubflow, request)

  store.setCurrent(node.title || node.type)
  const result = await executeNodeOnce(ctx, node, runSubflow)
  store.nodeDone()
  useEngineStore.getState().endRun()
  useEngineStore.getState().setStop(null)
  markUndoPoint(editor, 'node-manual-run')

  if (result.status === 'done') toast(`${node.title || node.type} 已完成`)
  else if (result.status === 'failed') toast(`${node.title || node.type} 执行失败`)
  else if (result.reason) toast(result.reason)
  return result
}

export async function runWorkflow(
  editor: Editor,
  projectId: string,
  providers: ProviderConfig[]
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase === 'running') return
  const graph = deriveGraph(editor)
  if (graph.nodes.length === 0) return toast('画布上没有节点')
  const order = topoSort(graph)
  if (!order) return toast('工作流存在循环连线，无法执行')

  const token: CancelToken = { cancelled: false }
  useEngineStore.getState().setStop(() => {
    token.cancelled = true
    useEngineStore.getState().setStopping()
  })
  store.beginRun(order.length)
  const ctx: WorkflowContext = {
    editor,
    projectId,
    providers,
    token,
    graph,
    outputs: new Map<string, ContractOutputs>(),
    runId: crypto.randomUUID()
  }

  const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
    runSubflowForIterate(ctx, runSubflow, request)

  for (const node of order) {
    if (token.cancelled) break
    store.setCurrent(node.title || node.type)
    await executeNodeOnce(ctx, node, runSubflow)
    store.nodeDone()
  }

  const after = useEngineStore.getState()
  after.endRun()
  after.setStop(null)
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
  providers: ProviderConfig[],
  targetNodeId: TLShapeId
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase === 'running') return
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

  const token: CancelToken = { cancelled: false }
  useEngineStore.getState().setStop(() => {
    token.cancelled = true
    useEngineStore.getState().setStopping()
  })
  store.beginRun(order.length)
  const ctx: WorkflowContext = {
    editor,
    projectId,
    providers,
    token,
    graph,
    outputs: new Map<string, ContractOutputs>(),
    runId: crypto.randomUUID()
  }
  const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
    runSubflowForIterate(ctx, runSubflow, request)

  for (const node of order) {
    if (token.cancelled) break
    store.setCurrent(node.title || node.type)
    await executeNodeOnce(ctx, node, runSubflow)
    store.nodeDone()
  }

  const after = useEngineStore.getState()
  after.endRun()
  after.setStop(null)
  if (token.cancelled) toast('子图运行已停止')
  else if (after.errors.length > 0) toast(`子图完成，${after.errors.length} 个节点失败`)
  else toast(`已运行 ${order.length} 个节点至目标节点`)
  markUndoPoint(editor, 'workflow-run-subgraph')
}
